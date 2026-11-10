import * as THREE from 'three';

export type TileRect = { x: number; y: number; w: number; h: number };

/** Row-major rectangles of at most `tile` pixels covering a width by height image exactly. */
export function planTiles(width: number, height: number, tile: number): TileRect[] {
  const rects: TileRect[] = [];
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) rects.push({ x, y, w: Math.min(tile, width - x), h: Math.min(tile, height - y) });
  return rects;
}

/** Textures this big are worth slicing: a 4096 px map blocks the main thread for 20 to 150 ms in one texSubImage2D call. */
export const SLICE_MIN_PIXELS = 2048 * 2048;

export type SliceStatus = 'done' | 'more' | 'wait';

/**
 * Uploads a large ImageBitmap texture to the GPU in tiles over several frames, instead of in the single call three.js makes the first
 * time the texture is drawn. three.js only allocates the storage (Source.dataReady = false); the tiles are cut from the bitmap off the
 * main thread (createImageBitmap) and copied in with texSubImage2D, then the mip chain is built once at the end. Until `upload` has
 * returned 'done' for a texture its contents are incomplete, so the caller keeps whatever draws it hidden (see pois.ts).
 *
 * Anything that is not a plain RGBA8 ImageBitmap, or that fails, goes through three.js's own whole-texture upload.
 */
export function createTextureSlicer(renderer: THREE.WebGLRenderer, options: { tile?: number; budgetMs?: number; urgentBudgetMs?: number; clock?: () => number } = {}) {
  const gl = renderer.getContext() as WebGL2RenderingContext, clock = options.clock ?? (() => performance.now());
  const tile = options.tile ?? 1024, budget = options.budgetMs ?? 5, urgentBudget = options.urgentBudgetMs ?? 16;
  type Job = { rects: TileRect[]; tiles?: ImageBitmap[]; failed: boolean; next: number; waits: number; allocated: boolean; webgl?: WebGLTexture | null };
  const jobs = new WeakMap<THREE.Texture, Job>();
  const eligible = (t: THREE.Texture) => {
    const image = t.image as ImageBitmap | undefined;
    return typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap && image.width * image.height >= SLICE_MIN_PIXELS
      && t.format === THREE.RGBAFormat && t.type === THREE.UnsignedByteType && !(t as THREE.CompressedTexture).isCompressedTexture && !(t as THREE.DataTexture).isDataTexture;
  };
  /** The plain way: let three.js upload the whole texture now. */
  function whole(t: THREE.Texture, job?: Job) {
    if (job?.allocated) t.needsUpdate = true;
    t.source.dataReady = true;
    renderer.initTexture(t);
    if (job) for (const b of job.tiles ?? []) b.close();
    jobs.delete(t);
    return 'done' as const;
  }
  return {
    eligible,
    /** One piece of work: 'done' (nothing more to do), 'more' (call again after a pause) or 'wait' (tiles are still being cut). */
    upload(t: THREE.Texture, urgent = false): SliceStatus {
      if (!eligible(t)) { renderer.initTexture(t); return 'done'; }
      let job = jobs.get(t);
      if (!job) {
        const image = t.image as ImageBitmap, rects = planTiles(image.width, image.height, tile), made: Job = { rects, failed: false, next: 0, waits: 0, allocated: false };
        jobs.set(t, job = made);
        Promise.all(rects.map(r => createImageBitmap(image, r.x, r.y, r.w, r.h, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' })))
          .then(tiles => { made.tiles = tiles; }, () => { made.failed = true; });
        return 'wait';
      }
      if (job.failed || job.waits > 400) return whole(t, job);
      if (!job.tiles) { job.waits++; return 'wait'; }
      if (!job.allocated) {
        // Storage only: three.js allocates the texture and its mip levels but copies nothing.
        t.source.dataReady = false; t.needsUpdate = true; renderer.initTexture(t);
        job.webgl = (renderer.properties.get(t) as { __webglTexture?: WebGLTexture | null }).__webglTexture;
        if (!job.webgl) { t.source.dataReady = true; job.failed = true; return 'more'; }
        job.allocated = true;
        return 'more';
      }
      const start = clock(), limit = urgent ? urgentBudget : budget;
      renderer.state.bindTexture(gl.TEXTURE_2D, job.webgl!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, t.flipY); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, t.premultiplyAlpha);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, t.unpackAlignment); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      do {
        const r = job.rects[job.next], bitmap = job.tiles[job.next];
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close(); job.next++;
      } while (job.next < job.rects.length && clock() - start < limit);
      if (job.next < job.rects.length) { renderer.state.unbindTexture(); return 'more'; }
      if (t.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      renderer.state.unbindTexture();
      t.source.dataReady = true; jobs.delete(t);
      return 'done';
    },
  };
}
export type TextureSlicer = ReturnType<typeof createTextureSlicer>;
