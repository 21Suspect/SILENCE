import * as THREE from 'three';

/** One frame as the probe saw it. Times are milliseconds. `gpu` arrives a few frames late (timer queries resolve asynchronously) and stays undefined without EXT_disjoint_timer_query_webgl2. */
export type PerfRow = {
  /** Time since the previous animation frame: what the player experiences. */
  frame: number;
  /** The whole of the engine's animate() body on the CPU. */
  cpu: number;
  sky: number; /** Player movement, collision sweeps and the camera, between the sky and the terrain update. */ move: number; terrain: number; forest: number; world: number; encounter: number; shadowPrep: number; audio: number;
  /** CPU time spent inside renderer.render calls for the frame (everything the engine asked to draw). */
  submit: number;
  /** The part of `submit` spent recording shadow maps (sun and torch). */
  shadowCpu: number;
  gpu: number | undefined;
  calls: number; triangles: number; shadowCalls: number; shadowTriangles: number;
  sunShadow: boolean;
  programs: number; textures: number; geometries: number;
};

export type Stat = { median: number; mean: number; p95: number; p99: number; max: number };
export type PerfSummary = {
  frames: number;
  stats: Record<string, Stat>;
  /** Frames longer than 16.7, 33.3 and 50 ms (the rAF interval), and the worst one. */
  long: { over17: number; over33: number; over50: number; worst: number };
  /** Frames whose CPU work alone took longer than a 60 Hz and a 120 Hz frame. */
  cpuOver: { over8: number; over16: number };
};

/** Linear-interpolated percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number) {
  if (!sorted.length) return NaN;
  const at = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1))), lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function stat(values: readonly number[]): Stat {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { median: NaN, mean: NaN, p95: NaN, p99: NaN, max: NaN };
  return { median: percentile(v, .5), mean: v.reduce((a, b) => a + b, 0) / v.length, p95: percentile(v, .95), p99: percentile(v, .99), max: v[v.length - 1] };
}

const NUMERIC = ['frame', 'cpu', 'sky', 'move', 'terrain', 'forest', 'world', 'encounter', 'shadowPrep', 'audio', 'submit', 'shadowCpu', 'gpu', 'calls', 'triangles', 'shadowCalls', 'shadowTriangles', 'programs', 'textures', 'geometries'] as const;

export function summarize(rows: readonly PerfRow[]): PerfSummary {
  const stats: Record<string, Stat> = {};
  for (const key of NUMERIC) stats[key] = stat(rows.map(r => r[key] as number));
  const frames = rows.map(r => r.frame).filter(Number.isFinite);
  return {
    frames: rows.length, stats,
    long: { over17: frames.filter(f => f > 16.7).length, over33: frames.filter(f => f > 33.3).length, over50: frames.filter(f => f > 50).length, worst: frames.length ? Math.max(...frames) : NaN },
    cpuOver: { over8: rows.filter(r => r.cpu > 8.3).length, over16: rows.filter(r => r.cpu > 16.7).length },
  };
}

/** The marks the engine writes during a frame, in the order they happen. */
export type PerfMarks = { start: number; sky: number; terrain0: number; forest0: number; forest1: number; world1: number; encounter1: number; shadow1: number; audio1: number; render0: number; render1: number };

/**
 * Per-frame recorder for the dev diagnostic. It wraps the shadow pass to count what that pass draws, runs one GPU timer
 * query around the engine's main render (when the browser has the extension) and turns the engine's marks into rows.
 * Nothing here runs in a production build: the engine creates it under `import.meta.env.DEV` only.
 */
export function createPerfProbe(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const marks: PerfMarks = { start: 0, sky: 0, terrain0: 0, forest0: 0, forest1: 0, world1: 0, encounter1: 0, shadow1: 0, audio1: 0, render0: 0, render1: 0 };
  const rows: PerfRow[] = [], pending: { query: WebGLQuery; row: PerfRow }[] = [];
  let recording = false, shadowCalls = 0, shadowTriangles = 0, shadowMs = 0, query: WebGLQuery | undefined;

  // The shadow pass is a separate call inside renderer.render; patching it here is how its share of the frame is counted.
  const shadowMap = renderer.shadowMap as unknown as { render: (...args: unknown[]) => void };
  const render = shadowMap.render.bind(shadowMap), info = renderer.info;
  shadowMap.render = (...args) => {
    if (!recording) { render(...args); return; }
    const calls = info.render.calls, triangles = info.render.triangles, t = performance.now();
    render(...args);
    shadowMs += performance.now() - t; shadowCalls += info.render.calls - calls; shadowTriangles += info.render.triangles - triangles;
  };

  function poll() {
    while (pending.length) {
      const { query: q, row } = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(ext!.GPU_DISJOINT_EXT)) row.gpu = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
      gl.deleteQuery(q); pending.shift();
    }
  }

  return {
    marks, gpuTimer: !!ext,
    get recording() { return recording; },
    start() { rows.length = 0; recording = true; },
    stop() { recording = false; poll(); return rows.slice(); },
    /** Before the engine's main render. */
    beginRender() {
      if (!recording) return;
      shadowCalls = shadowTriangles = shadowMs = 0;
      if (ext && !query) { query = gl.createQuery()!; gl.beginQuery(ext.TIME_ELAPSED_EXT, query); }
    },
    /** After it; `frame` is the interval since the previous frame, `sunShadow` whether the sun's map was redrawn. */
    endFrame(frame: number, sunShadow: boolean) {
      if (!recording) return;
      const m = marks, i = renderer.info, row: PerfRow = {
        frame, cpu: performance.now() - m.start, sky: m.sky - m.start, move: m.terrain0 - m.sky, terrain: m.forest0 - m.terrain0, forest: m.forest1 - m.forest0, world: m.world1 - m.forest1,
        encounter: m.encounter1 - m.world1, shadowPrep: m.shadow1 - m.encounter1, audio: m.audio1 - m.shadow1, submit: m.render1 - m.render0, shadowCpu: shadowMs, gpu: undefined,
        calls: i.render.calls, triangles: i.render.triangles, shadowCalls, shadowTriangles, sunShadow,
        programs: i.programs?.length ?? 0, textures: i.memory.textures, geometries: i.memory.geometries,
      };
      if (ext && query) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query, row }); query = undefined; }
      rows.push(row); poll();
    },
  };
}
export type PerfProbe = ReturnType<typeof createPerfProbe>;

export type DrawGroup = { name: string; meshes: number; draws: number; instances: number; triangles: number; castShadow: boolean };

/**
 * What the main camera would submit, grouped by mesh name: the same visibility, layer and frustum tests the renderer applies
 * (no occlusion), with triangles counted per instance and per material group. With `shadowCamera` it lists what a shadow pass from that
 * camera would draw (shadow casters inside its frustum). Dev measurement only; it walks the scene.
 */
export function drawList(scene: THREE.Scene, camera: THREE.Camera, shadowCamera?: THREE.Camera): DrawGroup[] {
  camera.updateMatrixWorld();
  const view = shadowCamera ?? camera;
  const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
  frustum.setFromProjectionMatrix(matrix);
  const groups = new Map<string, DrawGroup>(), sphere = new THREE.Sphere();
  const name = (o: THREE.Object3D) => { let n = o.name; for (let p = o.parent; !n && p; p = p.parent) n = p.name; return n || o.type; };
  const walk = (o: THREE.Object3D, parentVisible: boolean) => {
    const visible = parentVisible && o.visible;
    if (!visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && o.layers.test(camera.layers) && (!shadowCamera || o.castShadow)) {
      let inside = true;
      if (mesh.frustumCulled) {
        const g = mesh.geometry;
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) { const im = mesh as THREE.InstancedMesh; if (im.boundingSphere === null) im.computeBoundingSphere(); sphere.copy(im.boundingSphere!).applyMatrix4(o.matrixWorld); }
        else { if (g.boundingSphere === null) g.computeBoundingSphere(); sphere.copy(g.boundingSphere!).applyMatrix4(o.matrixWorld); }
        inside = frustum.intersectsSphere(sphere);
      }
      if (inside) {
        const g = mesh.geometry, instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
        const perTriangles = (count: number) => count / 3;
        const total = g.index ? g.index.count : g.getAttribute('position').count;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        let draws = 0, triangles = 0;
        if (Array.isArray(mesh.material)) {
          for (const group of g.groups) if (materials[group.materialIndex!]?.visible) { draws++; triangles += perTriangles(Math.min(group.count, total - group.start)); }
        } else if (mesh.material.visible) { draws = 1; triangles = perTriangles(total); }
        if (instances > 0 && draws) {
          const key = name(o);
          let row = groups.get(key); if (!row) groups.set(key, row = { name: key, meshes: 0, draws: 0, instances: 0, triangles: 0, castShadow: o.castShadow });
          row.meshes++; row.draws += draws; row.instances += instances; row.triangles += triangles * instances;
        }
      }
    }
    for (const child of o.children) walk(child, visible);
  };
  walk(scene, true);
  return [...groups.values()].sort((a, b) => b.triangles - a.triangles);
}

/**
 * For every instanced shadow caster that the renderer would submit: how many of its instances actually reach the shadow camera's
 * frustum (instance bounding sphere = geometry sphere moved and scaled by the instance matrix) and how many triangles that is.
 * The gap between this and what is submitted is what per-instance culling of the shadow pass could save.
 */
export function shadowInstanceCulling(scene: THREE.Scene, camera: THREE.Camera, shadowCamera: THREE.Camera) {
  shadowCamera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse));
  const m = new THREE.Matrix4(), sphere = new THREE.Sphere(), c = new THREE.Vector3(), rows: { name: string; submitted: number; reaching: number; trianglesSubmitted: number; trianglesReaching: number }[] = [];
  const walk = (o: THREE.Object3D, parentVisible: boolean) => {
    if (!(parentVisible && o.visible)) return;
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && o.castShadow && o.layers.test(camera.layers)) {
      const g = im.geometry; if (g.boundingSphere === null) g.computeBoundingSphere();
      if (im.boundingSphere === null) im.computeBoundingSphere();
      sphere.copy(im.boundingSphere!).applyMatrix4(o.matrixWorld);
      if (frustum.intersectsSphere(sphere)) {
        const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        let reaching = 0;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m); c.copy(g.boundingSphere!.center).applyMatrix4(m);
          const scale = Math.max(m.getMaxScaleOnAxis(), 1e-6);
          sphere.set(c, g.boundingSphere!.radius * scale);
          if (frustum.intersectsSphere(sphere)) reaching++;
        }
        let name = o.name; for (let p = o.parent; !name && p; p = p.parent) name = p.name;
        rows.push({ name: name || o.type, submitted: im.count, reaching, trianglesSubmitted: tris * im.count, trianglesReaching: tris * reaching });
      }
    }
    for (const child of o.children) walk(child, true);
  };
  walk(scene, true);
  const total = rows.reduce((a, r) => ({ submitted: a.submitted + r.submitted, reaching: a.reaching + r.reaching, trianglesSubmitted: a.trianglesSubmitted + r.trianglesSubmitted, trianglesReaching: a.trianglesReaching + r.trianglesReaching }), { submitted: 0, reaching: 0, trianglesSubmitted: 0, trianglesReaching: 0 });
  return { total, rows: rows.sort((a, b) => b.trianglesSubmitted - a.trianglesSubmitted) };
}

export type TextureRow = { key: string; width: number; height: number; copies: number; megabytes: number; kind: string };

/**
 * Every texture reachable from a material in the scene, grouped by where it came from (its URL, else its name), with an estimate of the
 * GPU memory (RGBA8 plus the mip chain). `copies` above 1 means the same file was uploaded more than once. Dev measurement only.
 */
export function textureReport(scene: THREE.Scene): { rows: TextureRow[]; totalMegabytes: number; duplicatedMegabytes: number } {
  const seen = new Set<THREE.Texture>(), groups = new Map<string, TextureRow>();
  const add = (t: THREE.Texture) => {
    if (seen.has(t) || (t as THREE.WebGLRenderTarget['texture']).isRenderTargetTexture) return; seen.add(t);
    const image = t.image as { width?: number; height?: number; src?: string; currentSrc?: string } | undefined;
    const width = image?.width ?? 0, height = image?.height ?? 0;
    if (!width) return;
    const key = image?.currentSrc?.replace(location.origin, '') || image?.src?.replace(location.origin, '') || t.name || t.source.uuid.slice(0, 8);
    const mb = width * height * 4 * (t.generateMipmaps ? 4 / 3 : 1) / 1048576;
    const row = groups.get(key); if (row) { row.copies++; row.megabytes += mb; } else groups.set(key, { key, width, height, copies: 1, megabytes: mb, kind: (image as object)?.constructor?.name ?? '?' });
  };
  scene.traverse(o => { const m = (o as THREE.Mesh).material; if (!m) return; for (const material of Array.isArray(m) ? m : [m]) for (const v of Object.values(material)) if ((v as THREE.Texture)?.isTexture) add(v as THREE.Texture); });
  const rows = [...groups.values()].sort((a, b) => b.megabytes - a.megabytes);
  return { rows, totalMegabytes: rows.reduce((a, r) => a + r.megabytes, 0), duplicatedMegabytes: rows.filter(r => r.copies > 1).reduce((a, r) => a + r.megabytes * (r.copies - 1) / r.copies, 0) };
}
