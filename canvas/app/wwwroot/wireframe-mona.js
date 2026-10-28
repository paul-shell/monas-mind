let engine, scene, camera, observer, disposed = true, autoRotate = false;
let wireMaterial, metricsTimer, metricsAbort, sourceTimer, sourceAbort;
let activeNoteCount = 0, measurementRevision = 0;
const sourceNodes = new Map();
let demoMode = false, demoCount = 1000, demoMesh, createDemo, depthOccluder;
let hoveringSource = false;

export function setTransparent(enabled) {
    depthOccluder?.setEnabled(!enabled);
    measurementRevision++;
}

export function setNoteCount(count) {
    demoCount = Math.max(0, Math.min(1000000, Math.floor(Number(count) || 0)));
    if (!demoMesh) return;
    demoMesh.setEnabled(demoMode && demoCount > 0);
    if (demoMesh.subMeshes[0]) {
        demoMesh.subMeshes[0].verticesCount = demoCount;
        demoMesh.subMeshes[0].indexCount = demoCount;
    }
    measurementRevision++;
}

export function setDemoMode(enabled, count = demoCount) {
    if (enabled && !demoMesh) createDemo?.();
    demoMode = !!enabled;
    for (const node of sourceNodes.values()) node.setEnabled(!demoMode);
    setNoteCount(count);
}

export function setWireOpacity(percent) {
    measurementRevision++;
    if (wireMaterial) wireMaterial.alpha = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
}
const initialAlpha = Math.PI / 2, initialBeta = Math.PI / 2;
let initialRadius = 18;

export function zoom(zoomIn) {
    if (!camera) return;
    measurementRevision++;
    const next = camera.radius * (zoomIn ? 0.8 : 1.25);
    camera.radius = Math.max(camera.lowerRadiusLimit, Math.min(camera.upperRadiusLimit, next));
    camera.inertialRadiusOffset = 0;
}

export function resetView() {
    measurementRevision++;
    if (!camera) return;
    camera.alpha = initialAlpha;
    camera.beta = initialBeta;
    camera.radius = initialRadius;
    camera.setTarget(BABYLON.Vector3.Zero());
    camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = camera.inertialPanningY = 0;
}

export function setAutoRotate(enabled) {
    measurementRevision++;
    autoRotate = enabled;
}

export async function start(canvas, apiBase) {
    dispose();
    disposed = false;
    const response = await fetch('./mona-octoprints.stl');
    if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
    const data = new DataView(await response.arrayBuffer());
    const triangles = data.getUint32(80, true);
    if (data.byteLength !== 84 + triangles * 50) throw new Error('Invalid binary STL model');
    if (disposed) return;

    const positions = new Float32Array(triangles * 9);
    const indices = new Uint32Array(triangles * 3);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < triangles; i++) {
        for (let vertex = 0; vertex < 3; vertex++) {
            const offset = 84 + i * 50 + 12 + vertex * 12;
            const x = data.getFloat32(offset, true);
            const y = data.getFloat32(offset + 4, true);
            const z = data.getFloat32(offset + 8, true);
            const p = (i * 3 + vertex) * 3;
            positions[p] = x;
            positions[p + 1] = z;
            positions[p + 2] = -y;
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], positions[p + axis]);
                max[axis] = Math.max(max[axis], positions[p + axis]);
            }
            indices[i * 3 + vertex] = i * 3 + vertex;
        }
    }
    for (let i = 0; i < positions.length; i++) positions[i] -= (min[i % 3] + max[i % 3]) / 2;
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    camera = new BABYLON.ArcRotateCamera('camera', initialAlpha, initialBeta, initialRadius, BABYLON.Vector3.Zero(), scene);
    camera.lowerRadiusLimit = 7;
    camera.upperRadiusLimit = 32;
    camera.wheelDeltaPercentage = 0.01;
    camera.attachControl(canvas, true);
    const mesh = new BABYLON.Mesh('mona-model', scene);
    const vertexData = new BABYLON.VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.applyToMesh(mesh);
    const wire = new BABYLON.StandardMaterial('wire', scene);
    wire.emissiveColor = BABYLON.Color3.FromHexString('#a8a8b5');
    wire.disableLighting = true;
    wire.wireframe = true;
    wire.backFaceCulling = false;
    mesh.material = wire;
    wire.alpha = 0.25;
    wireMaterial = wire;

    mesh.isPickable = true;
    depthOccluder = mesh.clone('mona-depth');
    const depthMaterial = new BABYLON.StandardMaterial('mona-depth-only', scene);
    depthMaterial.disableColorWrite = true;
    depthMaterial.zOffset = 1;
    depthMaterial.disableLighting = true;
    depthMaterial.backFaceCulling = false;
    depthOccluder.material = depthMaterial;
    depthOccluder.isPickable = false;
    depthOccluder.setEnabled(false);
    // Preserve the optional depth mask; offset it so front wire lines remain visible.
    mesh.renderingGroupId = 1;
    scene.setRenderingAutoClearDepthStencil(1, false);
    const fitView = (preserveZoom = false) => {
        const zoomRatio = preserveZoom ? camera.radius / initialRadius : 1;
        const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
        const tangent = Math.tan(camera.fov / 2);
        initialRadius = (max[2]-min[2])/2 + 1.08 * Math.max((max[0]-min[0])/2/(tangent*aspect), (max[1]-min[1])/2/tangent);
        camera.lowerRadiusLimit = initialRadius * 0.2;
        camera.upperRadiusLimit = initialRadius * 4;
        camera.radius = initialRadius * zoomRatio;
    };
    fitView();
    createDemo = () => {
        const areas = new Float64Array(triangles);
        let totalArea = 0;
        for (let i = 0; i < triangles; i++) {
            const p = i * 9;
            const ab = new BABYLON.Vector3(positions[p+3]-positions[p], positions[p+4]-positions[p+1], positions[p+5]-positions[p+2]);
            const ac = new BABYLON.Vector3(positions[p+6]-positions[p], positions[p+7]-positions[p+1], positions[p+8]-positions[p+2]);
            totalArea += BABYLON.Vector3.Cross(ab, ac).length();
            areas[i] = totalArea;
        }
        let seed = 2459;
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        const palette = ['#38bdf8','#fb923c','#a78bfa','#34d399','#f472b6'].map(c => BABYLON.Color3.FromHexString(c));
        const points = new Float32Array(3000000), colors = new Float32Array(4000000), ids = new Uint32Array(1000000);
        for (let i = 0; i < 1000000; i++) {
            const target = random() * totalArea;
            let low = 0, high = triangles - 1;
            while (low < high) { const mid = (low + high) >> 1; if (areas[mid] < target) low = mid + 1; else high = mid; }
            const p = low * 9, u = Math.sqrt(random()), v = random(), a = 1-u, b = u*(1-v), c = u*v;
            const x = a*positions[p]+b*positions[p+3]+c*positions[p+6];
            points.set([x,a*positions[p+1]+b*positions[p+4]+c*positions[p+7],a*positions[p+2]+b*positions[p+5]+c*positions[p+8]],i*3);
            const color = palette[Math.max(0,Math.min(4,Math.floor((x-(min[0]-max[0])/2)/(max[0]-min[0])*5)))];
            colors.set([color.r,color.g,color.b,1],i*4); ids[i]=i;
        }
        demoMesh = new BABYLON.Mesh('demo-notes',scene);
        demoMesh.isPickable = false;
        const data = new BABYLON.VertexData(); data.positions=points; data.colors=colors; data.indices=ids; data.applyToMesh(demoMesh);
        BABYLON.Effect.ShadersStore.monaNotesVertexShader='precision highp float; attribute vec3 position; attribute vec4 color; uniform mat4 worldViewProjection; varying vec4 vColor; void main(void){gl_Position=worldViewProjection*vec4(position,1.0);gl_PointSize=3.0;vColor=color;}';
        BABYLON.Effect.ShadersStore.monaNotesFragmentShader='precision highp float; varying vec4 vColor; void main(void){gl_FragColor=vColor;}';
        const material=new BABYLON.ShaderMaterial('demo-note-colors',scene,{vertex:'monaNotes',fragment:'monaNotes'},{attributes:['position','color'],uniforms:['worldViewProjection']});
        material.fillMode=BABYLON.Material.PointListDrawMode; demoMesh.material=material;
    };
    const sourceMaterial = new BABYLON.StandardMaterial('source-color', scene);
    sourceMaterial.emissiveColor = BABYLON.Color3.FromHexString('#38bdf8');
    sourceMaterial.disableLighting = true;
    const youtubeMaterial = new BABYLON.StandardMaterial('youtube-source-color', scene);
    youtubeMaterial.emissiveColor = BABYLON.Color3.FromHexString('#f05252');
    youtubeMaterial.disableLighting = true;
    const isYoutube = url => { try { const host = new URL(url).hostname; return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'); } catch { return false; } };
    const frontTriangles = [];
    for (let i = 0; i < triangles; i++) {
        const p = i * 9;
        if (positions[p+2] + positions[p+5] + positions[p+8] > 0) frontTriangles.push(i);
    }
    sourceAbort = new AbortController();
    const sourceSignal = sourceAbort.signal;
    const pollSources = async () => {
        try {
            const response = await fetch(new URL('api/captures', apiBase), { signal: sourceSignal, cache: 'no-store' });
            if (!response.ok) throw new Error('Sources unavailable');
            const sources = await response.json();
            if (sourceSignal.aborted) return;
            const ids = new Set(sources.map(source => source.id));
            for (const [id, node] of sourceNodes) {
                if (!ids.has(id)) { node.dispose(); sourceNodes.delete(id); }
            }
            for (const source of sources) {
                let node = sourceNodes.get(source.id);
                if (!node) {
                    let hash = 2166136261;
                    for (const char of source.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
                    const p = (frontTriangles.length ? frontTriangles[hash % frontTriangles.length] : hash % triangles) * 9;
                    node = BABYLON.MeshBuilder.CreateSphere('source-' + source.id, { diameter: 0.16, segments: 8 }, scene);
                    node.position.set((positions[p] + positions[p+3] + positions[p+6])/3,
                        (positions[p+1] + positions[p+4] + positions[p+7])/3,
                        (positions[p+2] + positions[p+5] + positions[p+8])/3);
                    const frontRay = new BABYLON.Ray(new BABYLON.Vector3(node.position.x, node.position.y, (max[2]-min[2])/2 + 1), new BABYLON.Vector3(0, 0, -1));
                    const frontHit = scene.pickWithRay(frontRay, candidate => candidate === mesh);
                    if (frontHit?.hit) node.position.copyFrom(frontHit.pickedPoint);
                    node.material = sourceMaterial;
                    sourceNodes.set(source.id, node);
                }
                node.material = isYoutube(source.url) ? youtubeMaterial : sourceMaterial;
                node.metadata = { sourceId: source.id, title: source.title, created: source.created, favicon: source.favicon ? new URL(source.favicon, apiBase).href : null };
                node.setEnabled(!demoMode);
            }
            activeNoteCount = sourceNodes.size;
            canvas.dataset.sourceCount = String(activeNoteCount);
            const count = document.getElementById('source-count');
            if (count) count.textContent = `${activeNoteCount} saved source${activeNoteCount === 1 ? '' : 's'}`;
        } catch (error) {
            if (!sourceSignal.aborted) {
                const count = document.getElementById('source-count');
                if (count) count.textContent = 'Sources unavailable; retrying';
            }
        } finally {
            if (!sourceSignal.aborted) sourceTimer = setTimeout(pollSources, 3000);
        }
    };
    const tooltip = document.createElement('div');
    tooltip.className = 'source-tooltip';
    tooltip.hidden = true;
    canvas.parentElement.appendChild(tooltip);
    canvas.onpointerleave = () => { tooltip.hidden = true; hoveringSource = false; };
    scene.onDisposeObservable.add(() => { tooltip.remove(); canvas.onpointerleave = null; });
    scene.onPointerObservable.add(event => {
        const hit = event.type === BABYLON.PointerEventTypes.POINTERMOVE
            ? scene.pick(scene.pointerX, scene.pointerY, candidate => candidate.isPickable && candidate.isEnabled(), false, camera)
            : event.pickInfo;
        const source = hit?.pickedMesh?.metadata;
        if (event.type === BABYLON.PointerEventTypes.POINTERPICK && source?.sourceId)
            location.assign('sources?source=' + encodeURIComponent(source.sourceId));
        if (event.type === BABYLON.PointerEventTypes.POINTERMOVE) {
            hoveringSource = !!source?.sourceId;
            tooltip.hidden = !hoveringSource;
            if (source?.sourceId) {
                tooltip.replaceChildren();
                if (source.favicon) {
                    const icon = document.createElement('img');
                    icon.className = 'source-favicon'; icon.alt = ''; icon.src = source.favicon;
                    tooltip.appendChild(icon);
                }
                tooltip.appendChild(document.createTextNode(`${source.title}\nSaved ${new Date(source.created).toLocaleString()}`));
                tooltip.style.left = `${Math.max(8, Math.min(scene.pointerX + 12, canvas.clientWidth - tooltip.offsetWidth - 8))}px`;
                tooltip.style.top = `${Math.max(8, Math.min(scene.pointerY + 12, canvas.clientHeight - tooltip.offsetHeight - 8))}px`;
            }
        }
    });
    pollSources();
    observer = new ResizeObserver(() => { if (engine && camera) { engine.resize(); fitView(true); } measurementRevision++; });
    observer.observe(canvas);
    const fpsDisplay = document.getElementById('graph-fps');
    const frameDisplay = document.getElementById('graph-frame-time');
    const stutterDisplay = document.getElementById('graph-stutters');
    const workloadDisplay = document.getElementById('graph-workload');
    const systemDisplay = document.getElementById('graph-system');
    const gpuDisplay = document.getElementById('graph-gpu');
    const processDisplay = document.getElementById('graph-process');
    const gpuMemoryDisplay = document.getElementById('graph-gpu-memory');

    metricsAbort = new AbortController();
    const signal = metricsAbort.signal;
    const pollMetrics = async () => {
        try {
            if (new URLSearchParams(location.search).get('hosting') !== 'release') throw new Error('Use the published canvas for process metrics');
            const response = await fetch('/api/renderer-metrics', { signal, cache: 'no-store' });
            if (!response.ok) throw new Error('Metrics unavailable');
            const metrics = await response.json();
            if (signal.aborted || !systemDisplay) return;
            if (!metrics.available) throw new Error(metrics.reason || 'Renderer unavailable');
            const mib = value => Number.isFinite(value) ? `${(value / 1048576).toFixed(0)} MiB` : '--';
            const pct = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
            const { renderer, gpuWorker: worker, graphics } = metrics;
            const cpu = Number.isFinite(renderer.cpuPercent) && Number.isFinite(worker.cpuPercent)
                ? renderer.cpuPercent + worker.cpuPercent : null;
            systemDisplay.textContent = `Canvas CPU ${pct(cpu)} · private memory ${mib(renderer.privateBytes + worker.privateBytes)}`;
            systemDisplay.title = 'Dedicated canvas renderer + graphics worker, including browser overhead. CPU normalized to total CPU capacity. Private committed memory, not resident RAM; excludes shared allocations and the .NET server.';
            if (processDisplay) processDisplay.textContent = 'Dedicated Mona WebView · includes browser overhead';
            if (gpuDisplay) {
                gpuDisplay.textContent = `Canvas GPU ${pct(graphics.busiestEnginePercent)}`;
                gpuDisplay.title = 'GPU: busiest engine for this WebView graphics worker. Dedicated graphics memory is not total system RAM.';
            }
            if (gpuMemoryDisplay) gpuMemoryDisplay.textContent = `Graphics shared RAM ${mib(graphics.sharedBytes)}`;        } catch (error) {
            if (!signal.aborted) {
                if (systemDisplay) systemDisplay.textContent = 'CPU / RAM: unavailable';
                if (processDisplay) processDisplay.textContent = error.message;
                if (gpuDisplay) gpuDisplay.textContent = 'GPU: unavailable';
                if (gpuMemoryDisplay) gpuMemoryDisplay.textContent = 'GPU memory: unavailable';

            }
        } finally {
            if (!signal.aborted) metricsTimer = setTimeout(pollMetrics, 2000);
        }
    };
    pollMetrics();
    let lastFpsUpdate = 0, previousFrame = 0, observedRevision = measurementRevision;
    const frameTimes = [];
    window.monaModelExperiment = { triangles, min, max, source: 'Martin Woodward / Octoprints, CC BY-NC 4.0' };
    engine.runRenderLoop(() => {
        if (autoRotate && !hoveringSource) camera.alpha += Math.min(engine.getDeltaTime(), 100) * (2 * Math.PI / 120000);
        scene.render();
        const now = performance.now();
        if (document.hidden || observedRevision !== measurementRevision) {
            frameTimes.length = 0;
            previousFrame = 0;
            observedRevision = measurementRevision;
        }
        if (previousFrame && !document.hidden) frameTimes.push({ at: now, ms: now - previousFrame });
        previousFrame = document.hidden ? 0 : now;
        while (frameTimes.length && frameTimes[0].at < now - 30000) frameTimes.shift();
        if (now - lastFpsUpdate >= 500) {
            const stats = summarizeFrames(frameTimes.map(frame => frame.ms));
            if (fpsDisplay) fpsDisplay.textContent = stats ? `${stats.fps.toFixed(1)} avg FPS` : 'Sampling FPS';
            if (frameDisplay) frameDisplay.textContent = stats ? `P95 ${stats.p95.toFixed(1)} ms (${Math.min(30, stats.seconds).toFixed(0)}s)` : 'Frame timing: warming up';
            if (stutterDisplay) stutterDisplay.textContent = stats ? `Stutters >50 ms: ${stats.stutters} · worst ${stats.worst.toFixed(1)} ms` : 'Stutters: sampling';
            if (workloadDisplay) workloadDisplay.textContent = `${activeNoteCount.toLocaleString()} sample dots · ${engine.getRenderWidth()}×${engine.getRenderHeight()} px · ${autoRotate ? 'rotating' : 'stationary'}`;
            lastFpsUpdate = now;
        }
    });
}

export function dispose() {
    disposed = true;
    sourceAbort?.abort();
    sourceAbort = undefined;
    clearTimeout(sourceTimer);
    sourceTimer = undefined;
    metricsAbort?.abort();
    metricsAbort = undefined;
    clearTimeout(metricsTimer);
    metricsTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    scene?.dispose();
    engine?.dispose();
    scene = undefined;
    sourceNodes.clear();
    activeNoteCount = 0;
    demoMesh = undefined;
    depthOccluder = undefined;
    createDemo = undefined;
    demoMode = false;
    wireMaterial = undefined;
    camera = undefined;
    engine = undefined;
    autoRotate = false;
    hoveringSource = false;
    delete window.monaModelExperiment;
}

export function summarizeFrames(intervals) {
    if (!intervals.length) return null;
    const sorted = [...intervals].sort((a, b) => a - b);
    const elapsed = intervals.reduce((sum, ms) => sum + ms, 0);
    return {
        fps: intervals.length * 1000 / elapsed,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        stutters: intervals.filter(ms => ms > 50).length,
        worst: sorted[sorted.length - 1],
        seconds: elapsed / 1000,
    };
}