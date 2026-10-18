// ZERO-G GP - FONT: hand-drawn 8x8 bitmap font for the HUD / menus.
// No DOM access at load time: atlases are built lazily on the first draw() call.
const FONT = (() => {
  'use strict';

  const CELL_W = 8;
  const CELL_H = 8;
  const LINE_HEIGHT = 10;
  const MAX_SCALE = 16;

  // ---------------------------------------------------------------------------------------
  // Glyph sheet. Every glyph is drawn by hand on a 7x7 grid ('#' = ink) inside its 8x8 cell;
  // column 7 and row 7 stay empty (1 px gap). Style: chunky techno-arcade, 2 px vertical
  // stems, 1 px horizontal strokes, bevelled corners on round letters. Capitals and digits
  // use rows 0-6; lowercase x-height is rows 2-6, descenders (g j p q y) fold inside the cell.
  // Each block = [chars, row0 .. row6]; within a row the glyphs are separated by one space.
  // ---------------------------------------------------------------------------------------
  const SHEET = [
    ['ABCDEFGH',
      '.#####. ######. .#####. #####.. ####### ####### .#####. ##...##',
      '##...## ##...## ##...## ##..##. ##..... ##..... ##...## ##...##',
      '##...## ##...## ##..... ##...## ##..... ##..... ##..... ##...##',
      '####### ######. ##..... ##...## ######. ######. ##..### #######',
      '##...## ##...## ##..... ##...## ##..... ##..... ##...## ##...##',
      '##...## ##...## ##...## ##..##. ##..... ##..... ##...## ##...##',
      '##...## ######. .#####. #####.. ####### ##..... .#####. ##...##'],
    ['IJKLMNOP',
      '######. .....## ##...## ##..... ##...## ##...## .#####. ######.',
      '..##... .....## ##..##. ##..... ###.### ###..## ##...## ##...##',
      '..##... .....## ##.##.. ##..... ####### ####.## ##...## ##...##',
      '..##... .....## ####... ##..... ##.#.## ##.#### ##...## ######.',
      '..##... ##...## ##.##.. ##..... ##...## ##..### ##...## ##.....',
      '..##... ##...## ##..##. ##..... ##...## ##...## ##...## ##.....',
      '######. .#####. ##...## ####### ##...## ##...## .#####. ##.....'],
    ['QRSTUVWX',
      '.#####. ######. .#####. ######. ##...## ##...## ##...## ##...##',
      '##...## ##...## ##...## ..##... ##...## ##...## ##...## ##...##',
      '##...## ##...## ##..... ..##... ##...## ##...## ##...## .##.##.',
      '##...## ######. .#####. ..##... ##...## ##...## ##.#.## ..###..',
      '##.#.## ##.##.. .....## ..##... ##...## .##.##. ####### .##.##.',
      '##..##. ##..##. ##...## ..##... ##...## ..###.. ###.### ##...##',
      '.###.## ##...## .#####. ..##... .#####. ...#... ##...## ##...##'],
    ['YZ012345',
      '##...## ####### .#####. ..###.. .#####. .#####. ....##. #######',
      '##...## .....## ##...## .####.. ##...## ##...## ...###. ##.....',
      '.##.##. ....##. ##..### ...##.. .....## .....## ..####. ######.',
      '..###.. ...##.. ##.#.## ...##.. ..####. ..####. .##.##. .....##',
      '..###.. ..##... ###..## ...##.. .##.... .....## ##..##. .....##',
      '..###.. .##.... ##...## ...##.. ##..... ##...## ####### ##...##',
      '..###.. ####### .#####. .###### ####### .#####. ....##. .#####.'],
    ['6789abcd',
      '.#####. ####### .#####. .#####. ....... ##..... ....... .....##',
      '##..... .....## ##...## ##...## ....... ##..... ....... .....##',
      '##..... ....##. ##...## ##...## .#####. ######. .#####. .######',
      '######. ...##.. .#####. .###### .....## ##...## ##..... ##...##',
      '##...## ..##... ##...## .....## .###### ##...## ##..... ##...##',
      '##...## ..##... ##...## .....## ##...## ##...## ##..... ##...##',
      '.#####. ..##... .#####. .#####. .###### ######. .#####. .######'],
    ['efghijkl',
      '....... ...###. ....... ##..... ..##... ....##. ##..... .###...',
      '....... ..##... ....... ##..... ....... ....... ##..... ..##...',
      '.#####. ######. .###### ######. .###... ...###. ##..##. ..##...',
      '##...## ..##... ##...## ##...## ..##... ....##. ##.##.. ..##...',
      '####### ..##... .###### ##...## ..##... ....##. ####... ..##...',
      '##..... ..##... .....## ##...## ..##... ##..##. ##.##.. ..##...',
      '.#####. ..##... ######. ##...## .####.. .####.. ##..##. .####..'],
    ['mnopqrst',
      '....... ....... ....... ....... ....... ....... ....... .##....',
      '....... ....... ....... ....... ....... ....... ....... .##....',
      '######. ######. .#####. ######. .###### ######. .###### ######.',
      '##.#.## ##...## ##...## ##...## ##...## ##...## ##..... .##....',
      '##.#.## ##...## ##...## ######. .###### ##..... .#####. .##....',
      '##.#.## ##...## ##...## ##..... .....## ##..... .....## .##....',
      '##.#.## ##...## .#####. ##..... .....## ##..... ######. ..####.'],
    ['uvwxyz!"',
      '....... ....... ....... ....... ....... ....... ..##... .##.##.',
      '....... ....... ....... ....... ....... ....... ..##... .##.##.',
      '##...## ##...## ##...## ##...## ##...## ####### ..##... .##.##.',
      '##...## ##...## ##.#.## .##.##. ##...## ....##. ..##... .......',
      '##...## ##...## ##.#.## ..###.. .###### ..###.. ..##... .......',
      '##...## .##.##. ####### .##.##. .....## .##.... ....... .......',
      '.###### ..###.. .##.##. ##...## ######. ####### ..##... .......'],
    ['#$%&\'()*',
      '.##.##. ..##... ##....# .###... ..##... ...##.. .##.... .......',
      '.##.##. .###### ##...## ##.##.. ..##... ..##... ..##... .##.##.',
      '####### ##.##.. ....##. ##.##.. ..##... .##.... ...##.. ..###..',
      '.##.##. .#####. ...##.. .###... ....... .##.... ...##.. #######',
      '####### ..##.## ..##... ##.##.# ....... .##.... ...##.. ..###..',
      '.##.##. ######. .##..## ##..##. ....... ..##... ..##... .##.##.',
      '.##.##. ..##... #....## .###.## ....... ...##.. .##.... .......'],
    ['+,-./:;<',
      '....... ....... ....... ....... .....## ....... ....... ....##.',
      '..##... ....... ....... ....... ....##. ..##... ..##... ...##..',
      '..##... ....... ....... ....... ....##. ..##... ..##... ..##...',
      '######. ....... .#####. ....... ...##.. ....... ....... .##....',
      '..##... ..##... ....... ....... ..##... ..##... ..##... ..##...',
      '..##... ..##... ....... ..##... ..##... ..##... ..##... ...##..',
      '....... .##.... ....... ..##... .##.... ....... .##.... ....##.'],
    ['=>?@[\\]^',
      '....... .##.... .#####. .#####. .####.. ##..... .####.. ..###..',
      '....... ..##... ##...## ##...## .##.... .##.... ...##.. .##.##.',
      '######. ...##.. .....## ##.#### .##.... .##.... ...##.. ##...##',
      '....... ....##. ...###. ##.#.## .##.... ..##... ...##.. .......',
      '######. ...##.. ..##... ##.#### .##.... ...##.. ...##.. .......',
      '....... ..##... ....... ##..... .##.... ...##.. ...##.. .......',
      '....... .##.... ..##... .###### .####.. ....##. .####.. .......'],
    ['_`{|}~\u00D7\u00B0', //  _ ` { | } ~ multiply degree
      '....... .##.... ...###. ..##... .###... ....... ....... ..###..',
      '....... ..##... ..##... ..##... ...##.. ....... .#...#. .##.##.',
      '....... ....... ..##... ..##... ...##.. .###.## .##.##. ..###..',
      '....... ....... ##..... ..##... .....## ##.###. ..###.. .......',
      '....... ....... ..##... ..##... ...##.. ....... .##.##. .......',
      '....... ....... ..##... ..##... ...##.. ....... .#...#. .......',
      '####### ....... ...###. ..##... .###... ....... ....... .......'],
    ['\u2190\u2192\u2191\u2193\u2605\u25A0\u25B6\u25C0', //  arrows L R U D, star, square, triangles R L
      '...#... ...#... ...#... ..###.. ...#... ....... ##..... .....##',
      '..##... ...##.. ..###.. ..###.. ..###.. .#####. ####... ...####',
      '.###### ######. .#####. ..###.. ####### .#####. ######. .######',
      '####### ####### ####### ####### .#####. .#####. ####### #######',
      '.###### ######. ..###.. .#####. ..###.. .#####. ######. .######',
      '..##... ...##.. ..###.. ..###.. .##.##. .#####. ####... ...####',
      '...#... ...#... ..###.. ...#... .#...#. ....... ##..... .....##'],
    ['\u266A\uFFFD', //  eighth note and the "unknown character" box (also used for U+FFFD)
      '...#### .......',
      '...##.# .#####.',
      '...##.. .#...#.',
      '...##.. .#...#.',
      '.####.. .#...#.',
      '#####.. .#####.',
      '.###... .......'],
  ];

  // Alternative code points rendered with an existing glyph.
  const ALIASES = {
    '\t': ' ', '\u00A0': ' ',
    '\u2018': '\'', '\u2019': '\'', '\u2032': '\'', '\u00B4': '\'',
    '\u201C': '"', '\u201D': '"', '\u2033': '"',
    '\u25BA': '\u25B6', '\u25B8': '\u25B6', '\u25C4': '\u25C0', '\u25C2': '\u25C0',
    '\u2715': '\u00D7', '\u2716': '\u00D7', '\u2606': '\u2605', '\u266B': '\u266A',
    '\u2212': '-', '\u2013': '-', '\u2014': '-', '\u00B7': '.', '\u2022': '\u25A0',
  };

  // ---- parse the sheet ------------------------------------------------------------------
  const chars = [' '];            // glyph index -> character
  const rowsList = [[0, 0, 0, 0, 0, 0, 0, 0]];
  for (const block of SHEET) {
    const list = Array.from(block[0]);
    const segRows = block.slice(1).map((row) => row.split(' '));
    if (segRows.length !== 7) throw new Error('FONT: block "' + block[0] + '" needs 7 rows');
    list.forEach((ch, k) => {
      const rows = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 7; r++) {
        const seg = segRows[r][k];
        if (segRows[r].length !== list.length || !/^[.#]{7}$/.test(seg)) {
          throw new Error('FONT: bad row ' + r + ' of glyph "' + ch + '"');
        }
        let m = 0;
        for (let c = 0; c < 7; c++) if (seg.charCodeAt(c) === 35) m |= 0x80 >> c;
        rows[r] = m;
      }
      chars.push(ch);
      rowsList.push(rows);
    });
  }
  const NUM = chars.length;
  const BITS = new Uint8Array(NUM * 8);
  rowsList.forEach((rows, i) => BITS.set(rows, i * 8));

  const ASCII = new Int16Array(128).fill(-1);
  const INDEX = new Map();
  const setIndex = (cp, gi) => { if (cp < 128) ASCII[cp] = gi; else INDEX.set(cp, gi); };
  chars.forEach((ch, gi) => setIndex(ch.codePointAt(0), gi));
  for (const from in ALIASES) setIndex(from.codePointAt(0), chars.indexOf(ALIASES[from]));
  const SPACE = 0;
  const BOX = chars.indexOf('\uFFFD');

  function indexOfCode(cp) {
    if (cp < 128) { const gi = ASCII[cp]; return gi >= 0 ? gi : BOX; }
    const gi = INDEX.get(cp);
    return gi === undefined ? BOX : gi;
  }
  // Zero-width code points: carriage return, ZW space/joiners, variation selectors, BOM.
  const ignorable = (c) => c === 13 || (c >= 0x200B && c <= 0x200D) || c === 0xFE0E || c === 0xFE0F || c === 0xFEFF;
  const isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;
  const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;
  const toStr = (t) => (t == null ? '' : String(t));
  function scaleOf(v) {
    const s = Math.floor(v == null ? 1 : +v);
    return s >= 1 ? (s > MAX_SCALE ? MAX_SCALE : s) : 1;
  }

  // ---- text metrics & layout (shared by the canvas and the pixel-buffer renderers) ------
  function measure(text, scale) {
    const str = toStr(text);
    const s = scaleOf(scale);
    let max = 0, cnt = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 10) { if (cnt > max) max = cnt; cnt = 0; continue; }
      if (ignorable(c)) continue;
      if (isHigh(c) && i + 1 < str.length && isLow(str.charCodeAt(i + 1))) i++;
      cnt++;
    }
    return (cnt > max ? cnt : max) * CELL_W * s;
  }

  // Placements of the visible glyphs: [glyphIndex, x, y] triples (x,y = cell top-left).
  let PL = new Int32Array(3 * 512);
  function layout(str, x, y, s, align, lineH) {
    const cell = CELL_W * s;
    const len = str.length;
    let n = 0, start = 0, line = 0;
    for (;;) {
      let end = str.indexOf('\n', start);
      if (end < 0) end = len;
      let cnt = 0;
      for (let i = start; i < end; i++) {
        const c = str.charCodeAt(i);
        if (ignorable(c)) continue;
        if (isHigh(c) && i + 1 < end && isLow(str.charCodeAt(i + 1))) i++;
        cnt++;
      }
      const lw = cnt * cell;
      let lx = align === 'center' ? x - lw / 2 : align === 'right' ? x - lw : x;
      lx = Math.round(lx);
      const ly = Math.round(y + line * lineH);
      for (let i = start; i < end; i++) {
        let c = str.charCodeAt(i);
        if (ignorable(c)) continue;
        if (isHigh(c) && i + 1 < end && isLow(str.charCodeAt(i + 1))) {
          c = ((c - 0xD800) << 10) + (str.charCodeAt(i + 1) - 0xDC00) + 0x10000;
          i++;
        }
        const gi = indexOfCode(c);
        if (gi !== SPACE) {
          if (n * 3 + 3 > PL.length) { const bigger = new Int32Array(PL.length * 2); bigger.set(PL); PL = bigger; }
          PL[n * 3] = gi; PL[n * 3 + 1] = lx; PL[n * 3 + 2] = ly;
          n++;
        }
        lx += cell;
      }
      if (end >= len) break;
      start = end + 1;
      line++;
    }
    return n;
  }

  // ---- scaled / sheared glyph masks ------------------------------------------------------
  // Italic: each pixel row of the cell shifts right by floor((8s-1-py)/3): 1 px per 3 rows,
  // rows 5-7 unshifted, top rows +2 at scale 1.
  const shearOf = (py, s) => Math.floor((CELL_H * s - 1 - py) / 3);
  const COLS = 16;
  const ROWS = Math.ceil(NUM / COLS);
  const geoms = new Map();

  // Mask atlas for one (scale, italic) pair; ink = glyph pixels. Every atlas cell has
  // `pad` = scale px of margin so the outline never crosses into a neighbouring cell.
  function geometry(s, italic) {
    const key = s * 2 + (italic ? 1 : 0);
    let g = geoms.get(key);
    if (g) return g;
    const pad = s;
    const cw = CELL_W * s + (italic ? shearOf(0, s) : 0) + 2 * pad;
    const ch = CELL_H * s + 2 * pad;
    const w = cw * COLS, h = ch * ROWS;
    const ink = new Uint8Array(w * h);
    for (let gi = 0; gi < NUM; gi++) {
      const ox = (gi % COLS) * cw + pad, oy = ((gi / COLS) | 0) * ch + pad;
      for (let py = 0; py < CELL_H * s; py++) {
        const bits = BITS[gi * 8 + ((py / s) | 0)];
        if (!bits) continue;
        const row = (oy + py) * w + ox + (italic ? shearOf(py, s) : 0);
        for (let c = 0; c < 8; c++) if (bits & (0x80 >> c)) ink.fill(1, row + c * s, row + c * s + s);
      }
    }
    g = { key, s, italic, pad, cw, ch, w, h, ink, halo: null, base: [null, null] };
    geoms.set(key, g);
    return g;
  }

  // Outline silhouette ("halo"), built lazily: ink dilated by `scale` px in all 8 directions
  // (square dilation = 8-neighbour ring of 1*scale px), with enclosed counters filled.
  // Every counter in this font is 3 glyph px wide, so after a 1*scale outline only a 1-glyph-px
  // sliver of it would stay open; that sliver reads as noise at 1x and, in italic, as the
  // slash of a "0" ("G0AL"). Filling it also keeps a drop shadow from showing through it.
  // Counters = background not 4-connected to the cell border (the outline is 8-connected).
  function haloMask(g) {
    if (g.halo) return g.halo;
    const { s, w, h, cw, ch, ink } = g;
    // Separable square dilation (radius s) with running window counts.
    const tmp = new Uint8Array(w * h), halo = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let sum = 0;
      for (let x = 0; x < s && x < w; x++) sum += ink[o + x];
      for (let x = 0; x < w; x++) {
        if (x + s < w) sum += ink[o + x + s];
        if (x - s - 1 >= 0) sum -= ink[o + x - s - 1];
        tmp[o + x] = sum > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y < s && y < h; y++) sum += tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        if (y + s < h) sum += tmp[(y + s) * w + x];
        if (y - s - 1 >= 0) sum -= tmp[(y - s - 1) * w + x];
        halo[y * w + x] = sum > 0 ? 1 : 0;
      }
    }
    // Fill counters: flood the background from each cell's border; whatever is not reached
    // (tmp is reused as the "outside" flag) becomes outline.
    tmp.fill(0);
    const stack = new Int32Array(cw * ch);
    for (let gi = 0; gi < NUM; gi++) {
      const base = ((gi / COLS) | 0) * ch * w + (gi % COLS) * cw;
      let sp = 0;
      const seed = (lx, ly) => {
        const i = base + ly * w + lx;
        if (!halo[i] && !tmp[i]) { tmp[i] = 1; stack[sp++] = ly * cw + lx; }
      };
      for (let lx = 0; lx < cw; lx++) { seed(lx, 0); seed(lx, ch - 1); }
      for (let ly = 1; ly < ch - 1; ly++) { seed(0, ly); seed(cw - 1, ly); }
      while (sp) {
        const li = stack[--sp], lx = li % cw, ly = (li - lx) / cw;
        if (lx > 0) seed(lx - 1, ly);
        if (lx < cw - 1) seed(lx + 1, ly);
        if (ly > 0) seed(lx, ly - 1);
        if (ly < ch - 1) seed(lx, ly + 1);
      }
      for (let ly = 0; ly < ch; ly++) {
        const i0 = base + ly * w;
        for (let i = i0; i < i0 + cw; i++) if (!tmp[i]) halo[i] = 1;
      }
    }
    g.halo = halo;
    return halo;
  }

  // ---- browser canvas path ---------------------------------------------------------------
  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    throw new Error('FONT.draw: no canvas implementation available');
  }

  // White glyph atlas (kind 0 = ink, 1 = outline silhouette), built once per geometry.
  const maskOf = (g, kind) => (kind ? haloMask(g) : g.ink);
  function baseCanvas(g, kind) {
    let c = g.base[kind];
    if (c) return c;
    c = makeCanvas(g.w, g.h);
    const cx = c.getContext('2d');
    const img = cx.createImageData(g.w, g.h);
    const px = new Uint32Array(img.data.buffer, img.data.byteOffset, g.w * g.h);
    const m = maskOf(g, kind);
    for (let i = 0; i < m.length; i++) if (m[i]) px[i] = 0xffffffff;
    cx.putImageData(img, 0, 0);
    g.base[kind] = c;
    return c;
  }

  // Tinted atlases, LRU-capped by count AND by total pixels (a scale-8 italic atlas is ~0.9 Mpx,
  // so a colour-cycling title must not keep dozens of them alive). Small evicted canvases are
  // recycled; big ones are shrunk to 0x0 so the backing store is freed at once (Safari keeps
  // detached canvas memory until GC and caps the total).
  const TINT_CAP = 64;
  const TINT_BUDGET = 6000000;       // atlas pixels kept in the tint cache (~24 MB)
  const POOL_CAP = 4, POOL_AREA = 1 << 18;
  const tints = new Map();
  const pool = [];
  let tintPx = 0;
  function release(c) {
    if (pool.length < POOL_CAP && c.width * c.height <= POOL_AREA) pool.push(c);
    else { c.width = 0; c.height = 0; }
  }
  const objIds = new WeakMap();      // CanvasGradient / CanvasPattern colours get unique keys
  let nextObjId = 1;
  function colorKey(c) {
    if (typeof c !== 'object' || c === null) return String(c);
    let id = objIds.get(c);
    if (!id) { id = nextObjId++; objIds.set(c, id); }
    return '\u0000obj' + id;
  }
  function tinted(g, kind, color) {
    const key = colorKey(color) + '|' + g.key + '|' + kind;
    let c = tints.get(key);
    if (c) { tints.delete(key); tints.set(key, c); return c; }
    const base = baseCanvas(g, kind);
    const pi = pool.findIndex((p) => p.width === g.w && p.height === g.h);
    c = pi >= 0 ? pool.splice(pi, 1)[0] : makeCanvas(g.w, g.h);
    const cx = c.getContext('2d');
    cx.globalAlpha = 1;
    cx.globalCompositeOperation = 'source-over';
    cx.clearRect(0, 0, g.w, g.h);
    cx.drawImage(base, 0, 0);
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = '#fff';           // an invalid colour string falls back to white
    cx.fillStyle = color;
    cx.fillRect(0, 0, g.w, g.h);
    cx.globalCompositeOperation = 'source-over';
    tints.set(key, c);
    tintPx += g.w * g.h;
    // Never evicts the atlas just built, and always leaves room for the 3 atlases one draw() needs
    // (shadow, outline, fill) so a huge scale cannot rebuild them every frame. An evicted atlas
    // may already have been drawn earlier in this same draw() call; that is safe because
    // drawImage uses the source's content at call time.
    const budget = Math.max(TINT_BUDGET, 3 * g.w * g.h);
    while (tints.size > 1 && (tints.size > TINT_CAP || tintPx > budget)) {
      const oldKey = tints.keys().next().value;
      const old = tints.get(oldKey);
      tints.delete(oldKey);
      tintPx -= old.width * old.height;
      release(old);
    }
    return c;
  }

  function blitAll(ctx, atlas, g, n, ox, oy) {
    const cw = g.cw, ch = g.ch, dx = ox - g.pad, dy = oy - g.pad;
    for (let k = 0; k < n * 3; k += 3) {
      const gi = PL[k];
      ctx.drawImage(atlas, (gi % COLS) * cw, ((gi / COLS) | 0) * ch, cw, ch, PL[k + 1] + dx, PL[k + 2] + dy, cw, ch);
    }
  }

  // Shadow first (the glyphs, or the outlined silhouette when outlined, offset by (s,s)), then
  // the outline, then the glyphs themselves.
  function passes(ctx, g, n, color, shadow, outline, ox, oy) {
    if (shadow) blitAll(ctx, tinted(g, outline ? 1 : 0, shadow), g, n, ox + g.s, oy + g.s);
    if (outline) blitAll(ctx, tinted(g, 1, outline), g, n, ox, oy);
    blitAll(ctx, tinted(g, 0, color), g, n, ox, oy);
  }

  let scratch = null;
  function draw(ctx, text, x, y, opts) {
    const o = opts || {};
    const str = toStr(text);
    const s = scaleOf(o.scale);
    const width = measure(str, s);
    let alpha = o.alpha == null ? 1 : +o.alpha;
    if (!ctx || !str || !(alpha > 0)) return width;
    if (alpha > 1) alpha = 1;
    const color = o.color || '#fff';
    const shadow = o.shadow === true ? '#000' : (o.shadow || null);
    const outline = o.outline === true ? '#000' : (o.outline || null);
    const lh = (o.lineHeight == null || !isFinite(+o.lineHeight) ? LINE_HEIGHT : +o.lineHeight) * s;
    const g = geometry(s, !!o.italic);
    const n = layout(str, +x || 0, +y || 0, s, o.align, lh);
    if (!n) return width;

    const prevAlpha = ctx.globalAlpha;
    const prevSmooth = ctx.imageSmoothingEnabled;
    if (prevSmooth) ctx.imageSmoothingEnabled = false;
    if (alpha < 1 && (shadow || outline)) {
      // Compose the layered text opaque off-screen, then blend it once (no see-through layers).
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < n * 3; k += 3) {
        if (PL[k + 1] < x0) x0 = PL[k + 1];
        if (PL[k + 1] > x1) x1 = PL[k + 1];
        if (PL[k + 2] < y0) y0 = PL[k + 2];
        if (PL[k + 2] > y1) y1 = PL[k + 2];
      }
      x0 -= g.pad; y0 -= g.pad;
      const extra = shadow ? s : 0;
      const w = x1 - g.pad + g.cw + extra - x0, h = y1 - g.pad + g.ch + extra - y0;
      if (!scratch || scratch.width < w || scratch.height < h) {
        const old = scratch;
        scratch = makeCanvas(Math.max(w, old ? old.width : 0), Math.max(h, old ? old.height : 0));
        if (old) { old.width = 0; old.height = 0; }
      }
      const sc = scratch.getContext('2d');
      sc.globalAlpha = 1;
      sc.globalCompositeOperation = 'source-over';
      sc.imageSmoothingEnabled = false;
      sc.clearRect(0, 0, w, h);
      passes(sc, g, n, color, shadow, outline, -x0, -y0);
      ctx.globalAlpha = prevAlpha * alpha;
      ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h);
    } else {
      ctx.globalAlpha = prevAlpha * alpha;
      passes(ctx, g, n, color, shadow, outline, 0, 0);
    }
    ctx.globalAlpha = prevAlpha;
    if (prevSmooth) ctx.imageSmoothingEnabled = prevSmooth;
    return width;
  }

  // ---- pure pixel-buffer path (tests, texture baking) ------------------------------------
  const NAMED = {
    white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255],
    yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128],
    grey: [128, 128, 128], orange: [255, 165, 0],
  };
  const pack = (r, g, b) => ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  function toPacked(c) {
    if (typeof c === 'number') return c >>> 0;
    if (c && typeof c === 'object' && c.length >= 3) return pack(c[0], c[1], c[2]);
    if (typeof c === 'string') {
      const t = c.trim().toLowerCase();
      let m = /^#([0-9a-f]{3,8})$/.exec(t);
      if (m) {
        let hx = m[1];
        if (hx.length <= 4) hx = hx.replace(/./g, (d) => d + d);
        if (hx.length >= 6) return pack(parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16));
      }
      m = /^rgba?\(([^)]*)\)$/.exec(t);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        if (p.length >= 3 && p.slice(0, 3).every(isFinite)) return pack(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]));
      }
      if (NAMED[t]) return pack(...NAMED[t]);
    }
    return 0xffffffff;
  }

  function stamp(buf, bw, bh, g, n, mask, color, ox, oy, cov) {
    const cw = g.cw, ch = g.ch;
    for (let k = 0; k < n * 3; k += 3) {
      const gi = PL[k];
      const sx = (gi % COLS) * cw, sy = ((gi / COLS) | 0) * ch;
      const dx = PL[k + 1] - g.pad + ox, dy = PL[k + 2] - g.pad + oy;
      for (let yy = 0; yy < ch; yy++) {
        const ty = dy + yy;
        if (ty < 0 || ty >= bh) continue;
        const mrow = (sy + yy) * g.w + sx;
        for (let xx = 0; xx < cw; xx++) {
          if (!mask[mrow + xx]) continue;
          const tx = dx + xx;
          if (tx < 0 || tx >= bw) continue;
          buf[ty * bw + tx] = color;
          if (cov) cov[ty * bw + tx] = 1;
        }
      }
    }
  }

  // Same options and result as draw(), rendered into a packed ABGR Uint32Array (w*h).
  // Colours: packed number, [r,g,b], '#rgb', '#rrggbb', 'rgb(r,g,b)' or a basic colour name.
  function drawPixels(buf, bw, bh, text, x, y, opts) {
    const o = opts || {};
    const str = toStr(text);
    const s = scaleOf(o.scale);
    const width = measure(str, s);
    let alpha = o.alpha == null ? 1 : +o.alpha;
    if (!buf || !str || !(alpha > 0)) return width;
    if (alpha > 1) alpha = 1;
    const shadow = o.shadow === true ? '#000' : (o.shadow || null);
    const outline = o.outline === true ? '#000' : (o.outline || null);
    const lh = (o.lineHeight == null || !isFinite(+o.lineHeight) ? LINE_HEIGHT : +o.lineHeight) * s;
    const g = geometry(s, !!o.italic);
    const n = layout(str, +x || 0, +y || 0, s, o.align, lh);
    if (!n) return width;
    const cov = alpha < 1 ? new Uint8Array(bw * bh) : null;
    const dst = alpha < 1 ? new Uint32Array(bw * bh) : buf;
    if (shadow) stamp(dst, bw, bh, g, n, outline ? haloMask(g) : g.ink, toPacked(shadow), s, s, cov);
    if (outline) stamp(dst, bw, bh, g, n, haloMask(g), toPacked(outline), 0, 0, cov);
    stamp(dst, bw, bh, g, n, g.ink, toPacked(o.color || '#fff'), 0, 0, cov);
    if (cov) {
      const ia = 1 - alpha;
      for (let i = 0; i < cov.length; i++) {
        if (!cov[i]) continue;
        const sp = dst[i], dp = buf[i];
        const r = (sp & 255) * alpha + (dp & 255) * ia;
        const gg = ((sp >>> 8) & 255) * alpha + ((dp >>> 8) & 255) * ia;
        const b = ((sp >>> 16) & 255) * alpha + ((dp >>> 16) & 255) * ia;
        const a = 255 * alpha + (dp >>> 24) * ia;
        buf[i] = ((Math.round(a) << 24) | (Math.round(b) << 16) | (Math.round(gg) << 8) | Math.round(r)) >>> 0;
      }
    }
    return width;
  }

  // ---- queries ---------------------------------------------------------------------------
  const firstCode = (ch) => (typeof ch === 'number' ? ch : (toStr(ch).codePointAt(0) ?? 32));
  function glyphBits(ch) {
    const gi = indexOfCode(firstCode(ch));
    return Array.from(BITS.subarray(gi * 8, gi * 8 + 8));
  }
  function hasGlyph(ch) {
    const cp = firstCode(ch);
    return cp === 0xFFFD || indexOfCode(cp) !== BOX;
  }

  return {
    CELL_W, CELL_H, LINE_HEIGHT,
    CHARS: chars.filter((c) => c !== '\uFFFD').join(''),
    draw, measure, glyphBits, hasGlyph, drawPixels,
  };
})();
