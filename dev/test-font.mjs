// FONT module tests + specimen sheets.   usage: node dev/test-font.mjs
// Writes dev/preview/font.png (specimen, x3) and dev/preview/font-hud.png (mock HUD frame, x3).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writePNG, upscale, u32ToRGBA } from './png.mjs';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(DEV, '..', 'parts', 'font.js'), 'utf8');
const PREVIEW = path.join(DEV, 'preview');
fs.mkdirSync(PREVIEW, { recursive: true });

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.log('FAIL: ' + msg); }
}
const eq = (a, b, msg) => check(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---------------------------------------------------------------------------------------
// 1. Load headlessly; record any touch of browser globals during load.
// ---------------------------------------------------------------------------------------
const touched = [];
const WATCH = ['window', 'document', 'AudioContext', 'webkitAudioContext', 'OffscreenCanvas', 'Image',
  'requestAnimationFrame', 'navigator', 'localStorage', 'performance'];
const saved = {};
for (const k of WATCH) {
  saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  Object.defineProperty(globalThis, k, { configurable: true, get() { touched.push(k); return undefined; } });
}
let FONT;
try {
  FONT = new Function(SRC + '\nreturn FONT;')();
} finally {
  for (const k of WATCH) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
}
check(touched.length === 0, 'module touched browser globals at load: ' + touched.join(','));
check(typeof FONT === 'object' && FONT, 'FONT object returned');
// Also evaluate as a classic script in a completely empty global (no window/document/console).
{
  const sandbox = vm.createContext({});
  let F = null, err = null;
  try { F = vm.runInContext(SRC + '\n;FONT', sandbox); } catch (e) { err = e; }
  check(!err && F && typeof F.draw === 'function', 'loads in an empty vm context ' + (err ? err.message : ''));
  eq(Object.keys(sandbox).join(','), '', 'creates no global properties');
}

// Exactly one top-level declaration, no import/export.
{
  const top = SRC.split('\n').filter((l) => /^(const|let|var|function|class)\b/.test(l));
  check(top.length === 1 && /^const FONT = \(\(\) => \{/.test(top[0]), 'single top-level const FONT IIFE');
  check(!/^\s*(import|export)\b/m.test(SRC), 'no import/export');
}

// ---------------------------------------------------------------------------------------
// 2. API shape
// ---------------------------------------------------------------------------------------
eq(FONT.CELL_W, 8, 'CELL_W');
eq(FONT.CELL_H, 8, 'CELL_H');
for (const f of ['draw', 'measure', 'glyphBits']) check(typeof FONT[f] === 'function', f + ' is a function');

// ---------------------------------------------------------------------------------------
// 3. Glyph inventory
// ---------------------------------------------------------------------------------------
const REQUIRED = [];
for (let c = 32; c <= 126; c++) REQUIRED.push(String.fromCharCode(c));
REQUIRED.push('←', '→', '↑', '↓', '×', '°', '★', '■', '▶', '◀', '♪', "'", '"');
const box = FONT.glyphBits('\u0001');
const bitsKey = (b) => b.join(',');
const seen = new Map();
for (const ch of REQUIRED) {
  const b = FONT.glyphBits(ch);
  const name = JSON.stringify(ch);
  check(Array.isArray(b) && b.length === 8, `glyphBits(${name}) is Array(8)`);
  check(b.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), `glyphBits(${name}) rows are bytes`);
  check(FONT.hasGlyph(ch), `hasGlyph(${name})`);
  eq(b[7], 0, `glyph ${name} row 7 must be empty (1 px gap)`);
  check(b.every((v) => (v & 1) === 0), `glyph ${name} column 7 must be empty (1 px gap)`);
  if (ch === ' ') { check(b.every((v) => v === 0), 'space is blank'); continue; }
  check(b.some((v) => v), `glyph ${name} is non-empty`);
  check(bitsKey(b) !== bitsKey(box), `glyph ${name} is not the unknown-box`);
  const k = bitsKey(b);
  if (seen.has(k) && seen.get(k) !== ch) check(false, `glyphs ${JSON.stringify(seen.get(k))} and ${name} are identical`);
  seen.set(k, ch);
}
// Confusable pairs must differ in at least 2 pixels.
const diffPx = (a, b) => FONT.glyphBits(a).reduce((s, v, i) => {
  let x = v ^ FONT.glyphBits(b)[i], c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return s + c;
}, 0);
for (const [a, b] of [['0', 'O'], ['O', 'D'], ['0', 'D'], ['1', 'I'], ['1', 'l'], ['I', 'l'], ['5', 'S'], ['2', 'Z'],
  ['8', 'B'], ['6', 'G'], ['6', 'b'], ['9', 'g'], ['9', 'q'], ['g', 'q'], ['g', 'y'], ['U', 'V'], ['u', 'v'], ['H', 'A'],
  ['M', 'W'], ['N', 'H'], ['C', 'G'], ['P', 'R'], ['E', 'F'], ['3', '8'], ['7', '1'], ['4', 'A'], ['o', '0'], ['.', ','],
  [':', ';'], ["'", '"'], ['-', '_'], ['n', 'h'], ['a', 'e'], ['c', 'e'], ['i', 'l'], ['i', 'j'], ['K', 'X']]) {
  check(diffPx(a, b) >= 2, `"${a}" vs "${b}" differ by only ${diffPx(a, b)} px`);
}
// Look-alikes that differ only by position: '×' must not be a moved 'x', '°' not a moved 'o'.
for (const [a, b] of [['×', 'x'], ['°', 'o'], ['■', '.'], ['★', '*']]) {
  const A = FONT.glyphBits(a), B = FONT.glyphBits(b);
  let best = 99;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    let d = 0;
    for (let r = 0; r < 8; r++) {
      const sr = r - dy, row = sr >= 0 && sr < 8 ? B[sr] : 0;
      const sh = dx >= 0 ? (row >> dx) : ((row << -dx) & 255);
      let x = A[r] ^ sh;
      while (x) { d += x & 1; x >>= 1; }
    }
    if (d < best) best = d;
  }
  check(best >= 4, `"${a}" is just a shifted "${b}" (min diff ${best} px)`);
}
// Unknown characters render as the box; glyphBits returns fresh copies.
check(!FONT.hasGlyph('あ'), 'hasGlyph(あ) is false');
eq(bitsKey(FONT.glyphBits('あ')), bitsKey(box), 'unknown char -> box');
eq(bitsKey(FONT.glyphBits('😀')), bitsKey(box), 'astral char -> box');
check(box.some((v) => v), 'box glyph non-empty');
{ const b = FONT.glyphBits('A'); b[0] = 0; check(FONT.glyphBits('A')[0] !== 0, 'glyphBits returns a copy'); }
eq(bitsKey(FONT.glyphBits('’')), bitsKey(FONT.glyphBits("'")), 'typographic apostrophe alias');
eq(FONT.glyphBits(65).join(), FONT.glyphBits('A').join(), 'glyphBits accepts a code point');

// Style metrics (informational + loose checks): vertical runs of 1-px-wide ink.
{
  let thinStems = [];
  for (const ch of REQUIRED) {
    const b = FONT.glyphBits(ch);
    for (let c = 0; c < 7; c++) {
      let run = 0;
      for (let r = 0; r < 8; r++) {
        const on = (b[r] >> (7 - c)) & 1;
        const left = c > 0 ? (b[r] >> (8 - c)) & 1 : 0, right = c < 6 ? (b[r] >> (6 - c)) & 1 : 0;
        if (on && !left && !right) run++;
        else { if (run >= 3) thinStems.push(ch); run = 0; }
      }
    }
  }
  thinStems = [...new Set(thinStems)];
  console.log('glyphs with 1-px vertical stems (>=3 rows):', thinStems.join(' ') || '(none)');
  // m and w need a 1-px centre stem in a 7-px wide body; everything else must use 2-px stems.
  check(!thinStems.some((c) => /[A-Za-ln-vx-z0-9]/.test(c)), 'letters/digits use 2-px stems (no 1-px stems >= 3 rows)');
}

// ---------------------------------------------------------------------------------------
// 4. measure()
// ---------------------------------------------------------------------------------------
eq(FONT.measure('LAP 2/5'), 56, 'measure LAP 2/5');
eq(FONT.measure('LAP 2/5', 2), 112, 'measure scale 2');
eq(FONT.measure('LAP 2/5', 3), 168, 'measure scale 3');
eq(FONT.measure(''), 0, 'measure empty');
eq(FONT.measure(null), 0, 'measure null');
eq(FONT.measure(452), 24, 'measure number');
eq(FONT.measure('AB\nCDEF\nG'), 32, 'measure widest line');
eq(FONT.measure('ABC\n'), 24, 'measure trailing newline');
eq(FONT.measure('A\r\nBB'), 16, 'measure ignores \\r');
eq(FONT.measure('😀x'), 16, 'surrogate pair counts as one cell');
eq(FONT.measure('★️'), 8, 'variation selector is zero-width');
eq(FONT.measure('AB', 0), 16, 'scale <1 clamps to 1');
eq(FONT.measure('AB', 2.7), 32, 'fractional scale floors');
eq(FONT.measure("TIME 1'23\"45"), 12 * 8, 'measure lap time');

// ---------------------------------------------------------------------------------------
// 5. drawPixels (pure renderer shares layout + masks with the canvas path)
// ---------------------------------------------------------------------------------------
const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const WHITE = pack(255, 255, 255), BLACK = pack(0, 0, 0), RED = pack(255, 0, 0), BG = pack(10, 20, 30);
function buffer(w, h, fill = BG) { const b = new Uint32Array(w * h); b.fill(fill); return b; }
function inkAt(buf, w, x, y, color = WHITE) { return buf[y * w + x] === color; }

// Plain glyph matches glyphBits at scale 1 and 3.
for (const s of [1, 2, 3]) {
  for (const ch of ['A', 'g', '0', '★', '%']) {
    const W = 40, H = 40, buf = buffer(W, H);
    const ret = FONT.drawPixels(buf, W, H, ch, 5, 6, { scale: s, color: '#ffffff' });
    eq(ret, 8 * s, `drawPixels return width (${ch}, s${s})`);
    const bits = FONT.glyphBits(ch);
    let ok = true;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const gx = Math.floor((x - 5) / s), gy = Math.floor((y - 6) / s);
      const want = gx >= 0 && gx < 8 && gy >= 0 && gy < 8 && ((bits[gy] >> (7 - gx)) & 1) === 1;
      if (inkAt(buf, W, x, y) !== want) ok = false;
      if (!want && buf[y * W + x] !== BG) ok = false;
    }
    check(ok, `drawPixels ${ch} at scale ${s} matches bitmap`);
  }
}
// Alignment.
{
  const W = 100, H = 12;
  const a = buffer(W, H), b = buffer(W, H), c = buffer(W, H);
  FONT.drawPixels(a, W, H, 'ABC', 26, 2);
  FONT.drawPixels(b, W, H, 'ABC', 38, 2, { align: 'center' });
  FONT.drawPixels(c, W, H, 'ABC', 50, 2, { align: 'right' });
  check(a.every((v, i) => v === b[i]), 'align center = x - width/2');
  check(a.every((v, i) => v === c[i]), 'align right = x - width');
}
// Multi-line with per-line alignment, lineHeight.
{
  const W = 64, H = 64;
  const a = buffer(W, H), b = buffer(W, H);
  FONT.drawPixels(a, W, H, 'AB\nC', 32, 3, { align: 'center', lineHeight: 12 });
  FONT.drawPixels(b, W, H, 'AB', 24, 3);
  FONT.drawPixels(b, W, H, 'C', 28, 15);
  check(a.every((v, i) => v === b[i]), 'multi-line center alignment + lineHeight');
  const c = buffer(W, H), d = buffer(W, H);
  FONT.drawPixels(c, W, H, 'A\nB', 2, 2, { scale: 2 });
  FONT.drawPixels(d, W, H, 'A', 2, 2, { scale: 2 });
  FONT.drawPixels(d, W, H, 'B', 2, 22, { scale: 2 });
  check(c.every((v, i) => v === d[i]), 'default lineHeight 10 * scale');
}
// Shadow offset 1*scale, outline 8-neighbour 1*scale.
for (const s of [1, 2, 3]) {
  const W = 40, H = 40;
  const sh = buffer(W, H), plain = buffer(W, H);
  FONT.drawPixels(sh, W, H, 'I', 4, 4, { scale: s, shadow: '#000' });
  FONT.drawPixels(plain, W, H, 'I', 4 + s, 4 + s, { scale: s, color: '#000' });
  FONT.drawPixels(plain, W, H, 'I', 4, 4, { scale: s });
  check(sh.every((v, i) => v === plain[i]), `shadow = glyph offset by ${s},${s}`);

  const ol = buffer(W, H);
  FONT.drawPixels(ol, W, H, '.', 4, 4, { scale: s, outline: '#ff0000' });
  // '.' occupies cols 2-3 rows 5-6 -> outline box cols 1-4 rows 4-7 (in glyph px), filled 8-neighbour.
  let ok = true;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inGlyph = x >= 4 + 2 * s && x < 4 + 4 * s && y >= 4 + 5 * s && y < 4 + 7 * s;
    const inHalo = x >= 4 + 1 * s && x < 4 + 5 * s && y >= 4 + 4 * s && y < 4 + 8 * s;
    const want = inGlyph ? WHITE : inHalo ? RED : BG;
    if (ol[y * W + x] !== want) ok = false;
  }
  check(ok, `outline '.' is a ${s}px 8-neighbour ring at scale ${s}`);
}
// Enclosed counters of outlined text are filled with the outline colour (a 1*scale outline leaves
// only a 1-glyph-px sliver of each 3-px counter, which reads as a slashed "0" in italic), and a
// drop shadow never shows through them. Open shapes stay open; the slash of '0' stays ink.
{
  const BLUE = pack(0, 0, 255);
  const shearPx = (py, s) => Math.floor((8 * s - 1 - py) / 3);
  for (const s of [1, 2, 3]) for (const italic of [false, true]) {
    const W = 48, H = 48, X = 4, Y = 4;
    const px = (buf, gx, gy, sx = 0, sy = 0) => {
      const py = gy * s + sy;
      return buf[(Y + py) * W + X + gx * s + sx + (italic ? shearPx(py, s) : 0)];
    };
    const allIn = (buf, gx0, gx1, gy0, gy1, want) => {
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++)
        for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) if (px(buf, gx, gy, sx, sy) !== want) return false;
      return true;
    };
    const tag = `scale ${s}${italic ? ' italic' : ''}`;
    const o = buffer(W, H);
    FONT.drawPixels(o, W, H, 'O', X, Y, { scale: s, italic, outline: '#ff0000', shadow: '#0000ff' });
    check(allIn(o, 2, 4, 1, 5, RED), `outlined 'O' counter is filled with the outline colour (${tag})`);
    check(o.includes(BLUE), `outlined 'O' still casts a shadow (${tag})`);
    const z = buffer(W, H);
    FONT.drawPixels(z, W, H, '0', X, Y, { scale: s, italic, outline: '#ff0000' });
    check(allIn(z, 3, 3, 3, 3, WHITE) && px(z, 2, 2) === RED, `outlined '0' keeps its slash, counters filled (${tag})`);
    const u = buffer(W, H);
    FONT.drawPixels(u, W, H, 'U', X, Y, { scale: s, italic, outline: '#ff0000' });
    // (italic at 1x: the sheared stems' outlines meet below row 1, so only row 0 is checked)
    check(px(u, 3, 0) === BG && (italic || px(u, 3, 2) === BG), `outlined 'U' stays open at the top (${tag})`);
  }
}
// Italic: rows shear right toward the top, ~1 px per 3 rows.
{
  const W = 24, H = 12, buf = buffer(W, H);
  FONT.drawPixels(buf, W, H, '|', 0, 0, { italic: true });
  const leftmost = (y) => { for (let x = 0; x < W; x++) if (inkAt(buf, W, x, y)) return x; return -1; };
  const shifts = [0, 1, 2, 3, 4, 5, 6].map((y) => leftmost(y) - 2);
  eq(shifts.join(','), '2,2,1,1,1,0,0', 'italic shear per row at scale 1');
  const b3 = buffer(60, 30);
  FONT.drawPixels(b3, 60, 30, '|', 0, 0, { italic: true, scale: 3 });
  const lm3 = (y) => { for (let x = 0; x < 60; x++) if (b3[y * 60 + x] === WHITE) return x; return -1; };
  eq(lm3(20) - 6, 1, 'italic scale 3: row 20 shifted by 1');
  eq(lm3(0) - 6, 7, 'italic scale 3: top row shifted by 7');
}
// alpha blending
{
  const W = 16, H = 16, buf = buffer(W, H, pack(0, 0, 0));
  FONT.drawPixels(buf, W, H, '■', 0, 0, { alpha: 0.5, color: '#ffffff' });
  const v = buf[3 * W + 3];
  check(Math.abs((v & 255) - 128) <= 1, 'alpha 0.5 blends');
  const b2 = buffer(W, H, pack(0, 0, 0));
  FONT.drawPixels(b2, W, H, '■', 0, 0, { alpha: 0 });
  check(b2.every((x) => x === pack(0, 0, 0)), 'alpha 0 draws nothing');
}
// Clipping at buffer edges must not throw.
{
  const W = 10, H = 10, buf = buffer(W, H);
  let threw = false;
  try { FONT.drawPixels(buf, W, H, 'WIDE TEXT\nNEXT', -5, -5, { scale: 3, outline: '#000', shadow: '#000', italic: true }); }
  catch (e) { threw = e; }
  check(!threw, 'clipping draws without throwing ' + (threw && threw.message));
}

// ---------------------------------------------------------------------------------------
// 6. Browser draw path, exercised against a minimal software Canvas 2D implementation.
// ---------------------------------------------------------------------------------------
function parseCss(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, (d) => d + d);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  const named = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], red: [255, 0, 0, 1] };
  return named[t] || null;
}
const STATS = { canvases: 0, drawImage: 0, fillRect: 0, badCoords: 0 };
class FakeCanvas {
  constructor(w = 300, h = 150) { this._w = w; this._h = h; this.px = new Float64Array(w * h * 4); this._ctx = null; STATS.canvases++; }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this.px = new Float64Array(this._w * this._h * 4); if (this._ctx) this._ctx._reset(); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this.px = new Float64Array(this._w * this._h * 4); if (this._ctx) this._ctx._reset(); }
  getContext(t) { if (t !== '2d') return null; if (!this._ctx) this._ctx = new FakeCtx(this); return this._ctx; }
}
class FakeCtx {
  constructor(c) { this.canvas = c; this._reset(); }
  _reset() { this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this._fill = [0, 0, 0, 1]; this.imageSmoothingEnabled = true; }
  set fillStyle(v) { const p = parseCss(v); if (p) this._fill = p; }
  get fillStyle() { return this._fill; }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img, x, y) {
    const c = this.canvas;
    for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
      const tx = x + i, ty = y + j;
      if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
      for (let k = 0; k < 4; k++) c.px[(ty * c.width + tx) * 4 + k] = img.data[(j * img.width + i) * 4 + k] / (k === 3 ? 255 : 1);
    }
  }
  clearRect(x, y, w, h) {
    const c = this.canvas;
    for (let ty = Math.max(0, y); ty < Math.min(c.height, y + h); ty++)
      for (let tx = Math.max(0, x); tx < Math.min(c.width, x + w); tx++) c.px.fill(0, (ty * c.width + tx) * 4, (ty * c.width + tx) * 4 + 4);
  }
  _comp(tx, ty, r, g, b, a) {
    const c = this.canvas;
    if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) return;
    const i = (ty * c.width + tx) * 4, da = c.px[i + 3];
    a *= this.globalAlpha;
    if (this.globalCompositeOperation === 'source-in') {
      c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b; c.px[i + 3] = a * da;
    } else if (this.globalCompositeOperation === 'source-over') {
      const oa = a + da * (1 - a);
      if (oa <= 0) { c.px.fill(0, i, i + 4); return; }
      c.px[i] = (r * a + c.px[i] * da * (1 - a)) / oa;
      c.px[i + 1] = (g * a + c.px[i + 1] * da * (1 - a)) / oa;
      c.px[i + 2] = (b * a + c.px[i + 2] * da * (1 - a)) / oa;
      c.px[i + 3] = oa;
    } else throw new Error('fake ctx: unsupported op ' + this.globalCompositeOperation);
  }
  fillRect(x, y, w, h) {
    STATS.fillRect++;
    if (this.globalCompositeOperation === 'source-in' && (x > 0 || y > 0 || x + w < this.canvas.width || y + h < this.canvas.height))
      throw new Error('fake ctx: partial source-in fillRect would clear outside in a real browser');
    const [r, g, b, a] = this._fill;
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) this._comp(tx, ty, r, g, b, a);
  }
  drawImage(src, ...a) {
    STATS.drawImage++;
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
    if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
    else if (a.length === 4) { [dx, dy, dw, dh] = a; }
    else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isInteger) || sw !== dw || sh !== dh) STATS.badCoords++;
    if (this.globalCompositeOperation !== 'source-over') throw new Error('fake ctx: drawImage only tested with source-over');
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
      const fx = sx + i, fy = sy + j;
      if (fx < 0 || fy < 0 || fx >= src.width || fy >= src.height) continue;
      const k = (fy * src.width + fx) * 4;
      if (src.px[k + 3] > 0) this._comp(dx + i, dy + j, src.px[k], src.px[k + 1], src.px[k + 2], src.px[k + 3]);
    }
  }
  toU32() {
    const c = this.canvas, out = new Uint32Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) {
      const p = c.px.subarray(i * 4, i * 4 + 4);
      out[i] = ((Math.round(p[3] * 255) << 24) | (Math.round(p[2]) << 16) | (Math.round(p[1]) << 8) | Math.round(p[0])) >>> 0;
    }
    return out;
  }
}
globalThis.document = { createElement: (t) => { if (t !== 'canvas') throw new Error('unexpected element ' + t); return new FakeCanvas(); } };

const near = (a, b) => Math.abs((a & 255) - (b & 255)) <= 2 && Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255)) <= 2 &&
  Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255)) <= 2 && Math.abs((a >>> 24) - (b >>> 24)) <= 2;
const CASES = [
  ["TIME 1'23\"45", 3, 2, {}],
  ['LAP 2/5', 40, 20, { color: '#ffd400', scale: 2, align: 'center' }],
  ['452 km/h', 90, 4, { color: 'rgb(0,255,200)', align: 'right', shadow: '#000' }],
  ['RANK 3/20', 4, 30, { outline: '#102040', color: '#fff' }],
  ['GOAL!!', 10, 40, { scale: 3, italic: true, outline: '#000', shadow: '#ff0000', color: '#ffff00' }],
  ['FINAL\nLAP', 60, 6, { scale: 2, align: 'center', italic: true, lineHeight: 9 }],
  ['RANK OUT', 2, 70, { alpha: 0.5, color: '#ff0000' }],
  ['POWER', 2, 82, { alpha: 0.6, outline: '#000', shadow: '#0000ff', color: '#ffffff', scale: 2 }],
  ['▶ ★ ♪ ← → ↑ ↓ × ° ■ ◀', 0, 104, { color: 'not-a-color' }],
  ['clip me', -9, -3, { scale: 2, shadow: '#000' }],
];
for (const [text, x, y, opts] of CASES) {
  const W = 128, H = 120;
  const canvas = new FakeCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a141e'; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  const ref = buffer(W, H, pack(10, 20, 30));
  const pxOpts = { ...opts };
  if (pxOpts.color === 'not-a-color') pxOpts.color = '#fff';
  const r1 = FONT.draw(ctx, text, x, y, opts);
  const r2 = FONT.drawPixels(ref, W, H, text, x, y, pxOpts);
  eq(r1, r2, `draw/drawPixels return the same width for ${JSON.stringify(text)}`);
  eq(r1, FONT.measure(text, opts.scale || 1), `draw returns measure() for ${JSON.stringify(text)}`);
  const got = ctx.toU32();
  let bad = 0;
  for (let i = 0; i < got.length; i++) if (!near(got[i], ref[i])) bad++;
  eq(bad, 0, `canvas path == pixel path for ${JSON.stringify(text)} ${JSON.stringify(opts)} (mismatched px)`);
  eq(ctx.globalAlpha, 1, 'globalAlpha restored');
  eq(ctx.imageSmoothingEnabled, true, 'imageSmoothingEnabled restored');
  eq(ctx.globalCompositeOperation, 'source-over', 'composite op untouched');
}
eq(STATS.badCoords, 0, 'every drawImage uses integer, unscaled rectangles');
{
  // Steady state: one drawImage per visible glyph per pass, no new canvases once cached.
  const ctx = new FakeCanvas(64, 16).getContext('2d');
  FONT.draw(ctx, 'SPEED 452', 0, 0, { color: '#abcdef', shadow: '#000' });
  const c0 = STATS.canvases, d0 = STATS.drawImage;
  FONT.draw(ctx, 'SPEED 452', 0, 0, { color: '#abcdef', shadow: '#000' });
  eq(STATS.canvases - c0, 0, 'no canvases created once atlases are cached');
  eq(STATS.drawImage - d0, 16, '8 glyphs x 2 passes = 16 drawImage calls');
  FONT.draw(ctx, 'ABC', 0, 0, { color: '#abcdef', outline: '#000', shadow: '#111' });
  const d1 = STATS.drawImage;
  FONT.draw(ctx, 'ABC', 0, 0, { color: '#abcdef', outline: '#000', shadow: '#111' });
  eq(STATS.drawImage - d1, 9, '3 glyphs x 3 passes');
  // Many colours: cache stays bounded, canvases get recycled.
  const before = STATS.canvases;
  for (let i = 0; i < 400; i++) FONT.draw(ctx, 'X', 0, 0, { color: `rgb(${i % 256},${(i * 7) % 256},9)` });
  check(STATS.canvases - before < 400, `tint cache recycles canvases (${STATS.canvases - before} created for 400 colours)`);
  // Edge cases.
  eq(FONT.draw(ctx, '', 0, 0), 0, 'draw empty string');
  eq(FONT.draw(ctx, '   ', 0, 0), 24, 'draw spaces only');
  eq(FONT.draw(null, 'AB', 0, 0), 16, 'draw with null ctx is a safe no-op');
  eq(FONT.draw(ctx, 'AB', 0, 0, { alpha: 0 }), 16, 'alpha 0 returns width');
}
// Tint-cache memory: a colour-cycling title at a big scale must not pile up atlases. Uses a fresh
// FONT instance over stub canvases (no pixel storage) and sums the live canvas area.
{
  const live = new Set();
  class StubCanvas {
    constructor() { this._w = 300; this._h = 150; live.add(this); this._ctx = null; }
    get width() { return this._w; } set width(v) { this._w = v | 0; }
    get height() { return this._h; } set height(v) { this._h = v | 0; }
    getContext() {
      if (!this._ctx) {
        this._ctx = { canvas: this, globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
          fillStyle: '#000', createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {}, clearRect() {}, fillRect() {}, drawImage() {} };
      }
      return this._ctx;
    }
  }
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => new StubCanvas() };
  const F2 = new Function(SRC + '\nreturn FONT;')();
  const target = new StubCanvas().getContext('2d');
  live.delete(target.canvas);
  const livePx = () => { let p = 0; for (const c of live) p += c.width * c.height; return p; };
  for (let i = 0; i < 200; i++) F2.draw(target, 'ZERO-G GP', 0, 0, { scale: 8, italic: true, color: `rgb(${i},40,200)`, outline: '#000' });
  const mpx = livePx() / 1e6;
  console.log(`live canvas area after 200 colours at scale 8 italic + outline: ${mpx.toFixed(2)} Mpx`);
  check(mpx < 10, `tint cache bounded by area (${mpx.toFixed(2)} Mpx live)`);
  for (let i = 0; i < 500; i++) F2.draw(target, 'X', 0, 0, { color: `rgb(${i % 256},${i >> 8},1)` });
  check(livePx() / 1e6 < 10, 'tint cache bounded after many small colours');
  // Huge scale with all three layers: once warm, a frame must reuse its atlases (no rebuild thrash).
  const big = { scale: 16, italic: true, color: '#ff0', outline: '#000', shadow: '#c00' };
  F2.draw(target, 'GP', 0, 0, big);
  const n0 = live.size;
  for (let i = 0; i < 5; i++) F2.draw(target, 'GP', 0, 0, big);
  eq(live.size - n0, 0, 'scale 16 outline+shadow: no canvases rebuilt per frame');
  globalThis.document = prevDoc;
}
// Rough perf of the per-frame CPU work (layout + bookkeeping) with a no-op context.
{
  const ctx = { globalAlpha: 1, imageSmoothingEnabled: false, drawImage() {}, globalCompositeOperation: 'source-over' };
  const lines = ["TIME 1'23\"45", 'LAP 2/5', '452 km/h', 'RANK 3/20', 'POWER', 'FINAL LAP'];
  FONT.draw(new FakeCanvas(8, 8).getContext('2d'), 'warm', 0, 0, { shadow: '#000' });
  const t0 = process.hrtime.bigint();
  const FRAMES = 2000;
  for (let f = 0; f < FRAMES; f++) for (let k = 0; k < 6; k++) FONT.draw(ctx, lines[k] + ' ' + lines[(k + 1) % 6], 0, k * 10, { shadow: '#000' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / FRAMES;
  console.log(`CPU per frame for ~${6 * 18} glyphs x2 passes (no rasterisation): ${ms.toFixed(4)} ms`);
  check(ms < 0.5, 'draw bookkeeping is cheap');
}
delete globalThis.document;

// ---------------------------------------------------------------------------------------
// 7. Specimen sheets
// ---------------------------------------------------------------------------------------
function specimen() {
  const W = 384, H = 412;
  const buf = buffer(W, H, pack(12, 14, 34));
  // glyph table: 16 per row on a cell-checker background to show the 8x8 cells.
  const chars = Array.from(FONT.CHARS);
  for (let i = 0; i < chars.length; i++) {
    const cx = 4 + (i % 32) * 10, cy = 4 + Math.floor(i / 32) * 10;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) buf[(cy + y) * W + cx + x] = (i + Math.floor(i / 32)) % 2 ? pack(40, 44, 80) : pack(30, 34, 64);
    FONT.drawPixels(buf, W, H, chars[i], cx, cy);
  }
  FONT.drawPixels(buf, W, H, 'unknown chars: あ亜\u{1F600}\u0007', 380, 34, { color: '#889', align: 'right' });
  let y = 50;
  const line = (t, o = {}, x = 4) => { FONT.drawPixels(buf, W, H, t, x, y, o); y += 10 * (o.scale || 1); };
  line('ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789');
  line('the quick brown fox jumps over the lazy dog.');
  line('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG!');
  line('Sphinx of black quartz, judge my vow? (j/g/p/q/y)');
  line('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
  y += 2;
  FONT.drawPixels(buf, W, H, "TIME 1'23\"45", 4, y, { color: '#ffffff', shadow: '#000' });
  FONT.drawPixels(buf, W, H, 'LAP 2/5', 120, y, { color: '#ffd400', shadow: '#000' });
  FONT.drawPixels(buf, W, H, '452 km/h', 380, y, { color: '#7cf', align: 'right', shadow: '#000' });
  y += 10;
  FONT.drawPixels(buf, W, H, 'RANK 3/20', 4, y, { color: '#ff6', outline: '#000' });
  FONT.drawPixels(buf, W, H, 'POWER', 100, y, { color: '#f4f', outline: '#000' });
  FONT.drawPixels(buf, W, H, 'FINAL LAP', 160, y, { color: '#fff', italic: true, shadow: '#a00' });
  FONT.drawPixels(buf, W, H, 'GOAL!!', 250, y, { color: '#ff0', italic: true, outline: '#000' });
  FONT.drawPixels(buf, W, H, 'RANK OUT', 380, y, { color: '#f44', align: 'right' });
  y += 10;
  FONT.drawPixels(buf, W, H, '0123456789 -0:00\'00"00- 1st 2nd 3rd 20th', 4, y, { color: '#cfe', italic: true });
  y += 10;
  FONT.drawPixels(buf, W, H, '▶ START  ◀  ★ BEST  ♪ BGM  ←→ STEER  ×2  99°', 4, y, { color: '#9cf' });
  y += 12;
  // bright strip to judge outline / shadow on light ground
  for (let yy = y - 2; yy < y + 30; yy++) for (let x = 0; x < W; x++) buf[yy * W + x] = (x >> 3) % 2 ? pack(190, 196, 200) : pack(150, 160, 170);
  FONT.drawPixels(buf, W, H, '452 km/h', 4, y, { color: '#fff', outline: '#000' });
  FONT.drawPixels(buf, W, H, 'RANK 3/20', 84, y, { color: '#ff0', outline: '#000' });
  FONT.drawPixels(buf, W, H, "1'23\"45", 172, y, { color: '#000' });
  FONT.drawPixels(buf, W, H, 'ENERGY LOW', 380, y, { color: '#f22', outline: '#fff', italic: true, align: 'right' });
  FONT.drawPixels(buf, W, H, 'x2', 4, y + 14, { color: '#124' });
  FONT.drawPixels(buf, W, H, 'LAP 2/5', 30, y + 12, { color: '#ffd400', scale: 2, outline: '#000' });
  FONT.drawPixels(buf, W, H, 'POWER', 380, y + 12, { color: '#fff', scale: 2, italic: true, shadow: '#000', outline: '#04a', align: 'right' });
  y += 34;
  // scale 3, one per row
  const big = (t, o, x = 4) => { FONT.drawPixels(buf, W, H, t, x, y, { scale: 3, ...o }); y += 28; };
  big('GOAL!!', { color: '#ffe000', italic: true, outline: '#000', shadow: '#b03000' });
  big('FINAL LAP', { color: '#ffffff', italic: true, outline: '#c00' });
  big('RANK OUT', { color: '#ff3030', outline: '#000' });
  big('452 km/h', { color: '#7df', shadow: '#000' });
  big("TIME 1'23\"45", { color: '#fff', shadow: '#334' });
  FONT.drawPixels(buf, W, H, 'the quick brown fox\njumps over the lazy dog', 192, y, { scale: 2, color: '#cde', align: 'center', lineHeight: 10 });
  y += 42;
  FONT.drawPixels(buf, W, H, 'Ag0Oj', 4, y, { scale: 3, color: '#fff' });
  FONT.drawPixels(buf, W, H, '\u25B6\u2605\u266A\u2192', 136, y, { scale: 3, color: '#fc0', outline: '#000' });
  FONT.drawPixels(buf, W, H, 'POWER', 380, y, { scale: 3, color: '#fff', alpha: 0.6, outline: '#000', align: 'right' });
  writePNG(path.join(PREVIEW, 'font.png'), W * 3, H * 3, upscale(W, H, u32ToRGBA(buf), 3));
  writePNG(path.join(PREVIEW, 'font-1x.png'), W, H, u32ToRGBA(buf));
}

// Mock 384x216 race frame with the HUD at real size (judging legibility at game scale).
function hudFrame() {
  const W = 384, H = 216, buf = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c;
    if (y < 72) { const t = y / 72; c = pack(40 + 60 * t | 0, 20 + 30 * t | 0, 90 + 40 * t | 0); }
    else {
      const z = 72 * 192 / (y - 71), u = (x - 192) * z / 192;
      const onRoad = Math.abs(u) < 60;
      const band = Math.floor(z / 24) % 2;
      c = onRoad ? (band ? pack(92, 96, 112) : pack(84, 88, 104)) : (Math.abs(u) < 66 ? (band ? pack(240, 200, 0) : pack(30, 30, 30)) : pack(20, 40, 60));
    }
    buf[y * W + x] = c;
  }
  const o = { shadow: '#000' };
  FONT.drawPixels(buf, W, H, "TIME 1'23\"45", 8, 6, { ...o, color: '#fff' });
  FONT.drawPixels(buf, W, H, 'LAP 2/5', 376, 6, { ...o, color: '#ffd400', align: 'right' });
  FONT.drawPixels(buf, W, H, 'RANK', 8, 18, { ...o, color: '#9cf' });
  FONT.drawPixels(buf, W, H, '3', 44, 14, { ...o, color: '#fff', scale: 2, italic: true });
  FONT.drawPixels(buf, W, H, '/20', 60, 22, { ...o, color: '#fff' });
  FONT.drawPixels(buf, W, H, 'POWER', 376, 18, { ...o, color: '#f6f', align: 'right' });
  FONT.drawPixels(buf, W, H, '452', 344, 194, { color: '#fff', scale: 2, italic: true, outline: '#000', align: 'right' });
  FONT.drawPixels(buf, W, H, 'km/h', 380, 200, { color: '#fff', align: 'right', outline: '#000' });
  FONT.drawPixels(buf, W, H, 'FINAL LAP', 192, 60, { color: '#fff', scale: 3, italic: true, outline: '#000', shadow: '#c00000', align: 'center' });
  FONT.drawPixels(buf, W, H, 'best 1\'21"09', 8, 200, { color: '#cfe', shadow: '#000' });
  FONT.drawPixels(buf, W, H, '★×3', 8, 186, { color: '#ff0', shadow: '#000' });
  writePNG(path.join(PREVIEW, 'font-hud.png'), W * 3, H * 3, upscale(W, H, u32ToRGBA(buf), 3));
}
specimen();
hudFrame();

console.log(`\n${passes} checks passed, ${failures} failed`);
console.log('specimens: dev/preview/font.png, dev/preview/font-1x.png, dev/preview/font-hud.png');
process.exit(failures ? 1 : 0);
