using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

static class CaptureEndpoints
{
    const int BrowserPort = 47633;
    const int MaxBody = 8 * 1024 * 1024;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    record Input(string? Title, string? Url, string? Html, int Omitted, string? Favicon = null);
        record Capture(string Id, string Title, string Url, DateTimeOffset Created, int Omitted, string Markdown, string Python, string? Favicon = null);

    static bool IsSafeVideoQuery(Uri url) =>
        (url.Host.Equals("youtube.com", StringComparison.OrdinalIgnoreCase) || url.Host.Equals("www.youtube.com", StringComparison.OrdinalIgnoreCase) || url.Host.Equals("m.youtube.com", StringComparison.OrdinalIgnoreCase))
        && url.AbsolutePath == "/watch"
        && System.Text.RegularExpressions.Regex.IsMatch(url.Query, @"^\?v=[A-Za-z0-9_-]{11}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static void MapCaptures(this WebApplication app, string root)
    {
        var captureRoot = Path.Combine(root, ".local", "data", "captures");
        var browserFolder = Path.Combine(root, "browser-extension");
        Directory.CreateDirectory(captureRoot);
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(browserFolder, "manifest.json")));
        var key = Convert.FromBase64String(manifest.RootElement.GetProperty("key").GetString()!);
        var hash = SHA256.HashData(key);
        var extensionId = string.Concat(hash.Take(16).SelectMany(b => new[] { (char)('a' + (b >> 4)), (char)('a' + (b & 15)) }));
        var extensionOrigin = "chrome-extension://" + extensionId;
        using var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(browserFolder, "config.json")));
        var capability = System.Text.Encoding.UTF8.GetBytes(config.RootElement.GetProperty("capability").GetString()!);

        bool IsOwnPage(HttpContext context)
        {
            var origin = context.Request.Headers.Origin.ToString();
            var local = $"http://{context.Request.Host}";
            return context.Connection.LocalPort != BrowserPort && app.Urls.Contains(local)
                && (origin == local || (origin.Length == 0 && context.Request.Headers["Sec-Fetch-Site"] == "same-origin"));
        }
        bool IsExtension(HttpContext context) => context.Connection.LocalPort == BrowserPort
            && context.Request.Headers.Origin == extensionOrigin;

        app.MapMethods("/api/browser-capture", ["OPTIONS", "POST"], async (HttpContext context) =>
        {
            if (!IsExtension(context)) return Results.StatusCode(403);
            context.Response.Headers.AccessControlAllowOrigin = extensionOrigin;
            context.Response.Headers.Vary = "Origin";
            if (HttpMethods.IsOptions(context.Request.Method))
            {
                context.Response.Headers.AccessControlAllowMethods = "POST";
                context.Response.Headers.AccessControlAllowHeaders = "content-type, x-mona-capability";
                context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
                return Results.NoContent();
            }
            var supplied = System.Text.Encoding.UTF8.GetBytes(context.Request.Headers["X-Mona-Capability"].ToString());
            if (!CryptographicOperations.FixedTimeEquals(supplied, capability)) return Results.StatusCode(403);
            if (!context.Request.HasJsonContentType() || context.Request.ContentLength is > MaxBody)
                return Results.Json(new { error = "Page is too large or not JSON." }, statusCode: 413);
            using var buffer = new MemoryStream();
            var chunk = new byte[16384];
            int read;
            while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
            {
                if (buffer.Length + read > MaxBody) return Results.Json(new { error = "Page exceeds the 8 MB capture limit." }, statusCode: 413);
                await buffer.WriteAsync(chunk.AsMemory(0, read), context.RequestAborted);
            }
            Input? input;
            try { input = JsonSerializer.Deserialize<Input>(buffer.ToArray(), Json); }
            catch (JsonException) { return Results.Json(new { error = "Invalid capture." }, statusCode: 400); }
            if (input?.Html is null || input.Html.Length == 0 || input.Title is null || input.Title.Length > 1000 || input.Url is null || !Uri.TryCreate(input.Url, UriKind.Absolute, out var url) || (url.Scheme != "http" && url.Scheme != "https") || url.UserInfo.Length > 0 || url.Fragment.Length > 0 || (url.Query.Length > 0 && !IsSafeVideoQuery(url)))
                return Results.Json(new { error = "Invalid page data." }, statusCode: 400);
            var id = Guid.NewGuid().ToString("N");
            var folder = Path.Combine(captureRoot, id);
            Directory.CreateDirectory(folder);
            var source = Path.Combine(folder, "source.html");
            await File.WriteAllTextAsync(source, input.Html);
            try
            {
                var python = Path.Combine(root, ".local", "python-runtime", "python.exe");
                var work = Path.Combine(root, ".local", "python-work");
                Directory.CreateDirectory(work);
                var start = new ProcessStartInfo(python) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8, CreateNoWindow = true, WorkingDirectory = work };
                start.ArgumentList.Add("-I"); start.ArgumentList.Add("-B"); start.ArgumentList.Add("-X"); start.ArgumentList.Add("utf8"); start.ArgumentList.Add(Path.Combine(root, "canvas", "convert_capture.py")); start.ArgumentList.Add(source); start.ArgumentList.Add(input.Url);
                foreach (var name in new[] { "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA" }) start.Environment[name] = work;
                start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
                using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start bundled Python.");
                var outputTask = process.StandardOutput.ReadToEndAsync();
                var errorTask = process.StandardError.ReadToEndAsync();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
                try { await process.WaitForExitAsync(timeout.Token); }
                catch (OperationCanceledException) { process.Kill(true); await process.WaitForExitAsync(); throw new TimeoutException("Conversion timed out."); }
                var output = await outputTask;
                var error = await errorTask;
                if (process.ExitCode != 0) throw new InvalidOperationException("Conversion failed: " + error[..Math.Min(error.Length, 1000)]);
                using var converted = JsonDocument.Parse(output);
                var actualPython = converted.RootElement.GetProperty("python").GetString()!;
                if (!Path.GetFullPath(actualPython).Equals(Path.GetFullPath(python), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unexpected Python executable.");
                var markdown = converted.RootElement.GetProperty("markdown").GetString() ?? "";
                string? faviconPath = null;
                if (input.Favicon is { Length: < 50000 } icon && icon.StartsWith("data:image/png;base64,")) {
                    try {
                        var bytes = Convert.FromBase64String(icon[22..]);
                        if (bytes.Length >= 8 && bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) {
                            var icons = Path.Combine(root, ".local", "data", "favicons");
                            Directory.CreateDirectory(icons);
                            await File.WriteAllBytesAsync(Path.Combine(icons, id + ".png"), bytes);
                            faviconPath = $"api/favicons/{id}";
                        }
                    } catch (FormatException) { }
                }
                var capture = new Capture(id, input.Title, input.Url, DateTimeOffset.UtcNow, input.Omitted, markdown, actualPython, faviconPath);
                await File.WriteAllTextAsync(Path.Combine(folder, "note.md"), markdown);
                await File.WriteAllTextAsync(Path.Combine(folder, "capture.json"), JsonSerializer.Serialize(capture, Json));
                return Results.Json(new { id });
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or TimeoutException or System.ComponentModel.Win32Exception or JsonException)
            {
                await File.WriteAllTextAsync(Path.Combine(folder, "error.txt"), e.Message);
                return Results.Json(new { error = "Conversion failed. The source HTML was saved; see the capture folder for details." }, statusCode: 500);
            }
        });
        app.MapGet("/api/favicons/{id}", (HttpContext context, string id) => {
            if (!Guid.TryParseExact(id, "N", out var parsed) || context.Connection.LocalPort == BrowserPort) return Results.NotFound();
            var file = Path.Combine(root, ".local", "data", "favicons", parsed.ToString("N") + ".png");
            context.Response.Headers.XContentTypeOptions = "nosniff";
            return File.Exists(file) ? Results.File(file, "image/png") : Results.NotFound();
        });
        app.MapGet("/api/captures", async (HttpContext context) =>
        {
            if (!IsOwnPage(context)) return Results.StatusCode(403);
            var captures = new List<Capture>();
            foreach (var file in Directory.EnumerateFiles(captureRoot, "capture.json", SearchOption.AllDirectories))
            {
                try { if (File.Exists(Path.Combine(Path.GetDirectoryName(file)!, ".hidden"))) continue; var item = JsonSerializer.Deserialize<Capture>(await File.ReadAllTextAsync(file), Json); if (item is not null) captures.Add(item); }
                catch (Exception e) when (e is IOException or JsonException) { }
            }
            return Results.Json(captures.OrderByDescending(c => c.Created));
        });
        app.MapPost("/api/captures/{id}/hide", async (HttpContext context, string id) =>
        {
            if (!IsOwnPage(context)) return Results.StatusCode(403);
            if (!Guid.TryParseExact(id, "N", out var parsed)) return Results.NotFound();
            var folder = Path.Combine(captureRoot, parsed.ToString("N"));
            if (!File.Exists(Path.Combine(folder, "capture.json"))) return Results.NotFound();
            await File.WriteAllTextAsync(Path.Combine(folder, ".hidden"), "Removed from the capture list; original files are preserved.");
            return Results.Ok();
        });
        app.MapPost("/api/open-browser-extension", (HttpContext context) =>
        {
            if (!IsOwnPage(context) || !OperatingSystem.IsWindows()) return Results.StatusCode(403);
            Process.Start(new ProcessStartInfo("explorer.exe") { UseShellExecute = true, ArgumentList = { root } });
            return Results.Ok();
        });
    }
}
