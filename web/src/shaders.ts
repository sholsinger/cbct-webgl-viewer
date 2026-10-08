// Fullscreen triangle; no vertex buffers needed.
export const fullscreenVS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Multi-planar reformat: samples an arbitrary plane through the volume.
export const mprFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec4 uViewport;   // x, y, w, h in device pixels (GL origin = bottom-left)
uniform vec3 uOrigin;     // texture coordinate at the viewport centre
uniform vec3 uDU;         // texture-coordinate step per device pixel → screen right
uniform vec3 uDV;         // texture-coordinate step per device pixel → screen down
uniform vec3 uDN;         // texture-coordinate step along the slab normal
uniform int uSlabSteps;   // samples on each side of the plane (0 = thin slice)
uniform int uSlabMode;    // 0 = MIP, 1 = mean, 2 = MinIP
uniform vec2 uWindow;     // centre, width
uniform bool uInvert;
out vec4 outColor;

bool inside(vec3 p) { return all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0))); }

void main() {
  vec2 c = uViewport.xy + 0.5 * uViewport.zw;
  vec3 tc = uOrigin + uDU * (gl_FragCoord.x - c.x) + uDV * (c.y - gl_FragCoord.y);
  if (!inside(tc)) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float v;
  if (uSlabSteps <= 0) {
    v = texture(uVol, tc).r;
  } else {
    float acc = uSlabMode == 0 ? -1e9 : (uSlabMode == 2 ? 1e9 : 0.0);
    float n = 0.0;
    for (int i = -uSlabSteps; i <= uSlabSteps; i++) {
      vec3 p = tc + uDN * float(i);
      if (!inside(p)) continue;
      float s = texture(uVol, p).r;
      if (uSlabMode == 0) acc = max(acc, s);
      else if (uSlabMode == 2) acc = min(acc, s);
      else acc += s;
      n += 1.0;
    }
    v = uSlabMode == 1 ? acc / max(n, 1.0) : acc;
  }
  float g = clamp((v - (uWindow.x - 0.5 * uWindow.y)) / max(uWindow.y, 1e-3), 0.0, 1.0);
  if (uInvert) g = 1.0 - g;
  outColor = vec4(vec3(g), 1.0);
}`;

// Ray-marched volume rendering: composite (DVR), maximum intensity, or iso-surface.
export const volumeFS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec4 uViewport;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;      // model space
uniform vec3 uBoxSize;     // model-space extent of the volume (largest side = 1)
uniform vec3 uCropMin;     // texture-space crop box
uniform vec3 uCropMax;
uniform vec3 uTexel;       // 1 / dims
uniform float uStep;       // ray step, model units
uniform float uRefStep;    // one voxel, model units (opacity correction)
uniform int uMode;         // 0 = DVR, 1 = MIP, 2 = iso-surface
uniform vec2 uWindow;      // MIP: centre, width
uniform vec2 uTF;          // DVR: low, high
uniform float uOpacity;    // DVR opacity scale
uniform float uIso;        // iso-surface threshold
uniform vec3 uTint;        // surface colour
out vec4 outColor;

float sampleVol(vec3 tc) { return texture(uVol, tc).r; }

vec3 gradient(vec3 tc) {
  vec3 d = uTexel;
  vec3 g = vec3(
    sampleVol(tc + vec3(d.x, 0, 0)) - sampleVol(tc - vec3(d.x, 0, 0)),
    sampleVol(tc + vec3(0, d.y, 0)) - sampleVol(tc - vec3(0, d.y, 0)),
    sampleVol(tc + vec3(0, 0, d.z)) - sampleVol(tc - vec3(0, 0, d.z)));
  // Chain rule: texture-space gradient → model-space gradient.
  return g / (uBoxSize * 2.0 * d);
}

vec3 shade(vec3 base, vec3 n, vec3 viewDir) {
  vec3 L = -viewDir;           // headlight
  float diff = abs(dot(n, L));
  float spec = pow(max(dot(n, L), 0.0), 48.0);
  return base * (0.22 + 0.78 * diff) + vec3(0.25 * spec);
}

vec3 tfColor(float t) {
  vec3 c0 = vec3(0.55, 0.22, 0.12);
  vec3 c1 = vec3(0.93, 0.80, 0.62);
  vec3 c2 = vec3(1.0, 0.98, 0.94);
  return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, t * 2.0 - 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 nearP = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = uCamPos;
  vec3 rd = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);

  vec3 bmin = (uCropMin - 0.5) * uBoxSize;
  vec3 bmax = (uCropMax - 0.5) * uBoxSize;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tFar = min(min(tmax.x, tmax.y), tmax.z);

  vec3 bg = mix(vec3(0.05, 0.06, 0.08), vec3(0.13, 0.15, 0.19), gl_FragCoord.y / (uViewport.y + uViewport.w));
  if (tNear >= tFar) { outColor = vec4(bg, 1.0); return; }

  float t = tNear + hash(gl_FragCoord.xy) * uStep;
  vec4 acc = vec4(0.0);
  float mip = -1e9;
  float prevV = -1e9;
  float prevT = t;

  for (int i = 0; i < 8192; i++) {
    if (t > tFar) break;
    vec3 p = ro + rd * t;
    vec3 tc = p / uBoxSize + 0.5;
    float v = sampleVol(tc);

    if (uMode == 1) {
      mip = max(mip, v);
    } else if (uMode == 2) {
      if (v >= uIso) {
        // Refine the crossing by bisection between the previous and current sample.
        float a = prevT, b = t;
        for (int k = 0; k < 6; k++) {
          float m = 0.5 * (a + b);
          if (sampleVol((ro + rd * m) / uBoxSize + 0.5) >= uIso) b = m; else a = m;
        }
        vec3 hp = (ro + rd * b) / uBoxSize + 0.5;
        vec3 n = -normalize(gradient(hp) + 1e-6);
        acc = vec4(shade(uTint, n, rd), 1.0);
        break;
      }
      prevV = v;
      prevT = t;
    } else {
      float a = smoothstep(uTF.x, uTF.y, v);
      if (a > 0.004) {
        float alpha = 1.0 - pow(1.0 - clamp(a * uOpacity, 0.0, 0.999), uStep / uRefStep);
        vec3 g = gradient(tc);
        float gl = length(g);
        vec3 col = tfColor(a);
        if (gl > 1e-4) col = shade(col, -g / gl, rd);
        acc.rgb += (1.0 - acc.a) * alpha * col;
        acc.a += (1.0 - acc.a) * alpha;
        if (acc.a > 0.985) break;
      }
    }
    t += uStep;
  }

  if (uMode == 1) {
    float g = clamp((mip - (uWindow.x - 0.5 * uWindow.y)) / max(uWindow.y, 1e-3), 0.0, 1.0);
    outColor = vec4(mix(bg, vec3(g), g > 0.0 ? 1.0 : 0.0), 1.0);
  } else {
    outColor = vec4(acc.rgb + (1.0 - acc.a) * bg, 1.0);
  }
}`;

// Upscale the offscreen 3D render into its viewport.
export const blitFS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uViewport;
out vec4 outColor;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  outColor = texture(uTex, uv);
}`;
