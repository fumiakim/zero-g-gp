// Headless tests + visual previews for parts/themes.js
//   node dev/test-themes.mjs            (all checks + previews)
//   node dev/test-themes.mjs --no-png   (checks only)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG, upscale, u32ToRGBA } from './png.mjs';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const PREV = path.join(DEV, 'preview');
const WANT_PNG = !process.argv.includes('--no-png');
fs.mkdirSync(PREV, { recursive: true });

let fails = 0, passes = 0;
const ok = (cond, msg) => {
  if (cond) passes++;
  else { fails++; console.log('  FAIL', msg); }
};

// ------------------------------------------------------------------ load
const src = fs.readFileSync(path.join(ROOT, 'parts/themes.js'), 'utf8');
ok(!/\b(document|window|AudioContext|navigator|localStorage)\b/.test(src.replace(/\/\/.*$/gm, '')), 'source must not reference DOM/window/audio');
ok(!/^\s*(import|export)\b/m.test(src), 'no import/export');
const topDecls = src.split('\n').filter((l) => /^(const|let|var|function|class)\b/.test(l));
ok(topDecls.length === 1 && /^const THEMES = \(\(\) => \{/.test(topDecls[0]), 'exactly one top-level declaration: const THEMES = (() => {');
ok(typeof globalThis.window === 'undefined', 'test runs headless');
const THEMES = new Function(src + '\nreturn THEMES;')();

ok(JSON.stringify(THEMES.ids) === JSON.stringify(['neon', 'coast', 'desert', 'gale', 'frost', 'inferno']), 'ids');
ok(typeof THEMES.get === 'function', 'get()');

// ------------------------------------------------------------------ helpers
const PAL_RGB = ['road', 'roadAlt', 'roadSeam', 'roadLine', 'railA', 'railB', 'railLight', 'railDark', 'shoulder',
  'startA', 'startB', 'pit', 'pitStripe', 'dash', 'dashDark', 'jump', 'jumpDark', 'rough', 'roughDark', 'ice', 'iceLight'];
const PAL_CSS = ['minimapRoad', 'minimapBg', 'hudAccent'];
const isRGB = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const isCSS = (s) => typeof s === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(s);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const u32rgb = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];

// seam statistic for a grid of colours (get(x,y)->[r,g,b]) of size w×h:
// compare the wrap seam (col w-1 → col 0) with ordinary neighbouring column pairs
function colSeam(w, h, get) {
  const pair = (x0, x1) => { let s = 0; for (let y = 0; y < h; y++) { const a = get(x0, y), b = get(x1, y); s += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); } return s / h; };
  const all = [];
  for (let x = 0; x < w - 1; x++) all.push(pair(x, x + 1));
  const seam = pair(w - 1, 0);
  const sorted = all.slice().sort((a, b) => a - b);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  return { seam, mean, p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted[sorted.length - 1] };
}
// The wrap pair must look like an ordinary neighbouring pair. Tiles with crisp
// outlines (Voronoi cracks, plate edges) can legitimately put the single largest
// edge on the wrap (checked visually: inferno@256 has a crack along x=255|0), so
// a seam within 10% of the largest interior pair passes. A real discontinuity in
// the smooth fields (sea, dunes, snow) lands far above every interior pair.
const seamOK = (s) => s.seam <= Math.max(s.p99, s.mean * 2.5, 2, s.max * 1.1);

// ------------------------------------------------------------------ tiny 3×5 label font (preview only)
const GL = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '-': '000000111000000', '.': '000000000000010', '/': '001001010100100',
  ':': '000010000010000', '=': '000111000111000',
};
function label(img, W, x, y, text, col, k = 2) {
  text = String(text).toUpperCase();
  for (let n = 0; n < text.length; n++) {
    const g = GL[text[n]] || GL[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r * 3 + c] === '1')
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) putRGB(img, W, x + n * 4 * k + c * k + b, y + r * k + a, col);
  }
}
function putRGB(img, W, x, y, c) {
  if (x < 0 || y < 0 || x >= W) return;
  const i = (y * W + x) * 4;
  if (i + 3 >= img.length) return;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = 255;
}
function blit(dst, DW, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const yy = dy + y;
    if (yy < 0) continue;
    const di = (yy * DW + dx) * 4;
    if (di + sw * 4 > dst.length) break;
    dst.set(src.subarray(y * sw * 4, (y + 1) * sw * 4), di);
  }
}
function fillRect(img, W, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) putRGB(img, W, x + i, y + j, c); }

// ------------------------------------------------------------------ fake road (top-down texture) for contrast mock
const ROAD_HALF = 60, RAIL = 6, SHOULDER = 6, LOOP = 1000;
function roadTex(pal, u, v) {
  u = ((u % LOOP) + LOOP) % LOOP;
  const a = Math.abs(v);
  if (a >= ROAD_HALF + RAIL + SHOULDER) return null;
  if (a >= ROAD_HALF + RAIL) return pal.shoulder;
  if (a >= ROAD_HALF) {
    const blk = Math.floor(u / 16), uu = u % 16, outer = a >= ROAD_HALF + RAIL - 2;
    if (outer || uu < 1) return pal.railDark;
    if (uu >= 7 && uu < 9 && a >= ROAD_HALF + 1 && a < ROAD_HALF + 3) return pal.railLight;
    return blk & 1 ? pal.railB : pal.railA;
  }
  // patches
  if (u >= 40 && u < 52) return ((Math.floor(u / 4) + Math.floor((v + 64) / 4)) & 1) ? pal.startA : pal.startB;
  if (u >= 120 && u < 160 && a < 16) { // dash plate with chevrons
    const t = (u - 120 + Math.abs(v) * 0.9) % 12;
    return t < 5 ? pal.dashDark : pal.dash;
  }
  if (u >= 230 && u < 252 && a < 34) return Math.floor((u - 230) / 4) & 1 ? pal.jumpDark : pal.jump;
  if (u >= 300 && u < 560 && v < -36 && v > -58) return ((Math.floor(u + v) >> 3) & 1) ? pal.pitStripe : pal.pit;
  if (u >= 600 && u < 690 && v > 8 && v < 58) {
    const h = Math.sin(Math.floor(u / 4) * 12.9898 + Math.floor(v / 4) * 78.233) * 43758.5453;
    return h - Math.floor(h) < 0.35 ? pal.roughDark : pal.rough;
  }
  if (u >= 740 && u < 830 && v > -42 && v < 18) return ((Math.floor(u - v * 0.5) % 18) < 3) ? pal.iceLight : pal.ice;
  if (a >= ROAD_HALF - 6 && a < ROAD_HALF - 4) return pal.roadLine;
  const pu = u % 32, pv = (v + 64) % 30;
  if (pu < 1 || pv < 1) return pal.roadSeam;
  return ((Math.floor(u / 32) + Math.floor((v + 64) / 30)) & 1) ? pal.roadAlt : pal.road;
}

function topDownStrip(theme, tile, S, len, half) {
  const W = len, H = half * 2, out = new Uint8Array(W * H * 4), pal = theme.palette;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = y - half;
    let c = roadTex(pal, x, v);
    if (!c) c = u32rgb(tile[((y + 37) & (S - 1)) * S + ((x + 91) & (S - 1))]);
    const i = (y * W + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return { W, H, out };
}

// ------------------------------------------------------------------ Mode-7 mock
// Mirrors parts/core-render.js drawFloor: HZ 72, F 192, camera height 26,
// fog smoothstep from z=650 to 2300 (beyond = fog), mip level from
// foot = max(k*1.15, vstep*0.3), 6 box-filtered mip levels, nearest sampling.
const M7 = { HZ: 72, F: 192, CAM_H: 26, FOG0: 650, ZFAR: 2300, MIPS: 6 };
function buildMips(tile, S) {
  const levels = [];
  let cur = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) { const v = tile[i]; cur[i * 3] = v & 255; cur[i * 3 + 1] = (v >>> 8) & 255; cur[i * 3 + 2] = (v >>> 16) & 255; }
  let s = S;
  levels.push({ s, d: cur });
  while (s > 1 && levels.length < M7.MIPS) {
    const n = s >> 1, nd = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let c = 0; c < 3; c++)
      nd[(y * n + x) * 3 + c] = (cur[((2 * y) * s + 2 * x) * 3 + c] + cur[((2 * y) * s + 2 * x + 1) * 3 + c] + cur[((2 * y + 1) * s + 2 * x) * 3 + c] + cur[((2 * y + 1) * s + 2 * x + 1) * 3 + c]) / 4;
    levels.push({ s: n, d: nd });
    cur = nd; s = n;
  }
  return levels;
}
function renderMode7(theme, mips, pano, cam) {
  const W = 384, H = 216, HOR = M7.HZ, F = M7.F, out = new Uint8Array(W * H * 4);
  const pal = theme.palette, fog = theme.fog;
  const fx = Math.cos(cam.th), fy = Math.sin(cam.th), rx = -Math.sin(cam.th), ry = Math.cos(cam.th);
  const pOff = Math.round((cam.th / (2 * Math.PI)) * 1536);
  for (let y = 0; y < HOR; y++) for (let x = 0; x < W; x++) {
    const px = (((pOff + x - 192) % 1536) + 1536) % 1536, si = (y * 1536 + px) * 4, di = (y * W + x) * 4;
    out[di] = pano[si]; out[di + 1] = pano[si + 1]; out[di + 2] = pano[si + 2]; out[di + 3] = 255;
  }
  for (let y = HOR; y < H; y++) {
    const dy = y - HOR + 0.5, d = (cam.h * F) / dy;
    const k = d / F, vstep = (d * d) / (cam.h * F), foot = Math.max(k * 1.15, vstep * 0.3);
    const lvl = Math.min(mips.length - 1, foot <= 1 ? 0 : Math.floor(Math.log2(foot)));
    const m = mips[lvl], sc = m.s / mips[0].s;
    const fa = d >= M7.ZFAR ? 1 : d > M7.FOG0 ? (d - M7.FOG0) / (M7.ZFAR - M7.FOG0) : 0;
    const fogA = fa * fa * (3 - 2 * fa);
    for (let x = 0; x < W; x++) {
      const lat = ((x - 192 + 0.5) * d) / F;
      const wx = cam.x + fx * d + rx * lat, wy = cam.y + fy * d + ry * lat;
      let c = roadTex(pal, wx, wy);
      if (!c) {
        const tx = Math.floor(wx * sc) & (m.s - 1), ty = Math.floor(wy * sc) & (m.s - 1), k = (ty * m.s + tx) * 3;
        c = [m.d[k], m.d[k + 1], m.d[k + 2]];
      }
      const di = (y * W + x) * 4;
      out[di] = c[0] + (fog[0] - c[0]) * fogA; out[di + 1] = c[1] + (fog[1] - c[1]) * fogA; out[di + 2] = c[2] + (fog[2] - c[2]) * fogA; out[di + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ main
const timings = [];
let totalMs = 0;
for (const id of THEMES.ids) {
  console.log(`\n== ${id}`);
  const th = THEMES.get(id);
  ok(th && th.id === id, `${id}: get() returns theme with id`);
  ok(typeof th.name === 'string' && th.name.length > 0 && th.name === th.name.toUpperCase(), `${id}: uppercase name`);
  ok(isRGB(th.fog), `${id}: fog rgb`);
  ok(th.weather === null || ['snow', 'sand', 'embers', 'rain', 'sparkle'].includes(th.weather), `${id}: weather value`);
  ok(isCSS(th.weatherColor), `${id}: weatherColor css`);
  const pal = th.palette;
  for (const k of PAL_RGB) ok(isRGB(pal[k]), `${id}: palette.${k} is [r,g,b]`);
  for (const k of PAL_CSS) ok(isCSS(pal[k]), `${id}: palette.${k} is css`);
  const extra = Object.keys(pal).filter((k) => !PAL_RGB.includes(k) && !PAL_CSS.includes(k));
  ok(extra.length === 0, `${id}: no unknown palette keys (${extra})`);

  // --- road palette contrast rules
  const dRA = dist(pal.road, pal.roadAlt);
  ok(dRA >= 4 && dRA <= 30, `${id}: road/roadAlt subtle (${dRA.toFixed(1)})`);
  ok(luma(pal.roadSeam) < luma(pal.road) - 8, `${id}: seam darker than road`);
  ok(dist(pal.roadLine, pal.road) >= 90, `${id}: roadLine bright vs road (${dist(pal.roadLine, pal.road).toFixed(0)})`);
  ok(Math.max(dist(pal.railA, pal.road), dist(pal.railB, pal.road)) >= 140, `${id}: rails visible vs road`);
  ok(dist(pal.railA, pal.railB) >= 120, `${id}: railA/railB alternate clearly (${dist(pal.railA, pal.railB).toFixed(0)})`);
  ok(dist(pal.startA, pal.startB) >= 200, `${id}: start checker contrast`);
  const zones = { road: pal.road, dash: pal.dash, jump: pal.jump, pit: pal.pit, rough: pal.rough, ice: pal.ice };
  const zk = Object.keys(zones);
  let minZ = 1e9, minPair = '';
  for (let i = 0; i < zk.length; i++) for (let j = i + 1; j < zk.length; j++) {
    const d = dist(zones[zk[i]], zones[zk[j]]);
    if (d < minZ) { minZ = d; minPair = zk[i] + '/' + zk[j]; }
  }
  ok(minZ >= 70, `${id}: zone colours distinct (min ${minZ.toFixed(0)} ${minPair})`);
  for (const [a, b] of [['pit', 'pitStripe'], ['dash', 'dashDark'], ['jump', 'jumpDark'], ['rough', 'roughDark'], ['ice', 'iceLight']])
    ok(dist(pal[a], pal[b]) >= 40, `${id}: ${a}/${b} pattern contrast (${dist(pal[a], pal[b]).toFixed(0)})`);
  for (const z of ['dash', 'jump', 'pit']) ok(dist(pal[z], pal.railA) >= 60 && dist(pal[z], pal.railB) >= 60, `${id}: ${z} differs from rails`);

  // --- ground tile
  const S = 512;
  let t0 = performance.now();
  const tile = th.buildGroundTile(S);
  const tTile = performance.now() - t0;
  t0 = performance.now();
  const pano = th.buildPanorama(1536, 72);
  const tPano = performance.now() - t0;
  totalMs += tTile + tPano;
  timings.push(`${id}: tile ${tTile.toFixed(1)} ms, pano ${tPano.toFixed(1)} ms`);
  ok(tile instanceof Uint32Array && tile.length === S * S, `${id}: tile type/length`);
  let opaque = true;
  for (let i = 0; i < tile.length; i++) if (tile[i] >>> 24 !== 255) { opaque = false; break; }
  ok(opaque, `${id}: tile fully opaque`);
  const tile2 = th.buildGroundTile(S);
  ok(tile2.every((v, i) => v === tile[i]), `${id}: tile deterministic`);
  const tget = (x, y) => u32rgb(tile[y * S + x]);
  const cs = colSeam(S, S, tget);
  const rs = colSeam(S, S, (x, y) => tget(y, x));
  ok(seamOK(cs), `${id}: tile x-seam ${cs.seam.toFixed(1)} (mean ${cs.mean.toFixed(1)} p99 ${cs.p99.toFixed(1)})`);
  ok(seamOK(rs), `${id}: tile y-seam ${rs.seam.toFixed(1)} (mean ${rs.mean.toFixed(1)} p99 ${rs.p99.toFixed(1)})`);
  // isolated single texels (shimmer risk): pixel differing from all 4 neighbours
  let iso = 0;
  const colours = new Set();
  let nearRoad = 0, sumL = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = tile[y * S + x];
    colours.add(v);
    if (v !== tile[y * S + ((x + 1) & (S - 1))] && v !== tile[y * S + ((x - 1) & (S - 1))] && v !== tile[((y + 1) & (S - 1)) * S + x] && v !== tile[((y - 1) & (S - 1)) * S + x]) iso++;
    const c = u32rgb(v);
    sumL += luma(c);
    if (Math.min(dist(c, pal.road), dist(c, pal.roadAlt)) < 28) nearRoad++;
  }
  const isoPct = (iso / (S * S)) * 100, nearPct = (nearRoad / (S * S)) * 100;
  ok(isoPct < 0.5, `${id}: isolated texels ${isoPct.toFixed(3)}% (<0.5%)`);
  ok(nearPct < 12, `${id}: ground texels close to road colour ${nearPct.toFixed(1)}% (<12%)`);
  ok(colours.size <= 160, `${id}: tile colour count ${colours.size} (≤160, retro palette)`);
  console.log(`  tile: colours ${colours.size}, isolated ${isoPct.toFixed(3)}%, near-road ${nearPct.toFixed(1)}%, mean luma ${(sumL / S / S).toFixed(0)} vs road ${luma(pal.road).toFixed(0)}; seams x ${cs.seam.toFixed(1)}/${cs.mean.toFixed(1)} y ${rs.seam.toFixed(1)}/${rs.mean.toFixed(1)}`);
  // other sizes
  for (const s2 of [128, 256]) {
    const t2 = th.buildGroundTile(s2);
    const g2 = (x, y) => u32rgb(t2[y * s2 + x]);
    ok(t2.length === s2 * s2 && seamOK(colSeam(s2, s2, g2)) && seamOK(colSeam(s2, s2, (x, y) => g2(y, x))), `${id}: tile size ${s2} ok + seamless`);
  }
  let threw = false;
  try { th.buildGroundTile(300); } catch (e) { threw = true; }
  ok(threw, `${id}: non power-of-two size rejected`);

  // --- panorama
  const PW = 1536, PH = 72;
  ok(pano instanceof Uint8ClampedArray && pano.length === PW * PH * 4, `${id}: pano type/length`);
  let popaque = true;
  for (let i = 3; i < pano.length; i += 4) if (pano[i] !== 255) { popaque = false; break; }
  ok(popaque, `${id}: pano opaque`);
  const pano2 = th.buildPanorama(PW, PH);
  ok(pano2.every((v, i) => v === pano[i]), `${id}: pano deterministic`);
  const pget = (x, y) => { const i = (y * PW + x) * 4; return [pano[i], pano[i + 1], pano[i + 2]]; };
  const ps = colSeam(PW, PH, pget);
  ok(seamOK(ps), `${id}: pano wrap seam ${ps.seam.toFixed(1)} (mean ${ps.mean.toFixed(1)} p99 ${ps.p99.toFixed(1)})`);
  let bottomFog = true;
  for (let x = 0; x < PW; x++) { const c = pget(x, PH - 1); if (dist(c, th.fog) > 0.01) { bottomFog = false; break; } }
  ok(bottomFog, `${id}: pano bottom row == fog`);
  // rows above the fade must differ from fog somewhere (actual content) and the fade must be monotone-ish
  let fadeOK = true;
  for (let r = 1; r < 6; r++) {
    let dA = 0, dB = 0;
    for (let x = 0; x < PW; x++) { dA += dist(pget(x, PH - 1 - r), th.fog); dB += dist(pget(x, PH - r), th.fog); }
    if (dA + 1 < dB) fadeOK = false;
  }
  ok(fadeOK, `${id}: bottom rows fade towards fog`);
  ok(th.buildPanorama(768, 72).length === 768 * 72 * 4, `${id}: pano other width ok`);
  console.log(`  pano seam ${ps.seam.toFixed(1)} (mean ${ps.mean.toFixed(1)}, p99 ${ps.p99.toFixed(1)})`);

  if (!WANT_PNG) continue;
  // ------------------------------------------------------------------ previews
  // 1) composite sheet
  const W = 3072, H = 1460, img = new Uint8Array(W * H * 4);
  fillRect(img, W, 0, 0, W, H, [24, 24, 28]);
  blit(img, W, upscale(PW, PH, pano, 2), PW * 2, PH * 2, 0, 0);
  const tileRGBA = u32ToRGBA(tile);
  const tiled = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const si = ((y & 511) * 512 + (x & 511)) * 4, di = (y * 1024 + x) * 4;
    tiled[di] = tileRGBA[si]; tiled[di + 1] = tileRGBA[si + 1]; tiled[di + 2] = tileRGBA[si + 2]; tiled[di + 3] = 255;
  }
  blit(img, W, tiled, 1024, 1024, 0, 152);
  label(img, W, 4, 1184, `${th.name} - GROUND 2X2 TILING (SEAMS AT 512)`, [255, 255, 255], 3);
  const strip = topDownStrip(th, tile, S, 1000, 100);
  blit(img, W, upscale(strip.W, strip.H, strip.out, 2), strip.W * 2, strip.H * 2, 1040, 152);
  label(img, W, 1040, 560, 'ROAD MOCK: START  DASH  JUMP  PIT  ROUGH  ICE', [255, 255, 255], 3);
  const mips = buildMips(tile, S);
  const views = [{ x: 60, y: 0, th: 0, h: M7.CAM_H }, { x: 260, y: -30, th: -0.62, h: M7.CAM_H }];
  const frames = views.map((v) => renderMode7(th, mips, pano, v));
  frames.forEach((f, k) => blit(img, W, upscale(384, 216, f, 2), 768, 432, 1040 + k * 784, 590));
  // swatches
  const sw = PAL_RGB.map((k) => [k, pal[k]]).concat([['fog', th.fog]]);
  sw.forEach(([k, c], n) => {
    const x = 1040 + (n % 11) * 184, y = 1040 + Math.floor(n / 11) * 96;
    fillRect(img, W, x, y, 176, 56, c);
    label(img, W, x, y + 62, k, [230, 230, 230], 3);
  });
  label(img, W, 1040, 1236, `WEATHER: ${th.weather || 'NONE'}   ACCENT ${pal.hudAccent.replace('#', '')}`, [255, 255, 255], 3);
  writePNG(path.join(PREV, `theme-${id}.png`), W, H, img);

  // 2) close-ups for inspection
  const m7 = new Uint8Array(384 * 2 * 216 * 4);
  frames.forEach((f, k) => { for (let y = 0; y < 216; y++) m7.set(f.subarray(y * 384 * 4, (y + 1) * 384 * 4), (y * 768 + k * 384) * 4); });
  writePNG(path.join(PREV, `theme-${id}-mode7.png`), 1536, 432, upscale(768, 216, m7, 2));
  const pz = new Uint8Array(1024 * (3 * 144 + 16) * 4);
  fillRect(pz, 1024, 0, 0, 1024, 3 * 144 + 16, [24, 24, 28]);
  for (let part = 0; part < 3; part++) {
    const sub = new Uint8Array(512 * 72 * 4);
    for (let y = 0; y < 72; y++) sub.set(pano.subarray((y * PW + part * 512) * 4, (y * PW + part * 512 + 512) * 4), y * 512 * 4);
    blit(pz, 1024, upscale(512, 72, sub, 2), 1024, 144, 0, part * 152);
  }
  writePNG(path.join(PREV, `theme-${id}-pano.png`), 1024, 3 * 144 + 16, pz);
  const crop = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const si = (((y + 448) & 511) * 512 + ((x + 448) & 511)) * 4, di = (y * 256 + x) * 4;
    crop[di] = tileRGBA[si]; crop[di + 1] = tileRGBA[si + 1]; crop[di + 2] = tileRGBA[si + 2]; crop[di + 3] = 255;
  }
  writePNG(path.join(PREV, `theme-${id}-tile.png`), 1024, 1024, upscale(256, 256, crop, 4));
}

// ------------------------------------------------------------------ edge cases / API behaviour
console.log('\n== API edge cases');
{
  const th = THEMES.get('neon');
  ok(THEMES.get('neon') === th, 'get() caches: same object on repeated calls');
  ok(THEMES.get('no-such-theme') === th, 'unknown id falls back to neon (documented)');
  // exact output length for any panorama size, bottom row == fog, opaque, seam OK
  for (const id of THEMES.ids) {
    const t = THEMES.get(id);
    for (const [w, h] of [[8, 4], [1, 1], [100, 40], [255, 72], [3072, 144], [1537, 73]]) {
      const p = t.buildPanorama(w, h);
      let good = p instanceof Uint8ClampedArray && p.length === w * h * 4;
      for (let i = 3; good && i < p.length; i += 4) if (p[i] !== 255) good = false;
      for (let x = 0; good && x < w; x++) { const i = ((h - 1) * w + x) * 4; if (p[i] !== t.fog[0] || p[i + 1] !== t.fog[1] || p[i + 2] !== t.fog[2]) good = false; }
      if (good && w >= 64) good = seamOK(colSeam(w, h, (x, y) => { const i = (y * w + x) * 4; return [p[i], p[i + 1], p[i + 2]]; }));
      ok(good, `${id}: pano ${w}x${h} exact length, opaque, bottom row fog, seamless`);
    }
    let threw = 0;
    for (const [w, h] of [[0, 72], [1536, 0], [-5, 10]]) { try { t.buildPanorama(w, h); } catch (e) { threw++; } }
    ok(threw === 3, `${id}: pano rejects empty sizes`);
    for (const s of [16, 32, 64, 1024]) {
      const tl = t.buildGroundTile(s);
      let good = tl instanceof Uint32Array && tl.length === s * s;
      for (let i = 0; good && i < tl.length; i++) if (tl[i] >>> 24 !== 255) good = false;
      ok(good, `${id}: tile size ${s} builds (length, opaque)`);
    }
    ok(t.buildGroundTile().length === 512 * 512 && t.buildPanorama().length === 1536 * 72 * 4, `${id}: defaults 512 / 1536x72`);
  }
  // a fresh instance building themes in reverse order must give identical pixels
  // (no shared RNG / cache state leaking between themes or calls)
  const T2 = new Function(src + '\nreturn THEMES;')();
  for (const id of THEMES.ids.slice().reverse()) {
    const a = T2.get(id).buildGroundTile(256), b = THEMES.get(id).buildGroundTile(256);
    const pa = T2.get(id).buildPanorama(1536, 72), pb = THEMES.get(id).buildPanorama(1536, 72);
    ok(a.every((v, i) => v === b[i]) && pa.every((v, i) => v === pb[i]), `${id}: order-independent / fresh-instance deterministic`);
  }
}

console.log('\nTimings (first build, cold):');
for (const t of timings) console.log('  ' + t);
console.log(`  TOTAL ${totalMs.toFixed(1)} ms (target < 400 ms)`);
ok(totalMs < 400, `total build time ${totalMs.toFixed(0)} ms < 400 ms`);

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
