import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const owned = new Set();
process.once('exit', () => { for (const child of owned) child.kill(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));

export async function startServer() {
    const state = join(root, '.local', 'host');
    await mkdir(state, { recursive: true });
    const child = spawn(join(root, '.local', 'bin', 'MonasMindHost.exe'), [], {
        cwd: state, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            MONA_PORT: '0', ASPNETCORE_ENVIRONMENT: 'Production', MONA_EXTENSION_ROOT: root,
            DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(state, 'bundle-cache'),
        },
    });
    owned.add(child);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.once('exit', () => owned.delete(child));
    const ready = new Promise((accept, reject) => {
        const timer = setTimeout(() => finish(new Error('Mona host startup timed out')), 30000);
        function finish(error, value) {
            clearTimeout(timer);
            child.off('error', fail);
            child.off('exit', exited);
            lines.off('line', line);
            if (error) { child.kill(); reject(error); } else accept(value);
        }
        function fail(error) { finish(error); }
        function exited(code) { finish(new Error(`Mona host exited before readiness: ${code}`)); }
        function line(text) {
            if (!text.startsWith('MONA_READY ')) return;
            try {
                const url = new URL(JSON.parse(text.slice(11)).url);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
                    throw new Error('Unexpected Mona host binding');
                finish(null, url.origin);
            } catch (error) { finish(error); }
        }
        child.once('error', fail);
        child.once('exit', exited);
        lines.on('line', line);
    });
    const origin = await ready;
    try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        if (!response.ok || health.application !== 'monas-mind' || health.bundledAssets < 1)
            throw new Error('Mona bundled asset check failed');
    } catch (error) { child.kill(); throw error; }
    return {
        url: `${origin}/?hosting=release`, pid: child.pid,
        close: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise(accept => { child.once('exit', accept); child.kill(); });
        },
    };
}