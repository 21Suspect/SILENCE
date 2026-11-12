import * as THREE from 'three';

export type TileRect = { x: number; y: number; w: number; h: number };

/** Row-major rectangles of at most `tile` pixels covering a width by height image exactly. */
export function planTiles(width: number, height: number, tile: number): TileRect[] {
  const rects: TileRect[] = [];
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) rects.push({ x, y, w: Math.min(tile, width - x), h: Math.min(tile, height - y) });
  return rects;
}

/** Textures this big are worth slicing: three.js uploads them in one call that takes 10 to 115 ms (see below). */
export const SLICE_MIN_PIXELS = 2048 * 2048;

export type SliceStatus = 'done' | 'more' | 'wait';

type Source = ImageBitmap | HTMLImageElement;
const sourceSize = (image: Source) => image instanceof ImageBitmap ? [image.width, image.height] : [image.naturalWidth, image.naturalHeight];

/**
 * Uploads a large texture to the GPU in tiles over several frames, instead of in the single call three.js makes the first time the
 * texture is drawn. three.js only allocates the storage (Source.dataReady = false); each tile is then read straight out of the decoded
 * image (UNPACK_SKIP_PIXELS/ROWS select the rectangle, so no cropped copies are made), and the mip chain is built once at the end.
 * Until `upload` has returned 'done' for a texture its contents are incomplete, so the caller keeps whatever draws it hidden (pois.ts).
 *
 * Colour maps need care. Measured in Chrome on an M5 Pro (ANGLE on Metal), writing into part of an sRGB texture (texSubImage2D into
 * SRGB8_ALPHA8, which is how three.js uploads every colour map) costs 7 to 10 ms per megapixel in the GPU process, against 0.4 ms
 * for a plain RGBA8 texture and 0.6 ms for a whole-image texImage2D: a 4096 px albedo took 115 ms in one call, or a 20 to 45 ms stall
 * every few tiles when sliced. So a colour tile is first uploaded whole into a small sRGB staging texture (the fast path) and then
 * copied into place on the GPU (copyTexSubImage2D, sRGB to sRGB, bit-exact), about 1 ms a tile in all.
 *
 * Anything else (flipped, compressed, data textures, other formats), or a failure, goes through three.js's own whole-texture upload.
 */
export function createTextureSlicer(renderer: THREE.WebGLRenderer, options: { tile?: number; budgetMs?: number; urgentBudgetMs?: number; clock?: () => number } = {}) {
  const gl = renderer.getContext() as WebGL2RenderingContext, clock = options.clock ?? (() => performance.now());
  const tile = options.tile ?? 512, budget = options.budgetMs ?? 2, urgentBudget = options.urgentBudgetMs ?? 6;
  type Job = { rects: TileRect[]; next: number; allocated: boolean; srgb: boolean; webgl?: WebGLTexture | null };
  const jobs = new WeakMap<THREE.Texture, Job>();
  let staging: WebGLTexture | null = null, readBuffer: WebGLFramebuffer | null = null;
  const eligible = (t: THREE.Texture) => {
    const image = t.image as Source | undefined;
    const usable = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
      || typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    if (!usable) return false;
    const [w, h] = sourceSize(image!);
    return w * h >= SLICE_MIN_PIXELS && !t.flipY && t.format === THREE.RGBAFormat && t.type === THREE.UnsignedByteType
      && !(t as THREE.CompressedTexture).isCompressedTexture && !(t as THREE.DataTexture).isDataTexture;
  };
  /** The plain way: let three.js upload the whole texture now. */
  function whole(t: THREE.Texture, job?: Job) {
    if (job?.allocated) t.needsUpdate = true;
    t.source.dataReady = true;
    renderer.initTexture(t);
    jobs.delete(t);
    return 'done' as const;
  }
  /** One colour tile: whole-image upload into the staging texture, then a GPU copy into place. Leaves `target` bound. */
  function copyTile(target: WebGLTexture, image: Source, r: TileRect) {
    if (!staging) {
      staging = gl.createTexture(); readBuffer = gl.createFramebuffer();
      renderer.state.bindTexture(gl.TEXTURE_2D, staging);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    renderer.state.bindTexture(gl.TEXTURE_2D, staging);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, r.w, r.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // Raw GL on purpose: the read binding is put back exactly as it was, so three.js's own record of it stays true.
    const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, staging, 0);
    renderer.state.bindTexture(gl.TEXTURE_2D, target);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, 0, 0, r.w, r.h);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
  }
  return {
    eligible,
    /** One piece of work: 'done' (nothing more to do) or 'more' (call again after a pause). */
    upload(t: THREE.Texture, urgent = false): SliceStatus {
      if (!eligible(t)) { renderer.initTexture(t); return 'done'; }
      const image = t.image as Source;
      let job = jobs.get(t);
      if (!job) {
        const [w, h] = sourceSize(image);
        jobs.set(t, job = { rects: planTiles(w, h, tile), next: 0, allocated: false, srgb: t.colorSpace === THREE.SRGBColorSpace });
      }
      if (!job.allocated) {
        // Storage only: three.js allocates the texture and its mip levels but copies nothing.
        t.source.dataReady = false; t.needsUpdate = true; renderer.initTexture(t);
        job.webgl = (renderer.properties.get(t) as { __webglTexture?: WebGLTexture | null }).__webglTexture;
        if (!job.webgl) return whole(t, job);
        job.allocated = true;
        return 'more';
      }
      const start = clock(), limit = urgent ? urgentBudget : budget, target = job.webgl!;
      try {
        renderer.state.bindTexture(gl.TEXTURE_2D, target);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, t.premultiplyAlpha);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, t.unpackAlignment); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        do {
          const r = job.rects[job.next];
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
          if (job.srgb) copyTile(target, image, r);
          else gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, image);
          job.next++;
        } while (job.next < job.rects.length && clock() - start < limit);
      } catch (error) {
        console.warn('SILENCE: tiled texture upload failed; uploading it whole.', error);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        renderer.state.unbindTexture();
        return whole(t, job);
      }
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      if (job.next < job.rects.length) { renderer.state.unbindTexture(); return 'more'; }
      if (t.generateMipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      renderer.state.unbindTexture();
      t.source.dataReady = true; jobs.delete(t);
      return 'done';
    },
    /** Builds the staging copy's GPU pipeline once, behind the loading veil: its first use costs several milliseconds. */
    prime() {
      if (staging) return;
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : undefined;
      if (!canvas) return;
      const scratch = gl.createTexture();
      try {
        renderer.state.bindTexture(gl.TEXTURE_2D, scratch);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, 4, 4);
        copyTile(scratch!, canvas as unknown as HTMLImageElement, { x: 0, y: 0, w: 4, h: 4 });
      } finally { renderer.state.unbindTexture(); gl.deleteTexture(scratch); }
    },
    dispose() { if (staging) gl.deleteTexture(staging); if (readBuffer) gl.deleteFramebuffer(readBuffer); staging = null; readBuffer = null; },
  };
}
export type TextureSlicer = ReturnType<typeof createTextureSlicer>;
