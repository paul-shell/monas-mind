using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

sealed class RendererMetrics : IDisposable
{
    private readonly object sync = new();
    private readonly Dictionary<int, (long Started, double Cpu, long At)> samples = new();
    private GpuCounters? gpu;
    private int gpuPid;
    private object? lastSnapshot;
    public object? LastSnapshot { get { lock (sync) return lastSnapshot; } }

    public object Read(int localPort, int remotePort)
    {
        lock (sync)
        {
            try
            {
                var networkPid = Native.ClientProcess(localPort, remotePort);
                var processes = Native.Processes();
                if (!processes.TryGetValue(networkPid, out var network) || network.Name != "msedgewebview2.exe")
                    return new { available = false, reason = "Waiting for this WebView connection" };
                var browserPid = network.Parent;
                if (!processes.TryGetValue(browserPid, out var browser) || browser.Name != "msedgewebview2.exe")
                    return new { available = false, reason = "WebView browser identity unavailable" };
                var browserCommand = Native.CommandLine(browserPid);
                var profileMatch = Regex.Match(browserCommand, "--user-data-dir=(?:\"([^\"]+)\"|([^ ]+))");
                var profile = profileMatch.Groups[1].Success ? profileMatch.Groups[1].Value : profileMatch.Groups[2].Value;
                if (!profileMatch.Success || !profile.Contains("github-app-extension-canvas-", StringComparison.OrdinalIgnoreCase)
                    || !processes.TryGetValue(browser.Parent, out var owner) || owner.Name != "github.exe")
                    return new { available = false, reason = "Dedicated Copilot canvas profile not verified" };
                var children = processes.Where(p => p.Value.Parent == browserPid && p.Value.Name == "msedgewebview2.exe")
                    .Select(p => (Pid: p.Key, Command: Native.CommandLine(p.Key))).ToArray();
                var renderers = children.Where(p => p.Command.Contains("--type=renderer", StringComparison.Ordinal)).ToArray();
                var workers = children.Where(p => p.Command.Contains("--type=gpu-process", StringComparison.Ordinal)).ToArray();
                if (renderers.Length != 1 || workers.Length != 1
                    || !renderers[0].Command.Contains(profile, StringComparison.OrdinalIgnoreCase)
                    || !workers[0].Command.Contains(profile, StringComparison.OrdinalIgnoreCase))
                    return new { available = false, reason = "WebView does not have one unambiguous renderer and GPU worker" };
                var renderer = ProcessSnapshot(renderers[0].Pid);
                var worker = ProcessSnapshot(workers[0].Pid);
                if (gpu is null || gpuPid != workers[0].Pid)
                {
                    gpu?.Dispose();
                    gpuPid = workers[0].Pid;
                    gpu = new GpuCounters(gpuPid);
                }
                lastSnapshot = new { available = true, sampledAt = DateTimeOffset.UtcNow, browserPid, networkPid, renderer, gpuWorker = worker, graphics = gpu.Read(), attribution = "Dedicated Copilot canvas WebView: renderer and GPU-worker process usage, including browser overhead; excludes the .NET server and other WebView families" };
                return lastSnapshot;
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or IOException or ArgumentException or ExternalException)
            {
                return new { available = false, reason = "Process attribution unavailable; no whole-machine fallback" };
            }
        }
    }

    private object ProcessSnapshot(int pid)
    {
        using var process = Process.GetProcessById(pid);
        var started = process.StartTime.ToUniversalTime().Ticks;
        var cpu = process.TotalProcessorTime.TotalMilliseconds;
        var now = Stopwatch.GetTimestamp();
        double? percent = null;
        if (samples.TryGetValue(pid, out var prior) && prior.Started == started)
        {
            var elapsed = Stopwatch.GetElapsedTime(prior.At, now).TotalMilliseconds;
            if (elapsed > 0) percent = Math.Clamp((cpu - prior.Cpu) / elapsed / Environment.ProcessorCount * 100, 0, 100);
        }
        samples[pid] = (started, cpu, now);
        foreach (var old in samples.Keys.Where(id => id != pid && !Native.IsAlive(id)).ToArray()) samples.Remove(old);
        return new { pid, started, cpuPercent = percent, workingSetBytes = process.WorkingSet64, privateBytes = process.PrivateMemorySize64, threads = process.Threads.Count, handles = process.HandleCount };
    }

    public void Dispose() { lock (sync) gpu?.Dispose(); }

    private sealed class GpuCounters : IDisposable
    {
        private IntPtr query;
        private readonly Dictionary<string, IntPtr> counters = new();
        private bool primed;

        public GpuCounters(int pid)
        {
            if (PdhOpenQuery(null, UIntPtr.Zero, out query) != 0) return;
            foreach (var (key, path) in new[] {
                ("engines", $"\\GPU Engine(pid_{pid}_*)\\Utilization Percentage"),
                ("dedicated", $"\\GPU Process Memory(pid_{pid}_*)\\Dedicated Usage"),
                ("shared", $"\\GPU Process Memory(pid_{pid}_*)\\Shared Usage"),
                ("committed", $"\\GPU Process Memory(pid_{pid}_*)\\Total Committed") })
                if (PdhAddEnglishCounter(query, path, UIntPtr.Zero, out var counter) == 0) counters[key] = counter;
            PdhCollectQueryData(query);
        }

        public object Read()
        {
            var collected = query != IntPtr.Zero && PdhCollectQueryData(query) == 0;
            var engines = new Dictionary<string, double>();
            if (collected && primed && counters.TryGetValue("engines", out var engine))
                foreach (var (name, value) in Values(engine))
                {
                    var match = Regex.Match(name, "engtype_(.+)$", RegexOptions.IgnoreCase);
                    if (!match.Success) continue;
                    var key = match.Groups[1].Value;
                    engines[key] = Math.Max(engines.GetValueOrDefault(key), Math.Clamp(value, 0, 100));
                }
            primed = collected;
            double? Bytes(string key)
            {
                if (!collected || !counters.TryGetValue(key, out var c)) return null;
                var values = Values(c);
                return values.Count > 0 ? values.Sum(p => p.Value) : null;
            }
            return new { available = engines.Count > 0, engines, busiestEnginePercent = engines.Count > 0 ? (double?)engines.Values.Max() : null,
                dedicatedBytes = Bytes("dedicated"), sharedBytes = Bytes("shared"), committedBytes = Bytes("committed") };
        }

        private static Dictionary<string, double> Values(IntPtr counter)
        {
            uint bytes = 0, count = 0;
            PdhGetFormattedCounterArray(counter, 0x200, ref bytes, ref count, IntPtr.Zero);
            if (bytes == 0 || bytes > 16 * 1024 * 1024) return new();
            var buffer = Marshal.AllocHGlobal((int)bytes);
            try
            {
                if (PdhGetFormattedCounterArray(counter, 0x200, ref bytes, ref count, buffer) != 0) return new();
                var result = new Dictionary<string, double>();
                var stride = Marshal.SizeOf<CounterItem>();
                for (var i = 0; i < count; i++)
                {
                    var item = Marshal.PtrToStructure<CounterItem>(buffer + i * stride);
                    var name = Marshal.PtrToStringUni(item.Name);
                    if (name is not null && item.Value.Status <= 1 && double.IsFinite(item.Value.Value)) result[name] = item.Value.Value;
                }
                return result;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public void Dispose() { if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; } }
        [StructLayout(LayoutKind.Sequential)] private struct CounterValue { public uint Status; public double Value; }
        [StructLayout(LayoutKind.Sequential)] private struct CounterItem { public IntPtr Name; public CounterValue Value; }
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhOpenQueryW")] private static extern uint PdhOpenQuery(string? source, UIntPtr data, out IntPtr query);
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhAddEnglishCounterW")] private static extern uint PdhAddEnglishCounter(IntPtr query, string path, UIntPtr data, out IntPtr counter);
        [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhGetFormattedCounterArrayW")] private static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bytes, ref uint count, IntPtr buffer);
        [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
    }

    private static class Native
    {
        public static bool IsAlive(int pid) { try { using var p = Process.GetProcessById(pid); return !p.HasExited; } catch (ArgumentException) { return false; } }

        public static int ClientProcess(int serverPort, int clientPort)
        {
            uint bytes = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref bytes, false, 2, 5, 0);
            var buffer = Marshal.AllocHGlobal((int)bytes);
            try
            {
                if (GetExtendedTcpTable(buffer, ref bytes, false, 2, 5, 0) != 0) return 0;
                var count = Marshal.ReadInt32(buffer);
                for (var i = 0; i < count; i++)
                {
                    var row = buffer + 4 + i * 24;
                    int Port(int offset) => (ushort)System.Net.IPAddress.NetworkToHostOrder((short)Marshal.ReadInt32(row, offset));
                    if (Port(8) == clientPort && Port(16) == serverPort && Marshal.ReadInt32(row, 4) == 0x0100007f && Marshal.ReadInt32(row, 12) == 0x0100007f)
                        return Marshal.ReadInt32(row, 20);
                }
                return 0;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public static Dictionary<int, (int Parent, string Name)> Processes()
        {
            var result = new Dictionary<int, (int, string)>();
            var snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) return result;
            try
            {
                var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), ExeFile = "" };
                if (!Process32First(snapshot, ref entry)) return result;
                do { result[(int)entry.ProcessId] = ((int)entry.ParentProcessId, entry.ExeFile.ToLowerInvariant()); }
                while (Process32Next(snapshot, ref entry));
                return result;
            }
            finally { CloseHandle(snapshot); }
        }

        public static string CommandLine(int pid)
        {
            var handle = OpenProcess(0x1000, false, pid);
            if (handle == IntPtr.Zero) return "";
            var buffer = Marshal.AllocHGlobal(65536);
            try
            {
                if (NtQueryInformationProcess(handle, 60, buffer, 65536, out _) != 0) return "";
                var text = Marshal.PtrToStructure<UnicodeString>(buffer);
                return text.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text.Buffer, text.Length / 2) ?? "";
            }
            finally { Marshal.FreeHGlobal(buffer); CloseHandle(handle); }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry
        {
            public uint Size, Usage, ProcessId; public UIntPtr DefaultHeapId; public uint ModuleId, Threads, ParentProcessId; public int Priority; public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
        }
        [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, uint tableClass, uint reserved);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr buffer, uint size, out uint required);
    }
}
