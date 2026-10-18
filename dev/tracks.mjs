// Validate every course and render a top-down overview: node dev/tracks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../parts/core-sim.js'), 'utf8');
const SIM = new Function(src + '\nreturn SIM;')();

const S = 3; // px per 1/S ... overview scale: 2048 -> 2048/ (8/ S)
const CELL = 400, SC = CELL / 2048;
const cols = 3, rows = Math.ceil(SIM.COURSES.length / cols);
const W = CELL * cols, H = CELL * rows;
const img = new Uint8Array(W * H * 4);
const put = (x, y, r, g, b) => {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
};
for (let i = 0; i < W * H; i++) { img[i * 4] = 20; img[i * 4 + 1] = 24; img[i * 4 + 2] = 32; img[i * 4 + 3] = 255; }

SIM.COURSES.forEach((def, ci) => {
  const t0 = performance.now();
  const T = SIM.buildTrack(def);
  const ox = (ci % cols) * CELL, oy = Math.floor(ci / cols) * CELL;
  const minR = Math.min(...T.R);
  console.log(`${def.id.padEnd(8)} L=${T.L.toFixed(0)} n=${T.n} clearance=${T.clearance.toFixed(0)} minR=${minR.toFixed(0)} build=${(performance.now() - t0).toFixed(1)}ms`);
  for (const e of T.errors) console.log('   ERROR', e);
  // fill: sample world on a grid, classify by locate (global search is slow; use nearest sample brute force on coarse grid)
  for (let py = 0; py < CELL; py++) {
    for (let px = 0; px < CELL; px++) {
      const wx = px / SC, wy = py / SC;
      let best = 1e18, bi = 0;
      for (let i = 0; i < T.n; i += 2) {
        const d = (T.px[i] - wx) ** 2 + (T.py[i] - wy) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      if (best > 140 * 140) continue;
      const L = SIM.locate(T, wx, wy, bi, {});
      const ad = Math.abs(L.d);
      if (ad < L.hw) {
        let c = [80, 84, 96];
        const df = L.d / L.hw;
        for (const z of T.zones) {
          if (!SIM.inS(T, L.s, z.s0, z.s1)) continue;
          if (z.type === 'wind') { c = [c[0], c[1] + 20, c[2] + 40]; continue; }
          if (df >= z.d0 && df <= z.d1) c = { pit: [200, 60, 160], rough: [140, 100, 60], ice: [170, 220, 255] }[z.type];
        }
        for (const p of T.dash) if (Math.abs(SIM.sdiff(T, L.s, p.s)) < p.len / 2 && Math.abs(L.d - p.d) < p.wid / 2) c = [255, 200, 0];
        for (const p of T.jump) if (Math.abs(SIM.sdiff(T, L.s, p.s)) < p.len / 2 && Math.abs(L.d - p.d) < p.wid / 2) c = [60, 140, 255];
        if (L.s < 10 || L.s > T.L - 2) c = [255, 255, 255];
        put(ox + px, oy + py, ...c);
      } else if (ad < L.hw + SIM.RAIL_W) put(ox + px, oy + py, 230, 200, 60);
    }
  }
  for (const g of T.grid) put(ox + g.x * SC, oy + g.y * SC, 0, 255, 0);
  for (const m of T.mines) { put(ox + m.x * SC, oy + m.y * SC, 255, 0, 0); put(ox + m.x * SC + 1, oy + m.y * SC, 255, 0, 0); }
  // vertex markers + labels as dots count
  def.pts.forEach((p, k) => {
    for (let q = 0; q <= k; q++) put(ox + p[0] * SC + q * 2 - 2, oy + p[1] * SC - 4, 255, 120, 120);
  });
  // direction arrow at start: small trail
  for (let i = 0; i < 12; i++) put(ox + T.px[i] * SC, oy + T.py[i] * SC - 0, 0, 255, 255);
});
fs.mkdirSync(path.join(here, 'preview'), { recursive: true });
writePNG(path.join(here, 'preview/tracks.png'), W, H, img);
console.log('wrote dev/preview/tracks.png');
