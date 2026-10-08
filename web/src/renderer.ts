import { fullscreenVS, mprFS, volumeFS, blitFS } from './shaders';
import type { Mat4, Vec3 } from './math';

export interface Rect { x: number; y: number; w: number; h: number } // device px, GL origin bottom-left

export interface VolumeTexture {
  tex: WebGLTexture;
  dims: [number, number, number];
  spacing: [number, number, number];
  range: [number, number];
  slicesLoaded: number;
  bytes: number;
}

export interface MprParams {
  origin: Vec3; du: Vec3; dv: Vec3; dn: Vec3;
  slabSteps: number; slabMode: number;
  window: [number, number]; invert: boolean;
}

export interface VolumeParams {
  invViewProj: Mat4; camPos: Vec3; boxSize: Vec3;
  cropMin: Vec3; cropMax: Vec3;
  step: number; refStep: number;
  mode: number; window: [number, number]; tf: [number, number];
  opacity: number; iso: number; tint: Vec3;
  resolutionScale: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

class Program {
  prog: WebGLProgram;
  u: Uniforms = {};
  constructor(private gl: WebGL2RenderingContext, fs: string) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, fullscreenVS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      this.u[name] = gl.getUniformLocation(p, name);
    }
  }
  use() { this.gl.useProgram(this.prog); return this.u; }
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private mpr: Program;
  private vol: Program;
  private blit: Program;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private fboSize = [0, 0];
  readonly max3D: number;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    this.mpr = new Program(gl, mprFS);
    this.vol = new Program(gl, volumeFS);
    this.blit = new Program(gl, blitFS);
    this.vao = gl.createVertexArray()!;
    this.fbo = gl.createFramebuffer()!;
    this.fboTex = gl.createTexture()!;
  }

  /** Allocate an empty R16F 3D texture. Throws if the GPU refuses. */
  createVolume(dims: [number, number, number], spacing: [number, number, number], range: [number, number]): VolumeTexture {
    const gl = this.gl;
    if (Math.max(...dims) > this.max3D) throw new Error(`Volume ${dims.join('×')} exceeds MAX_3D_TEXTURE_SIZE ${this.max3D}`);
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, dims[0], dims[1], dims[2]);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      throw new Error(err === gl.OUT_OF_MEMORY ? 'GPU out of memory for this volume size' : `texStorage3D failed (0x${err.toString(16)})`);
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    // WebGL guarantees new texture storage is zero-initialised, so partial streams render cleanly.
    return { tex, dims, spacing, range, slicesLoaded: 0, bytes: dims[0] * dims[1] * dims[2] * 2 };
  }

  uploadSlices(v: VolumeTexture, z: number, count: number, data: Uint16Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, v.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, v.dims[0], v.dims[1], count, gl.RED, gl.HALF_FLOAT, data);
    v.slicesLoaded = Math.max(v.slicesLoaded, z + count);
  }

  deleteVolume(v: VolumeTexture | null | undefined) {
    if (v) this.gl.deleteTexture(v.tex);
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.03, 0.035, 0.045, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private setRect(r: Rect) {
    const gl = this.gl;
    gl.viewport(r.x, r.y, r.w, r.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, r.y, r.w, r.h);
  }

  drawMpr(rect: Rect, volume: VolumeTexture, p: MprParams) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setRect(rect);
    const u = this.mpr.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.tex);
    gl.uniform1i(u.uVol, 0);
    gl.uniform4f(u.uViewport, rect.x, rect.y, rect.w, rect.h);
    gl.uniform3fv(u.uOrigin, p.origin);
    gl.uniform3fv(u.uDU, p.du);
    gl.uniform3fv(u.uDV, p.dv);
    gl.uniform3fv(u.uDN, p.dn);
    gl.uniform1i(u.uSlabSteps, p.slabSteps);
    gl.uniform1i(u.uSlabMode, p.slabMode);
    gl.uniform2f(u.uWindow, p.window[0], p.window[1]);
    gl.uniform1i(u.uInvert, p.invert ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawVolume(rect: Rect, volume: VolumeTexture, p: VolumeParams) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(rect.w * p.resolutionScale));
    const h = Math.max(1, Math.round(rect.h * p.resolutionScale));
    if (this.fboSize[0] !== w || this.fboSize[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      this.fboSize = [w, h];
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    const u = this.vol.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.tex);
    gl.uniform1i(u.uVol, 0);
    gl.uniform4f(u.uViewport, 0, 0, w, h);
    gl.uniformMatrix4fv(u.uInvViewProj, false, p.invViewProj);
    gl.uniform3fv(u.uCamPos, p.camPos);
    gl.uniform3fv(u.uBoxSize, p.boxSize);
    gl.uniform3fv(u.uCropMin, p.cropMin);
    gl.uniform3fv(u.uCropMax, p.cropMax);
    gl.uniform3f(u.uTexel, 1 / volume.dims[0], 1 / volume.dims[1], 1 / volume.dims[2]);
    gl.uniform1f(u.uStep, p.step);
    gl.uniform1f(u.uRefStep, p.refStep);
    gl.uniform1i(u.uMode, p.mode);
    gl.uniform2f(u.uWindow, p.window[0], p.window[1]);
    gl.uniform2f(u.uTF, p.tf[0], p.tf[1]);
    gl.uniform1f(u.uOpacity, p.opacity);
    gl.uniform1f(u.uIso, p.iso);
    gl.uniform3fv(u.uTint, p.tint);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setRect(rect);
    const b = this.blit.use();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(b.uTex, 0);
    gl.uniform4f(b.uViewport, rect.x, rect.y, rect.w, rect.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
