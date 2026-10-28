import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';
import { startServer } from './server.mjs';
import { createSourceTools } from '../search/tools.mjs';

const servers = new Map();
async function open(instanceId) {
    let pending = servers.get(instanceId);
    if (!pending) {
        pending = startServer();
        servers.set(instanceId, pending);
    }
    try { return await pending; }
    catch {
        if (servers.get(instanceId) === pending) servers.delete(instanceId);
        throw new CanvasError('mona_release_unavailable', 'Published Mona assets could not start. Run scripts/setup.ps1 and reopen the canvas.');
    }
}

await joinSession({
    tools: createSourceTools(),
    canvases: [createCanvas({
        id: 'monas-mind',
        displayName: 'Mona’s Mind',
        description: 'Published Blazor and Babylon.js Mona visualization with an automatically managed local server.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        open: async ctx => ({ url: (await open(ctx.instanceId)).url, title: 'Mona’s Mind' }),
        onClose: async ctx => {
            const pending = servers.get(ctx.instanceId);
            servers.delete(ctx.instanceId);
            if (pending) await (await pending).close();
        },
        actions: [{
            name: 'status',
            description: 'Check this canvas’s own Release server, independent of the development terminal.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async ctx => {
                const pending = servers.get(ctx.instanceId);
                if (!pending) throw new CanvasError('mona_not_open', 'Open the canvas first.');
                const { url } = await pending;
                const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5000) });
                if (!response.ok) throw new CanvasError('mona_server_unavailable', 'The canvas server is unavailable.');
                return { available: true, url, ...await response.json(), renderer: 'Babylon.js', metrics: 'Same-process Windows metrics', pid: (await pending).pid };
            },
        }],
    })],
});
