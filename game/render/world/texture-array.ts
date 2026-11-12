import * as THREE from 'three';

/**
 * A texture array filled from one image per layer, all the same size. three.js allocates the storage (Source.dataReady =
 * false); each layer is copied in as its image arrives, and the mip chain is built once all are in. Colour arrays (sRGB) go
 * through a small staging texture and a GPU copy, because writing into part of an sRGB texture is 10-20x slower than a whole
 * upload in Chrome on Metal (see game/render/gpu/texture-slicer.ts). Images are decoded off the main thread (ImageBitmap).
 */
export function loadTextureArray(renderer: THREE.WebGLRenderer, urls: readonly string[], options: { size: number; srgb?: boolean; anisotropy?: number }) {
  const gl = renderer.getContext() as WebGL2RenderingContext, { size, srgb = false } = options;
  const texture = new THREE.DataArrayTexture(null, size, size, urls.length);
  texture.format = THREE.RGBAFormat; texture.type = THREE.UnsignedByteType;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = options.anisotropy ?? 4;
  texture.source.dataReady = false; texture.needsUpdate = true;
  const loader = new THREE.ImageBitmapLoader();
  loader.setOptions({ premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
  let staging: WebGLTexture | null = null, readBuffer: WebGLFramebuffer | null = null, remaining = urls.length;
  const ready = new Promise<THREE.DataArrayTexture>((resolve, reject) => {
    urls.forEach((url, layer) => loader.load(url, bitmap => {
      try {
        renderer.initTexture(texture);
        const target = (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture!;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        if (srgb) {
          if (!staging) { staging = gl.createTexture(); readBuffer = gl.createFramebuffer(); }
          renderer.state.bindTexture(gl.TEXTURE_2D, staging);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBuffer);
          gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, staging, 0);
          renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, target);
          gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, size, size);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
        } else {
          renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, target);
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        }
        bitmap.close();
        if (--remaining === 0) {
          renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, target);
          gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
          if (staging) gl.deleteTexture(staging); if (readBuffer) gl.deleteFramebuffer(readBuffer); staging = null; readBuffer = null;
          resolve(texture);
        }
        renderer.state.unbindTexture();
      } catch (error) { reject(error); }
    }, undefined, reject));
  });
  return { texture, ready };
}
