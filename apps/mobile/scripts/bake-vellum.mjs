#!/usr/bin/env node
/**
 * Bakes the Act 1 / fallback-tier vellum plate from the locked shader.
 *
 * This is the SAME fragment shader Act 2 runs live in Skia, frozen at one drift
 * phase. Keeping the bake in-repo is the only thing preventing the static tier
 * and the live tier from drifting apart.
 *
 * Offline tool. Requires Playwright (already at the workspace root) and cwebp
 * (`brew install webp`). Not part of any build; the output is committed.
 *
 *   node apps/mobile/scripts/bake-vellum.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "../assets/images");
const OUT_PNG = join(OUT_DIR, "vellum-plate.png");
const OUT_WEBP = join(OUT_DIR, "vellum-plate.webp");

// Locked in the atmosphere spec section 4.1. Do not tune these here.
const GROUND = { material: 1.65, drama: 0.4, warmth: 0.82, leafScale: 1.9, grain: 0.024 };
// The frozen drift phase, in shader seconds. Arbitrary but fixed: changing it
// re-frames the light, so a re-bake at a different phase is a visual change.
const PHASE = 12.0;
// 3x of a 414pt phone. `resizeMode="cover"` handles every other geometry.
const WIDTH = 1242;
const HEIGHT = 2688;
// q95 keeps the grain (measured: high-frequency energy 0.79 vs 0.70 in the
// source PNG). q92 halves it, q85 loses 80% of it.
const QUALITY = 95;

const FRAGMENT = `
precision highp float;
uniform vec2 uRes, uD1, uD2;
uniform float uMat, uDrama, uWarm, uScale, uGrain;
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm5(vec2 p){ float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return v / 0.96875; }
float fbm3(vec2 p){ float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = p * 2.11 + vec2(3.7, 11.9); a *= 0.5; } return v / 0.875; }
vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; uv.y = 1.0 - uv.y;
  float ar = uRes.y / uRes.x;
  vec2 p = vec2(uv.x, uv.y * ar);

  float m = uMat;
  vec3 base = vec3(0.936, 0.914, 0.884);
  base += vec3((fbm5(p * 3.1) - 0.5) * 0.072 * m);
  base += vec3((fbm5(p * 11.0) - 0.5) * 0.026 * m);
  base += vec3((vnoise(vec2(p.x * 52.0, p.y * 4.0)) - 0.5) * 0.020 * m);
  base += vec3(pow(clamp(fbm3(p * 22.0), 0.0, 1.0), 3.0) * 0.040 * m) * vec3(1.0, 0.93, 0.77);
  base  = mix(base, vec3(0.800, 0.672, 0.418), smoothstep(0.88, 0.995, vnoise(p * 64.0)) * 0.13 * m);

  float dK = uDrama, sc = uScale;
  vec2 r = rot(p, -0.44);
  float f1 = fbm3(vec2(r.x * 4.2 / sc, r.y * 7.0 / sc) + uD1);
  float f2 = fbm3(vec2(r.x * 8.6 / sc, r.y * 13.4 / sc) - uD2);
  float leaf = smoothstep(mix(0.36, 0.44, dK), mix(0.70, 0.56, dK), f1 * 0.70 + f2 * 0.34);
  float ramp = clamp(1.24 - (p.x * 0.40 + p.y * 0.34), 0.0, 1.0);
  float la = clamp(leaf * (0.50 + 0.50 * ramp), 0.0, 1.0);

  vec3 wg = mix(vec3(0.996, 1.000, 1.010), vec3(1.026, 1.002, 0.952), uWarm);
  vec3 sT = mix(vec3(0.948, 0.938, 0.926), vec3(0.796, 0.778, 0.766), dK)
          * mix(vec3(1.0), vec3(1.008, 0.999, 0.980), uWarm);
  vec3 lT = mix(vec3(1.030, 1.020, 1.002), vec3(1.118, 1.082, 1.000), dK) * wg;
  vec3 col = base * mix(sT, lT, la);
  col += pow(la, mix(3.0, 4.4, dK)) * mix(vec3(0.026, 0.021, 0.012), vec3(0.072, 0.058, 0.030), dK);

  float shade = smoothstep(0.15, 0.95, fbm5(p * 1.9 - uD2 * 0.5));
  col *= mix(vec3(1.0), vec3(0.948, 0.938, 0.940), (1.0 - shade) * (0.10 + 0.16 * dK));

  // Static grain, one cell per 1.25 device px at this bake density. Never animated.
  vec2 cell = floor(gl_FragCoord.xy / 1.25);
  col *= 1.0 - (hash21(cell) - 0.5) * uGrain;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on("console", (message) => {
  if (/SHADER|LINK/.test(message.text())) errors.push(message.text());
});

await page.setContent(
  `<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>` +
    `<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>`,
);

await page.evaluate(
  ({ width, height, fragment, ground, phase }) => {
    const canvas = document.getElementById("c");
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.log(`SHADER: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(
      program,
      compile(gl.VERTEX_SHADER, "attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}"),
    );
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.log(`LINK: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);

    const at = (name) => gl.getUniformLocation(program, name);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(at("uRes"), width, height);
    const t1 = phase / 38;
    const t2 = phase / 47;
    gl.uniform2f(at("uD1"), Math.sin(t1 * 6.2831) * 0.375, Math.cos(t1 * 6.2831) * 0.275);
    gl.uniform2f(at("uD2"), Math.cos(t2 * 6.2831) * 0.36, Math.sin(t2 * 6.2831) * 0.51);
    gl.uniform1f(at("uMat"), ground.material);
    gl.uniform1f(at("uDrama"), ground.drama);
    gl.uniform1f(at("uWarm"), ground.warmth);
    gl.uniform1f(at("uScale"), ground.leafScale);
    gl.uniform1f(at("uGrain"), ground.grain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
  { width: WIDTH, height: HEIGHT, fragment: FRAGMENT, ground: GROUND, phase: PHASE },
);

await page.locator("#c").screenshot({ path: OUT_PNG });
await browser.close();

if (errors.length > 0) {
  throw new Error(`shader failed to build:\n${errors.join("\n")}`);
}

execFileSync("cwebp", ["-q", String(QUALITY), OUT_PNG, "-o", OUT_WEBP, "-quiet"]);
unlinkSync(OUT_PNG);

const kb = statSync(OUT_WEBP).size / 1024;
console.log(`baked ${WIDTH}x${HEIGHT} @ q${QUALITY} -> ${OUT_WEBP} (${kb.toFixed(0)} KB)`);
if (kb > 420) {
  throw new Error(`plate is ${kb.toFixed(0)} KB, over the 420 KB budget`);
}
