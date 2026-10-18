// Headless tests + visual previews for parts/cars.js
//   node dev/test-cars.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG, upscale } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const previewDir = path.join(here, 'preview');
fs.mkdirSync(previewDir, { recursive: true });

let failures = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}

// ---- load module headlessly (no window/document) ----
const src = fs.readFileSync(path.join(root, 'parts/cars.js'), 'utf8');
ok(typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined', 'test runs without DOM');
const CARS = new Function(src + '\nreturn CARS;')();
ok(CARS && typeof CARS.buildSheet === 'function', 'CARS.buildSheet exists');
ok(/^\s*(\/\/[^\n]*\n\s*)*const CARS = \(\(\) => \{/m.test(src), 'single top-level const CARS IIFE');
// exactly one top-level declaration: every non-comment column-0 line is the IIFE head or tail
{
  const top = src.split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('//'));
  ok(top.length === 2 && top[0].startsWith('const CARS = (() => {') && top[1] === '})();', `only one top-level statement (${JSON.stringify(top)})`);
}
// bare V8 context: no window/document/console/performance/OffscreenCanvas/ImageData at all.
// Loading AND building must work, and the script must add exactly one global binding.
{
  const ctx = vm.createContext(Object.create(null));
  const g0 = new Set(Object.getOwnPropertyNames(vm.runInContext('globalThis', ctx)));
  let err = null;
  try {
    vm.runInContext(src, ctx, { filename: 'cars.js' });
    vm.runInContext("CARS.buildSheet('drone3', { pxPerUnit: 2, pitchDeg: 12 })", ctx);
  } catch (e) { err = e; }
  ok(!err, `loads + builds in a bare context (${err && err.message})`);
  const added = Object.getOwnPropertyNames(vm.runInContext('globalThis', ctx)).filter((k) => !g0.has(k));
  ok(added.length === 0, `no global properties added (${added})`);
  ok(vm.runInContext('typeof CARS', ctx) === 'object', 'CARS is a script-scope binding');
  ok(vm.runInContext("typeof SHAPES + typeof DESIGNS + typeof buildSheet", ctx) === 'undefinedundefinedundefined', 'internals do not leak');
}

const KEYS = ['comet', 'lynx', 'bison', 'hornet', 'drone0', 'drone1', 'drone2', 'drone3', 'drone4', 'drone5'];
ok(KEYS.every((k) => CARS.DESIGNS[k]), 'all 10 designs present');
for (const k of KEYS) {
  const d = CARS.DESIGNS[k];
  ok(typeof d.name === 'string' && d.name.length > 0 && typeof d.shape === 'string' && d.colors && typeof d.colors === 'object', `design ${k} has name/shape/colors`);
}
ok(new Set(KEYS.filter((k) => k.startsWith('drone')).map((k) => CARS.DESIGNS[k].shape)).size === 1, 'drones share one shape');

const NEAR = { pxPerUnit: 4, pitchDeg: 28 };
const FAR = { pxPerUnit: 2, pitchDeg: 12 };

// ---- timing: full build from a cold cache ----
CARS.clearCache();
const t0 = performance.now();
const sheets = {};
for (const k of KEYS) sheets[k] = { near: CARS.buildSheet(k, NEAR), far: CARS.buildSheet(k, FAR) };
const buildMs = performance.now() - t0;
console.log(`build all ${KEYS.length} designs x 2 sheets: ${buildMs.toFixed(0)} ms`);
ok(buildMs < 1500, `build time ${buildMs.toFixed(0)} ms < 1500 ms`);

// determinism
{
  CARS.clearCache();
  const again = CARS.buildSheet('comet', NEAR);
  const a = sheets.comet.near.pixels, b = again.pixels;
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  ok(same, 'deterministic rebuild (comet near)');
}

// ---- structural validation ----
function alphaAt(sh, x, y) { return sh.pixels[(y * sh.width + x) * 4 + 3]; }

function validate(k, label, sh, opts) {
  const tag = `${k}/${label}`;
  const YS = 32, NB = 3;
  ok(sh.key === k, `${tag}: key`);
  ok(sh.pxPerUnit === opts.pxPerUnit && sh.pitchDeg === opts.pitchDeg, `${tag}: pxPerUnit/pitchDeg echoed`);
  ok(sh.yawSteps === YS && sh.banks === NB, `${tag}: yawSteps=${sh.yawSteps} banks=${sh.banks}`);
  ok(Number.isInteger(sh.frameW) && Number.isInteger(sh.frameH) && sh.frameW > 0 && sh.frameH > 0, `${tag}: frame size ints`);
  ok(sh.pixels instanceof Uint8ClampedArray && sh.pixels.length === sh.width * sh.height * 4, `${tag}: pixels sized width*height*4`);
  ok(Number.isInteger(sh.anchorX) && Number.isInteger(sh.anchorY) && sh.anchorX > 0 && sh.anchorX < sh.frameW && sh.anchorY > 0 && sh.anchorY < sh.frameH, `${tag}: anchor inside frame (${sh.anchorX},${sh.anchorY})`);
  // alpha strictly 0/255
  let badAlpha = 0;
  for (let i = 3; i < sh.pixels.length; i += 4) if (sh.pixels[i] !== 0 && sh.pixels[i] !== 255) badAlpha++;
  ok(badAlpha === 0, `${tag}: alpha only 0/255 (${badAlpha} bad)`);
  // frames
  const seen = new Set();
  ok(Array.isArray(sh.exhaust) && sh.exhaust.length === YS, `${tag}: exhaust has ${YS} yaw rows`);
  let nozzleCount = -1;
  for (let i = 0; i < YS; i++) {
    ok(Array.isArray(sh.exhaust[i]) && sh.exhaust[i].length === NB, `${tag}: exhaust[${i}] has ${NB} banks`);
    for (let b = 0; b < NB; b++) {
      const f = sh.frame(i, b);
      ok(f && Number.isInteger(f.sx) && Number.isInteger(f.sy), `${tag}: frame(${i},${b}) ints`);
      ok(f.sx >= 0 && f.sy >= 0 && f.sx + sh.frameW <= sh.width && f.sy + sh.frameH <= sh.height, `${tag}: frame(${i},${b}) inside sheet`);
      const id = f.sx + ',' + f.sy;
      ok(!seen.has(id), `${tag}: frame(${i},${b}) unique`);
      seen.add(id);
      ok(f.sx % sh.frameW === 0 && f.sy % sh.frameH === 0, `${tag}: frame(${i},${b}) on grid`);
      // non-empty and nothing at the border (=> nothing clipped)
      let opaque = 0, border = 0;
      for (let y = 0; y < sh.frameH; y++)
        for (let x = 0; x < sh.frameW; x++) {
          if (alphaAt(sh, f.sx + x, f.sy + y)) {
            opaque++;
            if (x === 0 || y === 0 || x === sh.frameW - 1 || y === sh.frameH - 1) border++;
          }
        }
      ok(opaque > 50, `${tag}: frame(${i},${b}) non-empty (${opaque})`);
      ok(border === 0, `${tag}: frame(${i},${b}) touches border (${border} px) — clipped?`);
      const ex = sh.exhaust[i][b];
      ok(Array.isArray(ex) && ex.length > 0, `${tag}: exhaust[${i}][${b}] non-empty array`);
      if (nozzleCount < 0) nozzleCount = ex.length;
      ok(ex.length === nozzleCount, `${tag}: exhaust count stable`);
      for (const e of ex) {
        ok(Number.isFinite(e.x) && Number.isFinite(e.y) && typeof e.visible === 'boolean', `${tag}: exhaust entry shape`);
        ok(e.x >= 0 && e.x <= sh.frameW && e.y >= 0 && e.y <= sh.frameH, `${tag}: exhaust (${e.x},${e.y}) inside frame`);
      }
    }
  }
  // frame() wraps yaw
  ok(sh.frame(32, 1).sx === sh.frame(0, 1).sx && sh.frame(-1, 1).sy === sh.frame(31, 1).sy, `${tag}: frame() wraps yaw`);

  // ---- conventions ----
  const ax = sh.anchorX, ay = sh.anchorY;
  const mid = 1;
  const avg = (arr, f) => arr.reduce((s, e) => s + f(e), 0) / arr.length;
  // yaw 0: tail toward camera -> nozzles near (lower on screen than at yaw 16) and visible;
  // yaw 16: nose toward camera -> nozzles far (higher, above the anchor) and hidden behind the hull
  ok(sh.exhaust[0][mid].every((e) => e.visible), `${tag}: yaw0 nozzles visible`);
  ok(sh.exhaust[16][mid].every((e) => !e.visible), `${tag}: yaw16 nozzles hidden`);
  ok(avg(sh.exhaust[0][mid], (e) => e.y) > avg(sh.exhaust[16][mid], (e) => e.y) + 4 * opts.pxPerUnit, `${tag}: yaw0 nozzles lower than yaw16`);
  ok(avg(sh.exhaust[16][mid], (e) => e.y) < ay, `${tag}: yaw16 nozzles above anchor`);
  ok(Math.abs(avg(sh.exhaust[0][mid], (e) => e.x) - ax) < 1 && Math.abs(avg(sh.exhaust[16][mid], (e) => e.x) - ax) < 1, `${tag}: yaw0/16 nozzles centred`);
  // side views: nozzles visible (flame trails out behind)
  ok(sh.exhaust[8][mid].some((e) => e.visible) && sh.exhaust[24][mid].some((e) => e.visible), `${tag}: side-view nozzles visible`);
  // yaw 8: nose screen-right -> nozzles left of anchor; yaw 24 opposite
  ok(avg(sh.exhaust[8][mid], (e) => e.x) < ax - 4 * opts.pxPerUnit, `${tag}: yaw8 tail on the left (nose right)`);
  ok(avg(sh.exhaust[24][mid], (e) => e.x) > ax + 4 * opts.pxPerUnit, `${tag}: yaw24 tail on the right (nose left)`);
  // nose point projection (model +X)
  const nose = (i) => CARS._project(k, opts, i, mid, [11, 0, 2.6]);
  ok(nose(8).x > ax + 8 * opts.pxPerUnit, `${tag}: yaw8 nose right`);
  ok(nose(24).x < ax - 8 * opts.pxPerUnit, `${tag}: yaw24 nose left`);
  ok(nose(0).y < nose(16).y - 4 * opts.pxPerUnit && nose(0).y < ay, `${tag}: yaw0 nose far (up), yaw16 nose near (down)`);
  ok(nose(4).x > ax && nose(4).y < ay, `${tag}: yaw4 nose up-right (clockwise)`);
  // yaw 8: the near flank is the car's right side (+Y): it is closer to the camera
  ok(CARS._project(k, opts, 8, mid, [0, 5, 3]).depth < CARS._project(k, opts, 8, mid, [0, -5, 3]).depth, `${tag}: yaw8 +Y side nearer`);
  // bank: positive = right side dips. Seen from behind (yaw 0) the right side is screen-right.
  const exR = (b) => sh.exhaust[0][b].reduce((m, e) => (e.x > m.x ? e : m));
  const exL = (b) => sh.exhaust[0][b].reduce((m, e) => (e.x < m.x ? e : m));
  if (sh.exhaust[0][2].length > 1) {
    ok(exR(2).y > exL(2).y + 0.5, `${tag}: bank +18 right (screen-right) nozzle lower`);
    ok(exR(0).y < exL(0).y - 0.5, `${tag}: bank -18 left nozzle lower`);
  }
  const rp = (b) => CARS._project(k, opts, 0, b, [0, 6, 3]).y;
  ok(rp(2) > rp(1) && rp(0) < rp(1), `${tag}: bank +18 dips right side (pixels down)`);
  // mirror consistency of silhouettes: frame(i,b) ~ mirror(frame(32-i, 2-b)) about the anchor
  let diff = 0, tot = 0;
  for (const [i, b] of [[4, 1], [8, 2], [12, 0], [2, 2]]) {
    const f1 = sh.frame(i, b), f2 = sh.frame((32 - i) % 32, 2 - b);
    for (let y = 0; y < sh.frameH; y++)
      for (let x = 0; x < sh.frameW; x++) {
        const a1 = alphaAt(sh, f1.sx + x, f1.sy + y) > 0;
        const mx = 2 * ax - 1 - x;
        const a2 = mx >= 0 && mx < sh.frameW ? alphaAt(sh, f2.sx + mx, f2.sy + y) > 0 : false;
        if (a1 || a2) { tot++; if (a1 !== a2) diff++; }
      }
  }
  ok(diff / tot < 0.04, `${tag}: mirrored yaw/bank silhouettes agree (${(100 * diff / tot).toFixed(1)}% differ)`);
  return nozzleCount;
}

for (const k of KEYS) {
  const n1 = validate(k, 'near', sheets[k].near, NEAR);
  const n2 = validate(k, 'far', sheets[k].far, FAR);
  ok(n1 === n2, `${k}: same nozzle count near/far`);
  ok(sheets[k].far.frameW < sheets[k].near.frameW, `${k}: far frames smaller`);
}
// nozzle counts by archetype
ok(sheets.comet.near.exhaust[0][1].length === 2, 'comet: twin engines');
ok(sheets.bison.near.exhaust[0][1].length === 4, 'bison: four nozzles');
ok(sheets.hornet.near.exhaust[0][1].length === 1, 'hornet: single nozzle');
// distinct colours per drone
{
  const colOf = (k) => { const s = sheets[k].near, f = s.frame(0, 1); const m = new Map();
    for (let y = 0; y < s.frameH; y++) for (let x = 0; x < s.frameW; x++) { const i = ((f.sy + y) * s.width + f.sx + x) * 4; if (s.pixels[i + 3]) { const c = s.pixels[i] << 16 | s.pixels[i + 1] << 8 | s.pixels[i + 2]; m.set(c, (m.get(c) || 0) + 1); } }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
  const doms = KEYS.map(colOf);
  ok(new Set(doms).size === KEYS.length, 'every design has a distinct dominant colour');
}
// colours per frame / shade count sanity (3-4 shades per material + outline)
{
  const s = sheets.comet.near, f = s.frame(4, 1), cols = new Set();
  for (let y = 0; y < s.frameH; y++) for (let x = 0; x < s.frameW; x++) { const i = ((f.sy + y) * s.width + f.sx + x) * 4; if (s.pixels[i + 3]) cols.add(s.pixels[i] << 16 | s.pixels[i + 1] << 8 | s.pixels[i + 2]); }
  ok(cols.size >= 10 && cols.size <= 48, `comet frame palette size ${cols.size} in [10,48]`);
}

// byte order: pixels are RGBA bytes (= packed ABGR little-endian). Dominant hull colours must
// keep their hue: comet blue (b > r), lynx gold (r > b), bison green (g > r, g > b).
{
  const dom = (k) => { const s = sheets[k].near, f = s.frame(0, 1), m = new Map();
    for (let y = 0; y < s.frameH; y++) for (let x = 0; x < s.frameW; x++) { const i = ((f.sy + y) * s.width + f.sx + x) * 4; if (s.pixels[i + 3]) { const key = s.pixels[i] + ',' + s.pixels[i + 1] + ',' + s.pixels[i + 2]; m.set(key, (m.get(key) || 0) + 1); } }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number); };
  const [cr, , cb] = dom('comet'), [lr, , lb] = dom('lynx'), [br, bg, bb] = dom('bison');
  ok(cb > cr && lr > lb && bg > br && bg > bb, `RGBA byte order (comet ${dom('comet')}, lynx ${dom('lynx')}, bison ${dom('bison')})`);
  const u32 = new Uint32Array(sheets.comet.near.pixels.buffer);
  let opq = 0; for (let i = 0; i < u32.length; i++) if (u32[i] >>> 24) { opq++; if ((u32[i] >>> 24) !== 255) { opq = -1e9; break; } }
  ok(opq > 0, 'packed Uint32 view: alpha in the top byte');
}
// frame(): rounding, wrap, clamp, and safe fallbacks
{
  const s = sheets.comet.near;
  ok(s.frame(0.4, 1) === s.frame(0, 1) && s.frame(31.6, 1) === s.frame(0, 1) && s.frame(-33, 1) === s.frame(31, 1), 'frame(): yaw rounds + wraps');
  ok(s.frame(3, -5) === s.frame(3, 0) && s.frame(3, 9) === s.frame(3, 2) && s.frame(3, 1.4) === s.frame(3, 1), 'frame(): bank rounds + clamps');
  ok(s.frame(NaN, 1) === s.frame(0, 1) && s.frame(3) === s.frame(3, 1) && s.frame(3, NaN) === s.frame(3, 1), 'frame(): NaN yaw -> 0, missing bank -> middle');
}
// opts: defaults and invalid-value fallbacks
{
  const d = CARS.buildSheet('drone0');
  ok(d.pxPerUnit === 4 && d.pitchDeg === 28 && d.yawSteps === 32 && d.banks === 3, 'buildSheet(key) uses the default opts');
  const bad = CARS.buildSheet('drone0', { pxPerUnit: NaN, pitchDeg: undefined, yawSteps: 'x', bankDeg: [] });
  ok(bad.pxPerUnit === 4 && bad.pitchDeg === 28 && bad.yawSteps === 32 && bad.banks === 3 && bad.width === d.width, 'invalid opts fall back to defaults');
  const custom = CARS.buildSheet('hornet', { pxPerUnit: 3, pitchDeg: 20, yawSteps: 16, bankDeg: [-10, 10] });
  ok(custom.yawSteps === 16 && custom.banks === 2 && custom.exhaust.length === 16 && custom.exhaust[0].length === 2 &&
    custom.frame(15, 1).sx + custom.frameW <= custom.width && custom.frame(15, 1).sy + custom.frameH <= custom.height, 'custom yawSteps/bankDeg honoured');
  let threw = false; try { CARS.buildSheet('nope'); } catch (e) { threw = true; }
  ok(threw, 'unknown design key throws');
  ok(sheets.comet.near.exhaust !== CARS.buildSheet('comet', NEAR).exhaust, 'exhaust arrays are per-sheet copies');
}
// exhaust: exact mirror symmetry (frame(i,b) <-> frame(32-i, 2-b) about anchorX)
for (const k of KEYS) for (const [lab, s] of [['near', sheets[k].near], ['far', sheets[k].far]]) {
  let bad = 0;
  for (let i = 0; i < 32; i++) for (let b = 0; b < 3; b++) {
    const A = s.exhaust[i][b], B = s.exhaust[(32 - i) % 32][2 - b];
    if (A.filter((e) => e.visible).length !== B.filter((e) => e.visible).length) bad++;
    const ax = A.map((e) => e.x).sort((p, q) => p - q), bx = B.map((e) => 2 * s.anchorX - e.x).sort((p, q) => p - q);
    if (ax.some((x, j) => Math.abs(x - bx[j]) > 0.02)) bad++;
  }
  ok(bad === 0, `${k}/${lab}: exhaust mirror-symmetric (${bad} mismatches)`);
}
// pixel-art cleanliness: few 8-isolated pixels (a colour that appears nowhere in its 8-neighbourhood;
// intentional 1-px details such as tail lights / nozzle throats / canopy glints are a small minority)
for (const k of KEYS) for (const [lab, s, lim] of [['near', sheets[k].near, 0.004], ['far', sheets[k].far, 0.02]]) {
  const u = new Uint32Array(s.pixels.buffer), W = s.width;
  let iso = 0, opq = 0;
  for (let y = 1; y < s.height - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, c = u[i];
    if (!(c >>> 24)) continue;
    opq++;
    let same = false;
    for (let dy = -1; dy <= 1 && !same; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && u[i + dy * W + dx] === c) { same = true; break; }
    if (!same) iso++;
  }
  ok(iso / opq < lim, `${k}/${lab}: isolated pixels ${(100 * iso / opq).toFixed(2)}% < ${100 * lim}%`);
}

// ---- previews ----
const BG = [46, 50, 66], BG2 = [58, 62, 80];
function blank(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = ((x >> 3) + (y >> 3)) & 1 ? BG : BG2, i = (y * w + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return out;
}
function blit(dst, dw, sh, f, dx, dy, mark) {
  for (let y = 0; y < sh.frameH; y++) for (let x = 0; x < sh.frameW; x++) {
    const si = ((f.sy + y) * sh.width + f.sx + x) * 4;
    if (!sh.pixels[si + 3]) continue;
    const di = ((dy + y) * dw + dx + x) * 4;
    dst[di] = sh.pixels[si]; dst[di + 1] = sh.pixels[si + 1]; dst[di + 2] = sh.pixels[si + 2]; dst[di + 3] = 255;
  }
  if (mark) { // anchor tick marks just outside the frame box
    const put = (x, y, c) => { const di = (y * dw + x) * 4; dst[di] = c[0]; dst[di + 1] = c[1]; dst[di + 2] = c[2]; };
    put(dx + sh.anchorX, dy + sh.frameH, [255, 80, 80]);
    put(dx - 1, dy + sh.anchorY, [255, 80, 80]);
  }
}
function frameGrid(sh, gap) {
  const cols = 8, rows = 12;
  const w = cols * (sh.frameW + gap) + gap, h = rows * (sh.frameH + gap) + gap;
  const img = blank(w, h);
  for (let b = 0; b < 3; b++) for (let i = 0; i < 32; i++) {
    const cx = i % 8, cy = b * 4 + (i >> 3);
    blit(img, w, sh, sh.frame(i, b), gap + cx * (sh.frameW + gap), gap + cy * (sh.frameH + gap), true);
  }
  return { w, h, img };
}
function hcat(parts, gap) {
  const w = parts.reduce((s, p) => s + p.w + gap, gap), h = Math.max(...parts.map((p) => p.h)) + 2 * gap;
  const img = blank(w, h);
  let x0 = gap;
  for (const p of parts) {
    for (let y = 0; y < p.h; y++) img.set(p.img.subarray(y * p.w * 4, (y + 1) * p.w * 4), ((y + gap) * w + x0) * 4);
    x0 += p.w + gap;
  }
  return { w, h, img };
}
for (const k of KEYS) {
  const near = frameGrid(sheets[k].near, 3), far = frameGrid(sheets[k].far, 3);
  const all = hcat([near, far], 4);
  writePNG(path.join(previewDir, `cars-${k}.png`), all.w * 2, all.h * 2, upscale(all.w, all.h, all.img, 2));
}
{
  const yaws = [0, 4, 8, 16];
  const n0 = sheets.comet.near, f0 = sheets.comet.far;
  const cw = Math.max(...KEYS.map((k) => sheets[k].near.frameW)), ch = Math.max(...KEYS.map((k) => sheets[k].near.frameH));
  const fw = Math.max(...KEYS.map((k) => sheets[k].far.frameW)), fh = Math.max(...KEYS.map((k) => sheets[k].far.frameH));
  const gap = 4;
  const w = yaws.length * (cw + gap) + yaws.length * (fw + gap) + gap, h = KEYS.length * (ch + gap) + gap;
  const img = blank(w, h);
  KEYS.forEach((k, r) => {
    yaws.forEach((yi, c) => {
      const s = sheets[k].near;
      blit(img, w, s, s.frame(yi, 1), gap + c * (cw + gap) + ((cw - s.frameW) >> 1), gap + r * (ch + gap) + ((ch - s.frameH) >> 1));
      const t = sheets[k].far;
      blit(img, w, t, t.frame(yi, 1), gap + yaws.length * (cw + gap) + c * (fw + gap), gap + r * (ch + gap) + ((ch - t.frameH) >> 1));
    });
  });
  writePNG(path.join(previewDir, 'cars-lineup.png'), w * 2, h * 2, upscale(w, h, img, 2));
}

console.log(`sheet sizes: near ${sheets.comet.near.width}x${sheets.comet.near.height} (frame ${sheets.comet.near.frameW}x${sheets.comet.near.frameH}), far ${sheets.comet.far.width}x${sheets.comet.far.height} (frame ${sheets.comet.far.frameW}x${sheets.comet.far.frameH})`);
for (const s of ['comet', 'lynx', 'bison', 'hornet', 'drone']) console.log(`mesh ${s}:`, JSON.stringify(CARS._meshStats(s)));
console.log(`${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
