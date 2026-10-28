using Microsoft.AspNetCore.StaticFiles;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text.Json;

var portText = Environment.GetEnvironmentVariable("MONA_PORT") ?? "51795";
if (!int.TryParse(portText, out var port) || port is < 0 or > 65535)
    throw new InvalidOperationException("MONA_PORT must be between 0 and 65535 (0 selects a free port).");

var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
    WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
});
var extensionRoot = Environment.GetEnvironmentVariable("MONA_EXTENSION_ROOT");
if (string.IsNullOrWhiteSpace(extensionRoot) && Environment.ProcessPath is string executable)
{
    var candidate = Directory.GetParent(Path.GetDirectoryName(executable)!)?.FullName;
    if (candidate is not null && File.Exists(Path.Combine(candidate, "browser-extension", "manifest.json"))) extensionRoot = candidate;
}
if (string.IsNullOrWhiteSpace(extensionRoot))
    builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
else
    builder.WebHost.UseUrls($"http://127.0.0.1:{port}", "http://127.0.0.1:47633");

var app = builder.Build();

if (!string.IsNullOrWhiteSpace(extensionRoot)) app.MapCaptures(extensionRoot);
var contentTypes = new FileExtensionContentTypeProvider();
contentTypes.Mappings[".dat"] = "application/octet-stream";
var assembly = Assembly.GetExecutingAssembly();
var bundledAssets = assembly.GetManifestResourceNames()
    .Where(name => name.StartsWith("web/", StringComparison.Ordinal))
    .ToDictionary(name => name[4..].Replace('\\', '/'), name => name, StringComparer.Ordinal);
if (bundledAssets.Count == 0)
{
    app.UseDefaultFiles();
    app.UseStaticFiles(new StaticFileOptions
    {
        ContentTypeProvider = contentTypes,
        OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-store"
    });
}
else
{
    app.MapMethods("/{**path}", ["GET", "HEAD"], (HttpContext context, string? path) =>
    {
        var asset = string.IsNullOrEmpty(path) || path is "sources" or "captures" ? "index.html" : path;
        if (!bundledAssets.TryGetValue(asset, out var resource)) return Results.NotFound();
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        if (!contentTypes.TryGetContentType(asset, out var type)) type = "application/octet-stream";
        if (HttpMethods.IsHead(context.Request.Method))
        {
            context.Response.ContentType = type;
            return Results.Ok();
        }
        return Results.Stream(assembly.GetManifestResourceStream(resource)!, type);
    });
}
app.MapGet("/health", () => Results.Json(new { application = "monas-mind", hosting = "release", bundledAssets = bundledAssets.Count }));
app.MapGet("/api/system-metrics", async (HttpContext context) =>
{
    var origin = context.Request.Headers.Origin.ToString();
    var ownOrigin = $"http://{context.Request.Host}";
    var sameOriginFetch = string.IsNullOrEmpty(origin)
        && context.Request.Headers["Sec-Fetch-Site"] == "same-origin";
    if (!sameOriginFetch
        && !(origin == ownOrigin && app.Urls.Contains(ownOrigin)))
        return Results.StatusCode(403);
    if (!string.IsNullOrEmpty(origin)) context.Response.Headers.AccessControlAllowOrigin = origin;
    context.Response.Headers.CacheControl = "no-store";
    var metrics = WindowsMetrics.Read();
    var gpu = await WindowsMetrics.ReadGpu();
    return Results.Json(new { metrics.SystemCpuPercent, metrics.SystemMemoryUsedBytes, metrics.SystemMemoryTotalBytes, gpuPercent = gpu });
});
using var rendererMetrics = new RendererMetrics();
app.MapGet("/api/renderer-metrics", (HttpContext context) =>
{
    var origin = context.Request.Headers.Origin.ToString();
    var ownOrigin = $"http://{context.Request.Host}";
    var sameOrigin = string.IsNullOrEmpty(origin) && context.Request.Headers["Sec-Fetch-Site"] == "same-origin";
    if (!sameOrigin && !(origin == ownOrigin && app.Urls.Contains(ownOrigin))) return Results.StatusCode(403);
    context.Response.Headers.CacheControl = "no-store";
    return Results.Json(rendererMetrics.Read(context.Connection.LocalPort, context.Connection.RemotePort));
});
await app.StartAsync();
Console.WriteLine("MONA_READY " + JsonSerializer.Serialize(new { url = app.Urls.Single(url => url != "http://127.0.0.1:47633") }));
await app.WaitForShutdownAsync();

static class WindowsMetrics
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, MemoryLoad;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    private static readonly object Sync = new();
    private static long previousIdle, previousTotal;

    public record Snapshot(double? SystemCpuPercent, ulong? SystemMemoryUsedBytes, ulong? SystemMemoryTotalBytes);

    public static async Task<double?> ReadGpu()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nvidia-smi.exe");
        if (!File.Exists(executable)) return null;
        try
        {
            using var process = Process.Start(new ProcessStartInfo(executable, "--query-gpu=utilization.gpu --format=csv,noheader,nounits")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true
            });
            if (process is null) return null;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { process.Kill(); await process.WaitForExitAsync(); return null; }
            var text = await output;
            await errors;
            return process.ExitCode == 0 && double.TryParse(text.Split('\n')[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                ? Math.Clamp(value, 0, 100) : null;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or InvalidOperationException or OperationCanceledException) { return null; }
    }

    public static Snapshot Read()
    {
        lock (Sync)
        {
            var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
            ulong? total = null, used = null;
            double? cpu = null;
            if (OperatingSystem.IsWindows() && GlobalMemoryStatusEx(ref memory))
            {
                total = memory.TotalPhysical;
                used = memory.TotalPhysical - memory.AvailablePhysical;
            }
            if (OperatingSystem.IsWindows() && GetSystemTimes(out var idle, out var kernel, out var user))
            {
                var all = kernel + user;
                var delta = all - previousTotal;
                if (previousTotal != 0 && delta > 0)
                    cpu = Math.Clamp(100.0 * (1.0 - (double)(idle - previousIdle) / delta), 0, 100);
                previousIdle = idle;
                previousTotal = all;
            }
            return new Snapshot(cpu, used, total);
        }
    }
}
