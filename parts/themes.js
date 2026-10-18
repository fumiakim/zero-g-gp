// ============================================================================
// ZERO-G GP — THEMES
// Six course environments: palettes, seamless Mode-7 ground tiles and 360°
// panoramas. Everything is generated procedurally from fixed seeds
// (deterministic), in plain JS, without touching the DOM.
// ============================================================================
const THEMES = (() => {
  'use strict';

  // --------------------------------------------------------------------------
  // Colour / math helpers
  // --------------------------------------------------------------------------
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const P = (c) => pack(c[0], c[1], c[2]);
  const add = (c, d) => [clamp(c[0] + d, 0, 255), clamp(c[1] + d, 0, 255), clamp(c[2] + d, 0, 255)];
  const mix = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  const css = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const wrapD = (d, w) => d - Math.round(d / w) * w; // shortest signed distance on a ring

  function makeRng(seed) {
    let a = seed >>> 0;
    const f = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      f,
      r: (lo, hi) => lo + (hi - lo) * f(),
      i: (lo, hi) => lo + Math.floor((hi - lo + 1) * f()),
      pick: (arr) => arr[Math.floor(f() * arr.length)],
    };
  }
  const hash01 = (k, s) => {
    let h = Math.imul((k | 0) ^ Math.imul(s | 0, 0x27d4eb2d), 0x9e3779b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca77);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae3d);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
  const bayer2 = (x, y) => BAYER[(((y >> 1) & 3) << 2) | ((x >> 1) & 3)];

  // Quantise v∈[0,1] onto a ramp of packed colours. Only a narrow band between
  // two steps is ordered-dithered, in 2×2-texel cells (no 1-texel shimmer).
  function ramp2(v, ramp, x, y, sharp) {
    const n = ramp.length - 1;
    const t = v * n;
    if (t <= 0) return ramp[0];
    if (t >= n) return ramp[n];
    let i = t | 0;
    if ((t - i - 0.5) * sharp + 0.5 > bayer2(x, y)) i++;
    return ramp[i];
  }

  function normalize(a) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const s = mx > mn ? 1 / (mx - mn) : 0;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - mn) * s;
    return a;
  }

  // --------------------------------------------------------------------------
  // Periodic noise fields over an S×S tile
  // --------------------------------------------------------------------------
  // adds wt × (periodic smooth value noise with `cells` lattice cells) into out
  function noise2Add(out, S, cells, seed, wt) {
    cells = Math.max(1, cells | 0);
    const R = makeRng(seed);
    const lat = new Float64Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = R.f() * wt;
    const i0 = new Int32Array(S), i1 = new Int32Array(S), fr = new Float64Array(S);
    for (let x = 0; x < S; x++) {
      const g = (x * cells) / S, i = Math.floor(g), f = g - i;
      i0[x] = i % cells;
      i1[x] = (i + 1) % cells;
      fr[x] = f * f * f * (f * (f * 6 - 15) + 10);
    }
    // separable bilinear: lerp the two lattice rows once per texel row, then along x
    const rv = new Float64Array(cells);
    for (let y = 0; y < S; y++) {
      const ra = i0[y] * cells, rb = i1[y] * cells, fy = fr[y], row = y * S;
      for (let c = 0; c < cells; c++) rv[c] = lat[ra + c] + (lat[rb + c] - lat[ra + c]) * fy;
      for (let x = 0; x < S; x++) {
        const a = rv[i0[x]];
        out[row + x] += a + (rv[i1[x]] - a) * fr[x];
      }
    }
    return out;
  }
  // octs: [[featureSizePx, weight], ...] → normalised to exactly 0..1
  function fbm(S, octs, seed) {
    const out = new Float32Array(S * S);
    for (let k = 0; k < octs.length; k++) noise2Add(out, S, Math.round(S / octs[k][0]), seed + k * 7919, octs[k][1]);
    return normalize(out);
  }
  // bilinear sample of a wrapping field
  function sampleW(F, S, x, y) {
    const M = S - 1;
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const a = F[(yi & M) * S + (xi & M)], b = F[(yi & M) * S + ((xi + 1) & M)];
    const c = F[((yi + 1) & M) * S + (xi & M)], d = F[((yi + 1) & M) * S + ((xi + 1) & M)];
    return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy;
  }
  // domain-warp a field by two warp fields (amplitude in px)
  function warpField(F, S, wx, wy, amp) {
    const out = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        out[i] = sampleW(F, S, x + (wx[i] - 0.5) * amp, y + (wy[i] - 0.5) * amp);
      }
    return out;
  }

  // Periodic jittered-grid Voronoi. at(x, y) fills `q`: edge = distance (px)
  // to the nearest cell border, (vx, vy) = pixel - own site, id = cell index.
  // Query single texels lazily, or build whole fields with voronoi().
  function makeVoronoi(S, cellPx, seed, jitter) {
    const n = Math.max(3, Math.round(S / cellPx)), cs = S / n, R = makeRng(seed);
    const jt = jitter === undefined ? 0.85 : jitter;
    const sx = new Float32Array(n * n), sy = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        sx[j * n + i] = (i + 0.5 + (R.f() - 0.5) * jt) * cs;
        sy[j * n + i] = (j + 0.5 + (R.f() - 0.5) * jt) * cs;
      }
    // sites padded by one wrapped ring of cells: index (j+1)*N2 + (i+1), i,j ∈ [-1, n]
    const N2 = n + 2, px2 = new Float64Array(N2 * N2), py2 = new Float64Array(N2 * N2), id2 = new Int32Array(N2 * N2);
    for (let j = -1; j <= n; j++)
      for (let i = -1; i <= n; i++) {
        const jj = (j + n) % n, ii = (i + n) % n, k = jj * n + ii, o = (j + 1) * N2 + (i + 1);
        px2[o] = sx[k] + (i < 0 ? -S : i >= n ? S : 0);
        py2[o] = sy[k] + (j < 0 ? -S : j >= n ? S : 0);
        id2[o] = k;
      }
    const q = { id: 0, edge: 0, vx: 0, vy: 0 };
    const at = (x, y) => {
      const px = x + 0.5, py = y + 0.5;
      const cx = Math.min(n - 1, Math.floor(px / cs)), cy = Math.min(n - 1, Math.floor(py / cs));
      let d1 = 1e12, d2 = 1e12, k1 = 0, ax = 0, ay = 0, bx = 0, by = 0;
      for (let dj = 0; dj < 3; dj++) {
        const o0 = (cy + dj) * N2 + cx;
        for (let di = 0; di < 3; di++) {
          const o = o0 + di, qx = px2[o], qy = py2[o];
          const d = (qx - px) * (qx - px) + (qy - py) * (qy - py);
          if (d < d1) { d2 = d1; bx = ax; by = ay; d1 = d; k1 = id2[o]; ax = qx; ay = qy; }
          else if (d < d2) { d2 = d; bx = qx; by = qy; }
        }
      }
      q.id = k1;
      q.vx = px - ax;
      q.vy = py - ay;
      q.edge = (d2 - d1) / (2 * (Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1));
      return q;
    };
    return { n, q, at };
  }
  function voronoi(S, cellPx, seed, jitter) {
    const V = makeVoronoi(S, cellPx, seed, jitter), N = S * S;
    const id = new Int32Array(N), edge = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const q = V.at(x, y), o = y * S + x;
        id[o] = q.id; edge[o] = q.edge; vx[o] = q.vx; vy[o] = q.vy;
      }
    return { n: V.n, id, edge, vx, vy };
  }

  // --------------------------------------------------------------------------
  // Wrapping tile canvas (packed ABGR)
  // --------------------------------------------------------------------------
  function makeTile(S, fill) {
    const M = S - 1, px = new Uint32Array(S * S);
    if (fill !== undefined) px.fill(fill);
    const set = (x, y, c) => { px[((y & M) * S) + (x & M)] = c; };
    const get = (x, y) => px[((y & M) * S) + (x & M)];
    const rect = (x, y, w, h, c) => {
      x = Math.round(x); y = Math.round(y);
      for (let j = 0; j < h; j++) {
        const row = ((y + j) & M) * S;
        for (let i = 0; i < w; i++) px[row + ((x + i) & M)] = c;
      }
    };
    const disc = (cx, cy, r, c) => {
      cx = Math.round(cx); cy = Math.round(cy);
      const R2 = r * r + r * 0.6, ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++)
        for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= R2) set(cx + dx, cy + dy, c);
    };
    const ellipse = (cx, cy, rx, ry, c) => {
      cx = Math.round(cx); cy = Math.round(cy);
      const ix = Math.ceil(rx), iy = Math.ceil(ry);
      for (let dy = -iy; dy <= iy; dy++)
        for (let dx = -ix; dx <= ix; dx++)
          if ((dx * dx) / (rx * rx + 0.5) + (dy * dy) / (ry * ry + 0.5) <= 1) set(cx + dx, cy + dy, c);
    };
    // raised slab: lit top/left edges, dark bottom/right edges
    const bevel = (x, y, w, h, base, lite, dark, t) => {
      t = t || 2;
      rect(x, y, w, h, base);
      rect(x, y, w, t, lite);
      rect(x, y, t, h, lite);
      rect(x, y + h - t, w, t, dark);
      rect(x + w - t, y, t, h, dark);
    };
    return { S, M, px, set, get, rect, disc, ellipse, bevel };
  }

  // Remove isolated single texels (a texel differing from all 4 neighbours
  // shimmers under Mode-7 sampling); it takes the colour of a neighbour.
  // One pass can leave a few behind where isolated texels touch each other
  // (1-px diagonal lines), so repeat until clean (bounded).
  function despeckle(px, S) {
    const M = S - 1;
    const fix = (src, i) => {
      const x = i & M, y = (i - x) / S, row = y * S, v = src[i];
      const l = src[row + ((x - 1) & M)], r = src[row + ((x + 1) & M)];
      const u = src[((y - 1) & M) * S + x], d = src[((y + 1) & M) * S + x];
      if (v === l || v === r || v === u || v === d) return false;
      px[i] = l === r || l === u || l === d ? l : r === u || r === d ? r : u === d ? u : l;
      return true;
    };
    let src = px.slice(), changed = [];
    for (let i = 0; i < S * S; i++) if (fix(src, i)) changed.push(i);
    // only texels next to a changed one can have become isolated
    for (let pass = 1; pass < 4 && changed.length; pass++) {
      src = px.slice();
      const seen = new Set(), next = [];
      for (const i of changed) {
        const x = i & M, y = (i - x) / S;
        for (const j of [i, y * S + ((x - 1) & M), y * S + ((x + 1) & M), ((y - 1) & M) * S + x, ((y + 1) & M) * S + x]) {
          if (seen.has(j)) continue;
          seen.add(j);
          if (fix(src, j)) next.push(j);
        }
      }
      changed = next;
    }
    return px;
  }
  // cyclic shift of a periodic tile (keeps it seamless)
  function roll(px, S, dx, dy) {
    const out = new Uint32Array(S * S), M = S - 1;
    for (let y = 0; y < S; y++) {
      const dst = ((y + dy) & M) * S;
      for (let x = 0; x < S; x++) out[dst + ((x + dx) & M)] = px[y * S + x];
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Panorama canvas helpers (RGBA, wraps horizontally)
  // --------------------------------------------------------------------------
  function makePano(w, h) {
    const d = new Uint8ClampedArray(w * h * 4);
    const ix = (x, y) => (y * w + (((x % w) + w) % w)) * 4;
    const set = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (y < 0 || y >= h) return;
      const i = ix(x, y);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    };
    const get = (x, y) => {
      const i = ix(Math.round(x), clamp(Math.round(y), 0, h - 1));
      return [d[i], d[i + 1], d[i + 2]];
    };
    const blend = (x, y, c, a) => {
      x = Math.round(x); y = Math.round(y);
      if (y < 0 || y >= h) return;
      const i = ix(x, y);
      d[i] += (c[0] - d[i]) * a; d[i + 1] += (c[1] - d[i + 1]) * a; d[i + 2] += (c[2] - d[i + 2]) * a;
    };
    // elevation e: 0 = horizon row (h-1), growing upward
    const setE = (x, e, c) => set(x, h - 1 - e, c);
    const blendE = (x, e, c, a) => blend(x, h - 1 - e, c, a);
    const getE = (x, e) => get(x, h - 1 - e);
    return { w, h, d, set, get, blend, setE, blendE, getE };
  }

  // banded sky: cols top→bottom, narrow ordered-dither transitions between bands
  function sky(Pn, cols, sharp, curve) {
    const { w, h, d } = Pn, n = cols.length;
    for (let y = 0; y < h; y++) {
      const t = Math.pow(y / (h - 1), curve) * (n - 1);
      const i = Math.min(n - 2, t | 0);
      const f = (t - i - 0.5) * sharp + 0.5;
      const A = cols[i], B = cols[i + 1];
      for (let x = 0; x < w; x++) {
        const c = f > bayer(x, y) ? B : A, k = (y * w + x) * 4;
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
    }
  }

  // bottom rows fade into the horizon haze; the last two rows are exactly `fog`
  function fogFade(Pn, fog, rows) {
    const { w, h, d } = Pn;
    for (let r = 0; r < rows; r++) {
      const y = h - 1 - r;
      if (y < 0) break;
      const a = r < 2 ? 1 : 1 - (r - 1) / rows;
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        d[k] = Math.round(d[k] + (fog[0] - d[k]) * a);
        d[k + 1] = Math.round(d[k + 1] + (fog[1] - d[k + 1]) * a);
        d[k + 2] = Math.round(d[k + 2] + (fog[2] - d[k + 2]) * a);
      }
    }
  }

  // nearest-neighbour rescale of an RGBA strip; column mapping keeps the
  // horizontal wrap, and the last row always comes from the (fog) bottom row
  function resamplePano(src, sw, sh, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    const xs = new Int32Array(w);
    for (let x = 0; x < w; x++) xs[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
    for (let y = 0; y < h; y++) {
      const sy = y === h - 1 ? sh - 1 : Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
      for (let x = 0; x < w; x++) {
        const s = (sy * sw + xs[x]) * 4, o = (y * w + x) * 4;
        out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255;
      }
    }
    return out;
  }

  // periodic 1-D noise (Catmull-Rom), wraps over w
  function noise1(w, cells, seed) {
    cells = Math.max(2, cells | 0);
    const R = makeRng(seed), lat = new Float32Array(cells);
    for (let i = 0; i < cells; i++) lat[i] = R.f();
    const out = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const g = (x * cells) / w, i = Math.floor(g), t = g - i;
      const p0 = lat[(i - 1 + cells) % cells], p1 = lat[i % cells], p2 = lat[(i + 1) % cells], p3 = lat[(i + 2) % cells];
      out[x] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    }
    return out;
  }
  function fbm1(w, octs, seed) {
    const out = new Float32Array(w);
    octs.forEach(([px, wt], k) => {
      const n = noise1(w, Math.round(w / px), seed + k * 101);
      for (let x = 0; x < w; x++) out[x] += n[x] * wt;
    });
    return normalize(out);
  }
  // 2-D value noise over the panorama, periodic in x only
  function noisePano(w, h, fx, fy, seed) {
    const cx = Math.max(2, Math.round(w / fx)), cy = Math.max(2, Math.ceil(h / fy) + 1);
    const R = makeRng(seed), lat = new Float32Array(cx * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = R.f();
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const gy = y / fy, j = Math.floor(gy), ty0 = gy - j, ty = ty0 * ty0 * (3 - 2 * ty0);
      for (let x = 0; x < w; x++) {
        const gx = (x * cx) / w, i = Math.floor(gx), tx0 = gx - i, tx = tx0 * tx0 * (3 - 2 * tx0);
        const i0 = i % cx, i1 = (i + 1) % cx, j0 = Math.min(j, cy - 1), j1 = Math.min(j + 1, cy - 1);
        const a = lat[j0 * cx + i0], b = lat[j0 * cx + i1], c = lat[j1 * cx + i0], e = lat[j1 * cx + i1];
        out[y * w + x] = a + (b - a) * tx + (c - a + (a - b - c + e) * tx) * ty;
      }
    }
    return out;
  }

  function line(Pn, x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      Pn.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // Puffy shapes (clouds, smoke). puffs: [{x, y, r}] in pano px (y = row).
  // cols = [shadow, body, highlight]; (lx,ly) = direction towards the light.
  // floorY (optional) clips everything below a flat base (cumulus bottoms).
  function puffs(Pn, list, cols, lx, ly, floorY) {
    const { w, h } = Pn, M = new Uint8Array(w * h);
    const disc = (cx, cy, r, v) => {
      const ri = Math.ceil(r), R2 = r * r + r * 0.5;
      for (let dy = -ri; dy <= ri; dy++) {
        const y = Math.round(cy) + dy;
        if (y < 0 || y >= h || (floorY !== undefined && y > floorY)) continue;
        for (let dx = -ri; dx <= ri; dx++) {
          if (dx * dx + dy * dy > R2) continue;
          const x = (((Math.round(cx) + dx) % w) + w) % w;
          M[y * w + x] = v;
        }
      }
    };
    for (const p of list) {
      disc(p.x - lx * p.r * 0.28, p.y - ly * p.r * 0.28, p.r, 1);
      disc(p.x, p.y, p.r * 0.86, 2);
      disc(p.x + lx * p.r * 0.32, p.y + ly * p.r * 0.32, p.r * 0.52, 3);
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = M[y * w + x];
        if (!v) continue;
        // flat bottoms: last 2 rows above the floor are shadow
        if (floorY !== undefined && y >= floorY - 1) v = 1;
        Pn.set(x, y, cols[v - 1]);
      }
  }

  // Smoke column: union of discs shaded as one mass (no beaded look): glowing
  // underside rims, dark crowns, noise billows inside. cols = [dark, body, lit, rim]
  function smoke(Pn, list, cols, tex) {
    const { w, h } = Pn, M = new Uint8Array(w * h);
    for (const p of list) {
      const ri = Math.ceil(p.r), R2 = p.r * p.r + p.r * 0.5;
      for (let dy = -ri; dy <= ri; dy++) {
        const y = Math.round(p.y) + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= R2) M[y * w + ((((Math.round(p.x) + dx) % w) + w) % w)] = 1;
      }
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!M[y * w + x]) continue;
        const b1 = y + 1 < h ? M[(y + 1) * w + x] : 1, b2 = y + 2 < h ? M[(y + 2) * w + x] : 1;
        const a1 = y > 0 ? M[(y - 1) * w + x] : 1;
        const t = tex[y * w + x];
        let c;
        if (!b1) c = cols[3];
        else if (!b2) c = cols[2];
        else if (!a1) c = cols[0];
        else if (t > 0.6) c = cols[0];
        else if (t < 0.32) c = t < 0.22 && bayer(x, y) < 0.5 ? cols[2] : cols[1];
        else c = cols[1];
        Pn.set(x, y, c);
      }
  }

  // ==========================================================================
  // GROUND TILES
  // ==========================================================================

  // ---------------------------------------------------------------- NEON CITY
  function groundNeon(S) {
    const R = makeRng(0x4e0c1701);
    const ALLEY = P([12, 10, 28]);
    const T = makeTile(S, ALLEY);
    const per = S >= 256 ? 128 : Math.max(32, S >> 1);
    const AV = 20;
    const C = {
      ave: P([30, 26, 58]), lane: P([150, 158, 204]), cross: P([70, 66, 112]),
      walk: P([42, 38, 76]), shadow: P([7, 5, 18]),
      gC: P([40, 226, 255]), gCd: P([24, 98, 156]),
      gM: P([255, 66, 206]), gMd: P([122, 32, 126]),
    };
    // --- avenues (horizontal: cyan glow, vertical: magenta glow)
    for (let a = 0; a < S; a += per) {
      T.rect(0, a, S, AV, C.ave);
      T.rect(0, a, S, 2, C.gC); T.rect(0, a + 2, S, 2, C.gCd);
      T.rect(0, a + AV - 4, S, 2, C.gCd); T.rect(0, a + AV - 2, S, 2, C.gC);
      for (let x = 0; x < S; x += 16) T.rect(x + 4, a + 9, 8, 2, C.lane);
    }
    for (let b = 0; b < S; b += per) {
      T.rect(b, 0, AV, S, C.ave);
      T.rect(b, 0, 2, S, C.gM); T.rect(b + 2, 0, 2, S, C.gMd);
      T.rect(b + AV - 4, 0, 2, S, C.gMd); T.rect(b + AV - 2, 0, 2, S, C.gM);
      for (let y = 0; y < S; y += 16) T.rect(b + 9, y + 4, 2, 8, C.lane);
    }
    for (let a = 0; a < S; a += per)
      for (let b = 0; b < S; b += per) {
        T.rect(b, a, AV, AV, C.ave);
        for (let s = 4; s < AV - 4; s += 4) {
          T.rect(b - 8, a + s, 6, 2, C.cross); T.rect(b + AV + 2, a + s, 6, 2, C.cross);
          T.rect(b + s, a - 8, 2, 6, C.cross); T.rect(b + s, a + AV + 2, 2, 6, C.cross);
        }
        // corner lamp posts
        T.rect(b - 2, a - 2, 2, 2, C.gC); T.rect(b + AV, a + AV, 2, 2, C.gM);
      }
    // --- traffic
    const CARS = [[206, 44, 64], [52, 100, 214], [214, 216, 230], [238, 188, 48], [92, 92, 120], [40, 176, 126]];
    const HEAD = P([255, 250, 214]), TAIL = P([236, 28, 44]);
    const car = (x, y, horiz, dir) => {
      const body = R.pick(CARS), b = P(body), roof = P(add(body, -46));
      if (horiz) {
        T.rect(x, y, 8, 4, b); T.rect(x + 2, y + 1, 4, 2, roof);
        T.rect(dir > 0 ? x + 7 : x, y, 1, 4, HEAD); T.rect(dir > 0 ? x : x + 7, y, 1, 4, TAIL);
      } else {
        T.rect(x, y, 4, 8, b); T.rect(x + 1, y + 2, 2, 4, roof);
        T.rect(x, dir > 0 ? y + 7 : y, 4, 1, HEAD); T.rect(x, dir > 0 ? y : y + 7, 4, 1, TAIL);
      }
    };
    for (let a = 0; a < S; a += per)
      for (let b = 0; b < S; b += per) {
        for (let s = b + AV + 10; s + 8 < b + per - 10; s += 14) {
          if (R.f() < 0.4) car(s, a + 5, true, 1);
          if (R.f() < 0.4) car(s, a + 11, true, -1);
        }
        for (let s = a + AV + 10; s + 8 < a + per - 10; s += 14) {
          if (R.f() < 0.4) car(b + 5, s, false, -1);
          if (R.f() < 0.4) car(b + 11, s, false, 1);
        }
      }
    // --- city blocks
    const blds = [];
    const split = (x, y, w, h, d) => {
      if (w < 8 || h < 8) return;
      const cx = w >= 46, cy = h >= 46;
      if ((!cx && !cy) || d >= 4 || (d >= 2 && R.f() < 0.4)) { blds.push([x, y, w, h]); return; }
      const vert = cx && (!cy || (w > h ? R.f() < 0.8 : R.f() < 0.25));
      if (vert) {
        const s = Math.round(w * R.r(0.36, 0.64));
        split(x, y, s - 2, h, d + 1);
        split(x + s + 2, y, w - s - 2, h, d + 1);
      } else {
        const s = Math.round(h * R.r(0.36, 0.64));
        split(x, y, w, s - 2, d + 1);
        split(x, y + s + 2, w, h - s - 2, d + 1);
      }
    };
    for (let a = 0; a < S; a += per)
      for (let b = 0; b < S; b += per) {
        const x0 = b + AV, y0 = a + AV, bw = per - AV;
        T.rect(x0, y0, bw, bw, C.walk);
        T.rect(x0 + 3, y0 + 3, bw - 6, bw - 6, ALLEY);
        split(x0 + 3, y0 + 3, bw - 6, bw - 6, 0);
      }
    for (const [x, y, w, h] of blds) T.rect(x + 3, y + 3, w, h, C.shadow);

    const ROOF = [[38, 40, 80], [50, 44, 92], [30, 50, 78], [58, 52, 98], [44, 36, 68], [34, 60, 92], [64, 46, 88]];
    const WARM = P([255, 206, 98]), COOL = P([124, 234, 255]), PINK = P([255, 120, 222]);
    const NEON = [C.gM, C.gC, PINK, P([255, 230, 90])];
    for (const [x, y, w, h] of blds) {
      const base = R.pick(ROOF);
      T.bevel(x, y, w, h, P(base), P(add(base, 32)), P(add(base, -18)), 2);
      const m = Math.min(w, h), roll = R.f();
      if (roll < 0.3 && m >= 22) {
        // stepped tower top with beacon
        let ix = x, iy = y, iw = w, ih = h, b = base;
        for (let t = 0; t < 3 && iw > 16 && ih > 16; t++) {
          const ins = R.i(4, 6);
          ix += ins; iy += ins; iw -= ins * 2; ih -= ins * 2; b = add(b, 16);
          T.rect(ix + 2, iy + 2, iw, ih, P(add(base, -22)));
          T.bevel(ix, iy, iw, ih, P(b), P(add(b, 32)), P(add(b, -18)), 2);
        }
        const cx = ix + (iw >> 1) - 2, cy = iy + (ih >> 1) - 2;
        T.rect(cx, cy, 4, 4, P([120, 20, 44]));
        T.rect(cx + 1, cy + 1, 2, 2, P([255, 74, 96]));
      } else if (roll < 0.56 && m >= 14) {
        // lit skylights / windows grid
        const warm = R.f() < 0.6, pLit = R.r(0.35, 0.7), dark = P(add(base, -12));
        for (let yy = y + 4; yy + 3 <= y + h - 4; yy += 6)
          for (let xx = x + 4; xx + 4 <= x + w - 4; xx += 7) {
            const r = R.f();
            T.rect(xx, yy, 4, 3, r < pLit ? (R.f() < 0.8 ? (warm ? WARM : COOL) : warm ? COOL : WARM) : dark);
          }
      } else if (roll < 0.66 && m >= 34) {
        // helipad
        const cx = x + (w >> 1), cy = y + (h >> 1), rr = (m >> 1) - 6;
        const ring = P([236, 196, 60]), pad = P(add(base, 10));
        T.disc(cx, cy, rr, ring);
        T.disc(cx, cy, rr - 2, pad);
        const H = P([232, 232, 244]);
        T.rect(cx - 5, cy - 5, 2, 11, H); T.rect(cx + 3, cy - 5, 2, 11, H); T.rect(cx - 3, cy - 1, 6, 2, H);
        const L = P([255, 70, 90]);
        T.rect(x + 3, y + 3, 2, 2, L); T.rect(x + w - 5, y + 3, 2, 2, L);
        T.rect(x + 3, y + h - 5, 2, 2, L); T.rect(x + w - 5, y + h - 5, 2, 2, L);
      } else if (roll < 0.72 && m >= 20) {
        // rooftop pool
        T.rect(x + 5, y + 5, w - 10, h - 10, P([190, 196, 216]));
        T.rect(x + 7, y + 7, w - 14, h - 14, P([30, 170, 226]));
        T.rect(x + 7, y + 7, w - 14, 2, P([130, 232, 255]));
      } else {
        // machinery: AC boxes with fans
        const n = R.i(2, 4) + (m > 40 ? 2 : 0);
        for (let k = 0; k < n; k++) {
          const bw = R.i(6, 10), bh = R.i(6, 9);
          if (w - 8 - bw < 1 || h - 8 - bh < 1) continue;
          const bx = x + 4 + R.i(0, w - 8 - bw), by = y + 4 + R.i(0, h - 8 - bh);
          T.rect(bx + 2, by + 2, bw, bh, P(add(base, -24)));
          T.bevel(bx, by, bw, bh, P([112, 118, 148]), P([162, 170, 196]), P([74, 78, 104]), 1);
          T.rect(bx + (bw >> 1) - 1, by + (bh >> 1) - 1, 3, 3, P([50, 52, 74]));
        }
      }
      // neon trim along one roof edge
      if (R.f() < 0.4 && m >= 18) {
        const c = R.pick(NEON), side = R.i(0, 3);
        if (side === 0) T.rect(x + 3, y + 3, w - 6, 2, c);
        else if (side === 1) T.rect(x + 3, y + h - 5, w - 6, 2, c);
        else if (side === 2) T.rect(x + 3, y + 3, 2, h - 6, c);
        else T.rect(x + w - 5, y + 3, 2, h - 6, c);
      }
    }
    // shift so the avenue grid does not line up with the tile edges
    const o = Math.round(per * 0.37);
    return despeckle(roll(T.px, S, o, o), S);
  }

  // --------------------------------------------------------------- BLUE COAST
  function groundCoast(S) {
    const R = makeRng(0xc0a57001);
    const M = S - 1;
    const depth = fbm(S, [[170, 0.55], [80, 0.3], [30, 0.15]], 0xc0a51);
    const warp = fbm(S, [[128, 0.65], [50, 0.35]], 0xc0a52);
    const foam = fbm(S, [[64, 0.7], [24, 0.3]], 0xc0a53);
    const ramp = [[10, 30, 96], [14, 44, 126], [20, 62, 156], [28, 84, 184], [40, 110, 206], [62, 140, 224]].map(P);
    const reef = [[28, 112, 176], [40, 146, 190], [74, 184, 204], [150, 214, 214]].map(P);
    const STREAK = P([104, 170, 236]);
    const SURF = P([236, 248, 255]), SAND = P([232, 214, 156]), SAND2 = P([246, 232, 184]);
    const kx1 = 1, ky1 = Math.max(2, Math.round(S / 58));
    const kx2 = -Math.max(1, Math.round(S / 120)), ky2 = Math.max(1, Math.round(S / 85));
    const ph1 = (x, y) => (TAU * (kx1 * x + ky1 * y)) / S + 4.2 * warp[((y & M) * S) + (x & M)];
    const px = new Uint32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x, wv = warp[i];
        const s1 = Math.sin((TAU * (kx1 * x + ky1 * y)) / S + 4.2 * wv);
        const s2 = Math.sin((TAU * (kx2 * x + ky2 * y)) / S + 3.0 * wv);
        const dp = depth[i];
        const v = 0.5 * dp + 0.3 * (0.5 + 0.5 * s1) + 0.2 * (0.5 + 0.5 * s2);
        let c;
        if (dp > 0.965) c = dp > 0.975 ? (dp > 0.99 ? SAND2 : SAND) : SURF;
        else if (dp > 0.86) c = ramp2(((dp - 0.86) / 0.105) * 0.8 + (0.5 + 0.5 * s1) * 0.2, reef, x, y, 2.5);
        else if (dp > 0.83) c = bayer2(x, y) < (dp - 0.83) / 0.03 ? reef[0] : ramp2(v, ramp, x, y, 2.5);
        else c = ramp2(v, ramp, x, y, 2.5);
        if (s1 > 0.965 && foam[i] > 0.42 && dp < 0.83) c = STREAK;
        px[i] = c;
      }
    const T = { S, M, px, set: (x, y, c) => { px[((y & M) * S) + (x & M)] = c; } };
    // white caps along the swell crests
    const WHITE = P([244, 250, 255]), FOAM = P([168, 214, 246]), FACE = P([14, 42, 120]);
    const want = Math.round((S * S) / 1400);
    for (let placed = 0, tries = 0; placed < want && tries < want * 30; tries++) {
      const x = R.i(0, S - 1), y = R.i(0, S - 1);
      if (Math.sin(ph1(x, y)) < 0.82 || depth[y * S + x] > 0.78) continue;
      placed++;
      const gx = ph1(x + 1, y) - ph1(x - 1, y), gy = ph1(x, y + 1) - ph1(x, y - 1);
      let dx = gy, dy = -gx;
      const l0 = Math.hypot(dx, dy) || 1;
      dx /= l0; dy /= l0;
      if (dx < 0) { dx = -dx; dy = -dy; }
      const L = R.i(6, 15), half = L / 2;
      for (let t = -half; t <= half; t += 0.5) {
        const qx = Math.round(x + dx * t), qy = Math.round(y + dy * t);
        const end = Math.abs(t) > half - 2;
        if (!end) T.set(qx, qy - 1, FACE);
        T.set(qx, qy, WHITE);
        T.set(qx, qy + 1, end ? FOAM : WHITE);
        if (!end) T.set(qx, qy + 2, FOAM);
      }
    }
    return despeckle(px, S);
  }

  // ----------------------------------------------------------------- DUNE SEA
  function groundDesert(S) {
    const R = makeRng(0xd5e70001);
    const M = S - 1;
    const dn = fbm(S, [[256, 0.6], [110, 0.3], [48, 0.1]], 0xd5e71);
    const warp = fbm(S, [[90, 0.6], [36, 0.4]], 0xd5e72);
    const pan = fbm(S, [[150, 0.7], [60, 0.3]], 0xd5e73);
    const H = new Float32Array(S * S);
    for (let i = 0; i < H.length; i++) {
      const r = 1 - Math.abs(2 * dn[i] - 1);
      H[i] = r * r * 0.8 + dn[i] * 0.2;
    }
    const ramp = [[118, 50, 30], [156, 74, 40], [192, 100, 52], [220, 130, 66], [238, 160, 88], [248, 190, 118], [252, 218, 156]].map(P);
    const clay = [[196, 140, 92], [218, 166, 112], [234, 190, 136]].map(P);
    const CRACK = P([150, 92, 58]);
    const V = makeVoronoi(S, 18, 0xd5e74, 0.9);
    const rx = 5, ry = Math.max(4, Math.round(S / 11));
    const px = new Uint32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const gx = H[y * S + ((x + 2) & M)] - H[y * S + ((x - 2) & M)];
        const gy = H[((y + 2) & M) * S + x] - H[((y - 2) & M) * S + x];
        const sh = clamp((gx + gy) * 9, -0.32, 0.32);
        const ph = (rx * x + ry * y) / S + 1.3 * warp[i] + 1.6 * dn[i];
        const t = ph - Math.floor(ph);
        const rip = t < 0.68 ? 0.05 * (t / 0.68) : -0.09;
        const pv = pan[i];
        if (pv > 0.8) {
          const cv = 0.5 + sh * 0.8 + (pv - 0.8) * 1.2;
          px[i] = V.at(x, y).edge < 1.0 ? CRACK : ramp2(cv, clay, x, y, 3);
          continue;
        }
        const ripAmt = pv > 0.74 ? (0.8 - pv) / 0.06 : 1;
        const v = 0.55 + sh + rip * ripAmt + (dn[i] - 0.5) * 0.12;
        let c = ramp2(v, ramp, x, y, 2.6);
        if (pv > 0.77 && bayer2(x, y) < (pv - 0.77) / 0.03) c = clay[1];
        px[i] = c;
      }
    const T = makeTile(S);
    T.px.set(px);
    // scattered rocks with cast shadows
    const SHAD = P([150, 72, 42]), ROCK = P([98, 52, 38]), RLIT = P([156, 96, 66]), RHI = P([196, 138, 96]);
    const nR = Math.round((S * S) / 9000);
    for (let k = 0; k < nR; k++) {
      const x = R.i(0, S - 1), y = R.i(0, S - 1);
      if (pan[y * S + x] > 0.76) continue;
      const r = R.r(2.5, 6);
      T.ellipse(x + r * 0.7, y + r * 0.5, r * 1.15, r * 0.8, SHAD);
      T.disc(x, y, r, ROCK);
      T.disc(x - 1, y - 1, r - 1.5, RLIT);
      if (r > 3.5) T.rect(Math.round(x - r * 0.5) - 1, Math.round(y - r * 0.5) - 1, 2, 2, RHI);
      for (let p = 0; p < 3; p++) {
        const ax = x + R.i(-10, 10), ay = y + R.i(-8, 8);
        T.rect(ax + 1, ay + 1, 2, 2, SHAD);
        T.rect(ax, ay, 2, 2, ROCK);
      }
    }
    return despeckle(T.px, S);
  }

  // ------------------------------------------------------------- STORM VALLEY
  function groundGale(S) {
    const R = makeRng(0x6a1e0001);
    const M = S - 1;
    const H = fbm(S, [[140, 0.45], [56, 0.35], [20, 0.2]], 0x6a11);
    const moss = fbm(S, [[90, 0.7], [30, 0.3]], 0x6a12);
    const V = voronoi(S, 44, 0x6a13, 0.9);
    const rock = [[62, 74, 60], [80, 94, 76], [98, 114, 92], [118, 134, 110], [142, 156, 130]].map(P);
    const mossR = [[56, 76, 44], [72, 96, 54], [90, 118, 64], [110, 138, 76], [132, 158, 92]].map(P);
    const CRACK = P([34, 42, 36]);
    const PUD = P([38, 50, 62]), PUDL = P([70, 88, 104]), RIM = P([112, 130, 138]);
    const T = makeTile(S);
    const px = T.px;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x, h = H[i];
        if (h < 0.2) {
          // rain puddles: dark water with a bright sky reflection band
          const up = H[((y - 3) & M) * S + x];
          px[i] = up >= 0.2 ? RIM : h < 0.12 && ((x + y * 3) & 31) < 10 ? PUDL : PUD;
          continue;
        }
        const gx = H[y * S + ((x + 2) & M)] - H[y * S + ((x - 2) & M)];
        const gy = H[((y + 2) & M) * S + x] - H[((y - 2) & M) * S + x];
        let v = 0.5 + clamp((gx + gy) * 6, -0.3, 0.3) + (hash01(V.id[i], 77) - 0.5) * 0.22 + (h - 0.5) * 0.25;
        const e = V.edge[i];
        if (e < 1.2) { px[i] = CRACK; continue; }
        if (e < 3.5) v += V.vx[i] + V.vy[i] < 0 ? 0.14 : -0.16;
        px[i] = ramp2(v, moss[i] > 0.62 ? mossR : rock, x, y, 2.6);
      }
    // metal plates with grates
    const MB = P([96, 104, 108]), ML = P([152, 160, 162]), MD = P([46, 50, 54]);
    const SL = P([128, 136, 140]), SLH = P([170, 176, 178]), GAP = P([28, 30, 34]);
    const RIV = P([196, 200, 202]), HZY = P([224, 184, 40]), HZK = P([40, 36, 30]);
    const SHADOW = P([30, 36, 32]);
    const cell = S >= 256 ? 128 : S >> 1;
    for (let cy = 0; cy < S; cy += cell)
      for (let cx = 0; cx < S; cx += cell) {
        if (R.f() > 0.5) continue;
        const w = R.i(56, 104), h = R.i(36, 72);
        const x = cx + R.i(0, cell - 1), y = cy + R.i(0, cell - 1);
        T.rect(x + 3, y + 3, w, h, SHADOW);
        T.bevel(x, y, w, h, MB, ML, MD, 3);
        T.rect(x + 5, y + 5, w - 10, h - 10, GAP);
        for (let yy = y + 6; yy + 3 <= y + h - 5; yy += 6) {
          T.rect(x + 5, yy, w - 10, 3, SL);
          T.rect(x + 5, yy, w - 10, 1, SLH);
        }
        T.rect(x + 1, y + 1, 2, 2, RIV); T.rect(x + w - 3, y + 1, 2, 2, RIV);
        T.rect(x + 1, y + h - 3, 2, 2, RIV); T.rect(x + w - 3, y + h - 3, 2, 2, RIV);
        if (R.f() < 0.6) {
          // hazard band below the plate
          for (let j = 0; j < 6; j++)
            for (let i = 0; i < w; i++) T.set(x + i, y + h + 3 + j, ((i + j) >> 2) & 1 ? HZK : HZY);
        }
      }
    // pipes (wrap across the tile)
    const PIPE = [[34, 36, 38], [76, 80, 82], [124, 128, 128], [160, 164, 162], [118, 122, 122], [92, 96, 98], [64, 68, 70], [36, 38, 40]].map(P);
    const FL = P([170, 150, 120]), FLD = P([96, 80, 60]);
    const hp = [R.i(0, S - 1)], vp = [R.i(0, S - 1)];
    if (S >= 512) hp.push((hp[0] + (S >> 1) + R.i(-40, 40)) & M);
    for (const y0 of hp) {
      T.rect(0, y0 + 9, S, 3, SHADOW);
      for (let j = 0; j < 8; j++) T.rect(0, y0 + j, S, 1, PIPE[j]);
      for (let x = R.i(0, 47); x < S; x += 64) {
        T.rect(x, y0 - 2, 4, 12, FL); T.rect(x + 3, y0 - 2, 1, 12, FLD); T.rect(x, y0 + 9, 4, 1, FLD);
      }
    }
    for (const x0 of vp) {
      T.rect(x0 + 9, 0, 3, S, SHADOW);
      for (let j = 0; j < 8; j++) T.rect(x0 + j, 0, 1, S, PIPE[j]);
      for (let y = R.i(0, 47); y < S; y += 64) {
        T.rect(x0 - 2, y, 12, 4, FL); T.rect(x0 - 2, y + 3, 12, 1, FLD); T.rect(x0 + 9, y, 1, 4, FLD);
      }
    }
    return despeckle(px, S);
  }

  // -------------------------------------------------------------- FROST LINE
  function groundFrost(S) {
    const R = makeRng(0xf2050001);
    const M = S - 1;
    const H = fbm(S, [[150, 0.6], [64, 0.32], [28, 0.08]], 0xf2051);
    const iceN = fbm(S, [[110, 0.7], [40, 0.3]], 0xf2052);
    const grove = fbm(S, [[120, 0.75], [40, 0.25]], 0xf2053);
    const V = makeVoronoi(S, 46, 0xf2054, 0.95);
    const crackM = fbm(S, [[56, 0.7], [20, 0.3]], 0xf2055);
    const snow = [[150, 172, 216], [180, 200, 236], [208, 222, 246], [230, 239, 252], [248, 251, 255]].map(P);
    const ice = [[72, 136, 204], [100, 164, 224], [134, 194, 240], [172, 220, 250], [210, 240, 255]].map(P);
    const CRK = P([52, 98, 176]), CRKL = P([226, 246, 255]), BANK = P([252, 254, 255]), SHINE = P([228, 248, 255]);
    const IT = 0.74;
    const T = makeTile(S);
    const px = T.px;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const gx = H[y * S + ((x + 2) & M)] - H[y * S + ((x - 2) & M)];
        const gy = H[((y + 2) & M) * S + x] - H[((y - 2) & M) * S + x];
        const sh = clamp((gx + gy) * 7, -0.35, 0.3);
        const iv = iceN[i];
        if (iv > IT) {
          // frozen pond: pale shallow rim → deep blue centre, sparse long cracks, glossy streaks
          if (crackM[i] > 0.52) {
            const q = V.at(x, y);
            if (q.edge < 1.1) { px[i] = CRK; continue; }
            if (q.edge < 2.2 && q.vx + q.vy > 0) { px[i] = CRKL; continue; }
          }
          const s = (x + y) & 63;
          if (iv > IT + 0.03 && (s < 3 || (s >= 6 && s < 8))) { px[i] = SHINE; continue; }
          px[i] = ramp2(1 - (iv - IT) * 3.2 + (H[i] - 0.5) * 0.3, ice, x, y, 2.5);
        } else if (iv > IT - 0.018) px[i] = BANK;
        else px[i] = ramp2(0.62 + sh + (H[i] - 0.5) * 0.22, snow, x, y, 2.4);
      }
    // pine trees (Poisson-ish, clustered in groves)
    const trees = [];
    const tries = Math.round((S * S) / 60);
    for (let k = 0; k < tries; k++) {
      const x = R.r(0, S), y = R.r(0, S), i = (y | 0) * S + (x | 0);
      const g = grove[i];
      if (iceN[i] > IT - 0.08 || g < 0.5 || R.f() > (g - 0.5) * 3) continue;
      const r = R.r(6.5, 12);
      let ok = true;
      for (const t of trees) {
        const dx = wrapD(t.x - x, S), dy = wrapD(t.y - y, S);
        if (dx * dx + dy * dy < (t.r + r) * (t.r + r) * 0.55) { ok = false; break; }
      }
      if (ok) trees.push({ x, y, r, ph: R.r(0, TAU), ph2: R.r(0, TAU) });
    }
    const TSH = P([150, 170, 212]);
    for (const t of trees) T.ellipse(t.x + t.r * 0.75, t.y + t.r * 0.55, t.r * 1.05, t.r * 0.8, TSH);
    trees.sort((a, b) => a.y - b.y);
    const G0 = P([14, 48, 50]), G1 = P([28, 82, 70]), G2 = P([52, 116, 86]), SN = P([236, 244, 255]), SN2 = P([196, 214, 240]);
    for (const t of trees) {
      const ri = Math.ceil(t.r) + 1, cx = Math.round(t.x), cy = Math.round(t.y);
      for (let dy = -ri; dy <= ri; dy++)
        for (let dx = -ri; dx <= ri; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx);
          const in0 = d <= t.r * (0.8 + 0.2 * Math.cos(8 * a + t.ph));
          if (!in0) continue;
          const d1 = Math.sqrt((dx + 1) * (dx + 1) + (dy + 1) * (dy + 1)), a1 = Math.atan2(dy + 1, dx + 1);
          const in1 = d1 <= t.r * 0.66 * (0.82 + 0.18 * Math.cos(7 * a1 + t.ph2));
          const in2 = (dx + 2) * (dx + 2) + (dy + 2) * (dy + 2) <= t.r * 0.3 * t.r * 0.3;
          let c;
          if (in2) c = G2;
          else if (in1) c = dx + dy < -t.r * 0.25 ? SN : G1;
          else c = dx + dy < -t.r * 0.35 ? SN : dx + dy < 0 ? SN2 : G0;
          T.set(cx + dx, cy + dy, c);
        }
    }
    // a few snow-capped rocks
    const RK = P([86, 94, 112]), RKD = P([58, 64, 82]);
    for (let k = 0; k < Math.round((S * S) / 26000); k++) {
      const x = R.i(0, S - 1), y = R.i(0, S - 1);
      if (iceN[y * S + x] > IT - 0.05) continue;
      const r = R.r(3, 5);
      T.ellipse(x + 2, y + 2, r + 1, r * 0.7, TSH);
      T.disc(x, y, r, RKD);
      T.disc(x - 1, y - 1, r - 1, RK);
      T.disc(x - 1, y - 2, r - 2, SN);
    }
    return despeckle(px, S);
  }

  // -------------------------------------------------------------- MAGMA FIELD
  function groundInferno(S) {
    const R = makeRng(0x1f3e0001);
    const M = S - 1;
    const V = makeVoronoi(S, 22, 0x1f3e1, 0.75);
    const L0 = fbm(S, [[210, 0.55], [90, 0.3], [36, 0.15]], 0x1f3e2);
    const wx = fbm(S, [[100, 0.7], [40, 0.3]], 0x1f3e6), wy = fbm(S, [[100, 0.7], [40, 0.3]], 0x1f3e7);
    const L = warpField(L0, S, wx, wy, 60);
    const W = fbm(S, [[120, 1]], 0x1f3e3);
    const crustN = fbm(S, [[40, 0.6], [16, 0.4]], 0x1f3e4);
    const Vc = makeVoronoi(S, 11, 0x1f3e5, 0.9);
    const basalt = [[20, 16, 24], [30, 24, 34], [42, 34, 44], [58, 48, 58], [76, 64, 72]].map(P);
    const hot = [[38, 14, 18], [56, 20, 22], [76, 28, 26], [100, 38, 30], [130, 52, 34]].map(P);
    const lava = [[150, 26, 14], [222, 70, 20], [255, 136, 30], [255, 200, 64], [255, 242, 168]].map(P);
    const CRK = P([10, 8, 12]), CRKH = P([110, 30, 18]), CRUST = P([50, 20, 18]), CRUST2 = P([70, 30, 22]), GLOW = P([255, 112, 28]);
    const px = new Uint32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const wid = 0.028 + 0.05 * W[i] * W[i];
        const d = Math.abs(L[i] - 0.5) / wid;
        if (d < 1) {
          if (crustN[i] > 0.6 && d < 0.85) {
            const q = Vc.at(x, y);
            px[i] = q.edge < 1.1 ? GLOW : q.vx + q.vy < 0 ? CRUST2 : CRUST;
            continue;
          }
          px[i] = ramp2(1 - d, lava, x, y, 2.4);
          continue;
        }
        const q = V.at(x, y), e = q.edge;
        if (e < 1.15) { px[i] = d < 1.3 ? CRKH : CRK; continue; }
        let v = 0.42 + (hash01(q.id, 9) - 0.5) * 0.3;
        if (e < 3.2) v += q.vx + q.vy < 0 ? 0.24 : -0.2;
        px[i] = ramp2(v, d < 1.9 ? hot : basalt, x, y, 2.6);
      }
    // glowing fissures and small vents in the basalt
    const T = makeTile(S);
    T.px.set(px);
    for (let k = 0; k < Math.round((S * S) / 22000); k++) {
      let x = R.i(0, S - 1), y = R.i(0, S - 1);
      const i = y * S + x;
      if (Math.abs(L[i] - 0.5) < 0.12) continue;
      T.disc(x, y, 3.5, P([90, 26, 18]));
      T.disc(x, y, 2.2, GLOW);
      T.rect(x - 1, y - 1, 2, 2, P([255, 220, 110]));
    }
    return despeckle(T.px, S);
  }

  // ==========================================================================
  // PANORAMAS (w = 360°, row h-1 sits on the horizon)
  // ==========================================================================

  // ---------------------------------------------------------------- NEON CITY
  function panoNeon(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0x4e0c0002);
    sky(Pn, [[6, 4, 20], [12, 8, 38], [24, 10, 60], [42, 14, 86], [70, 20, 114], [108, 30, 138], [150, 44, 158], [190, 64, 170]], 3, 1.55);
    // stars
    for (let s = 0, n = Math.round(w / 7); s < n; s++) {
      const x = R.i(0, w - 1), y = Math.floor(Math.pow(R.f(), 1.7) * h * 0.55), b = R.f();
      if (b > 0.94) {
        Pn.set(x, y, [255, 255, 255]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) Pn.set(x + dx, y + dy, [150, 140, 214]);
      } else Pn.set(x, y, b > 0.6 ? [206, 200, 244] : [108, 98, 168]);
    }
    // crescent moon with dithered halo
    const mx = Math.round(w * 0.71), my = 15, mr = 8;
    for (let dy = -mr - 5; dy <= mr + 5; dy++)
      for (let dx = -mr - 5; dx <= mr + 5; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > mr + 0.5 && d < mr + 5 && bayer(mx + dx, my + dy) < ((mr + 5 - d) / 4.5) * 0.55) Pn.blend(mx + dx, my + dy, [190, 120, 230], 0.45);
        if (d <= mr + 0.3) {
          const shadow = Math.hypot(dx - 4, dy + 3) <= mr - 0.4;
          let c = shadow ? [60, 36, 104] : dx + dy < -5 ? [255, 244, 255] : [238, 206, 248];
          if (!shadow && ((dx === -3 && dy === 2) || (dx === -2 && dy === 2) || (dx === -5 && dy === -1) || (dx === 1 && dy === 5))) c = [206, 168, 226];
          Pn.set(mx + dx, my + dy, c);
        }
      }
    // searchlight beams
    for (const [bx, ang] of [[w * 0.18, 0.32], [w * 0.215, -0.22], [w * 0.56, 0.18], [w * 0.88, -0.3]]) {
      for (let e = 0; e < h; e++) {
        const c = bx + e * Math.tan(ang), half = 0.6 + e * 0.07;
        for (let x = Math.floor(c - half); x <= Math.ceil(c + half); x++) Pn.blendE(x, e, [196, 150, 255], 0.13 * (1 - e / h));
      }
    }
    // far skyline
    const hN = fbm1(w, [[260, 0.7], [70, 0.3]], 0x4e0c0003);
    const FAR = [34, 18, 70], FARW = [120, 66, 170], FARTOP = [60, 30, 104];
    for (let x = 0; x < w; ) {
      let bw = R.i(7, 18);
      if (w - x - bw < 7) bw = w - x;
      const bh = Math.round(16 + hN[x] * 32 + R.r(-4, 6));
      const style = R.f(), lit = R.r(0.1, 0.35), seed = R.i(0, 1e6);
      for (let i = 0; i < bw; i++)
        for (let e = 0; e <= bh; e++) {
          let c = e === bh ? FARTOP : FAR;
          if (i > 0 && i < bw - 1 && (i & 1) && e % 3 === 1 && e < bh - 1 && hash01(i * 97 + e, seed) < lit) c = FARW;
          Pn.setE(x + i, e, c);
        }
      if (style < 0.2) {
        const cx = x + (bw >> 1), ah = R.i(4, 10);
        for (let e = bh + 1; e <= bh + ah; e++) Pn.setE(cx, e, FAR);
        Pn.setE(cx, bh + ah + 1, [255, 70, 80]);
      } else if (style < 0.35 && bw > 8) {
        const sh = R.i(3, 6);
        for (let i = 2; i < bw - 2; i++) for (let e = bh + 1; e <= bh + sh; e++) Pn.setE(x + i, e, FAR);
      } else if (style < 0.45) {
        for (let k = 1; k <= bw >> 1; k++) for (let i = k; i < bw - k; i++) Pn.setE(x + i, bh + k, FAR);
      }
      x += bw;
    }
    // landmark needle tower
    {
      const tx = Math.round(w * 0.42);
      for (let e = 0; e < 56; e++) { Pn.setE(tx, e, FAR); Pn.setE(tx + 1, e, FAR); if (e < 20) { Pn.setE(tx - 1, e, FAR); Pn.setE(tx + 2, e, FAR); } }
      for (let dx = -5; dx <= 6; dx++) for (let e = 42; e <= 46; e++) if (Math.abs(dx - 0.5) < 5.5 - (e === 42 || e === 46 ? 1 : 0)) Pn.setE(tx + dx, e, e === 46 ? FARTOP : FAR);
      for (let dx = -3; dx <= 4; dx += 2) Pn.setE(tx + dx, 44, [120, 230, 255]);
      for (let e = 56; e < 64; e++) Pn.setE(tx, e, FAR);
      Pn.setE(tx, 64, [255, 70, 80]);
    }
    // near skyline
    const hN2 = fbm1(w, [[180, 0.6], [50, 0.4]], 0x4e0c0004);
    const NEAR = [18, 10, 36], NTOP = [44, 24, 76];
    const WINC = [[255, 212, 112], [118, 232, 255], [244, 240, 255], [255, 140, 220]];
    const SIGN = [[255, 66, 206], [40, 226, 255], [255, 230, 90], [130, 255, 140]];
    for (let x = 0; x < w; ) {
      let bw = R.i(9, 24);
      if (w - x - bw < 9) bw = w - x;
      const bh = Math.round(8 + hN2[x] * 28 + R.r(-3, 5));
      const ws = R.i(0, 2), lit = R.r(0.18, 0.55), seed = R.i(0, 1e6);
      const wc = R.pick(WINC), wc2 = R.pick(WINC);
      for (let i = 0; i < bw; i++)
        for (let e = 0; e <= bh; e++) {
          let c = e === bh ? NTOP : NEAR;
          if (i > 0 && i < bw - 1 && e < bh - 1 && e > 1) {
            let win = false;
            if (ws === 0) win = (i & 1) === 1 && (e & 1) === 0;
            else if (ws === 1) win = i % 3 !== 0 && e % 3 === 1;
            else win = e % 4 === 2;
            const hv = hash01((ws === 2 ? (i >> 2) : i) * 131 + e, seed);
            if (win && hv < lit) c = hv < lit * 0.8 ? wc : wc2;
          }
          Pn.setE(x + i, e, c);
        }
      const s = R.f();
      if (s < 0.3 && bw >= 12 && bh >= 9) {
        const sc = R.pick(SIGN), sw = bw - 4, se = bh - 5;
        for (let i = 0; i < sw; i++)
          for (let e = 0; e < 3; e++) Pn.setE(x + 2 + i, se + e, e === 1 && i > 0 && i < sw - 1 ? mix(sc, [255, 255, 255], 0.35) : sc);
      } else if (s < 0.5 && bh >= 14) {
        const sc = R.pick(SIGN), sx = x + (R.f() < 0.5 ? 1 : bw - 3);
        for (let e = bh - 12; e < bh - 2; e++) { Pn.setE(sx, e, sc); Pn.setE(sx + 1, e, e & 1 ? mix(sc, [255, 255, 255], 0.4) : sc); }
      } else if (s < 0.62) {
        const cx = x + R.i(2, bw - 3);
        for (let e = bh + 1; e <= bh + 3; e++) Pn.setE(cx, e, NEAR);
        Pn.setE(cx, bh + 4, [255, 64, 72]);
      } else if (s < 0.72 && bw >= 10) {
        const tx = x + R.i(2, bw - 7);
        for (let i = 0; i < 4; i++) for (let e = bh + 2; e <= bh + 4; e++) Pn.setE(tx + i, e, NEAR);
        Pn.setE(tx, bh + 1, NEAR); Pn.setE(tx + 3, bh + 1, NEAR);
      }
      x += bw;
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // --------------------------------------------------------------- BLUE COAST
  function panoCoast(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0xc0a50002);
    sky(Pn, [[26, 74, 192], [36, 92, 210], [50, 114, 228], [68, 136, 238], [92, 160, 246], [120, 184, 250], [152, 204, 252], [182, 222, 254]], 3, 1.1);
    // sun with dithered rays
    const sx = Math.round(w * 0.36), sy = 11;
    for (let dy = -14; dy <= 14; dy++)
      for (let dx = -14; dx <= 14; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= 4.6) Pn.set(sx + dx, sy + dy, d < 3 ? [255, 255, 246] : [255, 246, 200]);
        else if (d < 13 && bayer(sx + dx, sy + dy) < ((13 - d) / 8.4) * 0.7) Pn.blend(sx + dx, sy + dy, [255, 252, 226], 0.55);
      }
    // high cirrus streaks
    for (let k = 0; k < Math.round(w / 90); k++) {
      const x0 = R.i(0, w - 1), y = R.i(4, 26), len = R.i(16, 60);
      for (let i = 0; i < len; i++) Pn.blend(x0 + i, y + (i > len * 0.6 ? 1 : 0), [236, 244, 255], 0.35);
    }
    // cumulus banks
    const CL = [[178, 198, 232], [234, 242, 252], [255, 255, 255]];
    const groups = Math.round(w / 190);
    for (let g = 0; g < groups; g++) {
      const cx = ((g + R.r(0.1, 0.9)) * w) / groups, base = R.i(34, 50), gw = R.i(60, 150), tall = R.r(0.3, 1), list = [];
      for (let k = 0, n = Math.round(gw / 4.5); k < n; k++) {
        const u = R.r(-1, 1), mid = 1 - Math.abs(u), r = R.r(4, 11) * (0.45 + mid * 0.55);
        list.push({ x: cx + (u * gw) / 2, y: base - r * R.r(0.3, 0.9) - mid * mid * tall * R.r(4, 14), r });
      }
      list.sort((a, b) => a.y - b.y);
      puffs(Pn, list, CL, -0.55, -0.7, base);
    }
    // low distant cloud bank above the sea
    const CL2 = [[176, 202, 236], [206, 224, 246], [228, 238, 252]];
    // clustered banks (density field) instead of a string of equal beads
    const low = [], dens = fbm1(w, [[120, 0.7], [40, 0.3]], 0xc0a50005);
    for (let x = 0; x < w; x += 3) {
      const dv = dens[x];
      if (dv < 0.36) continue;
      const k = (dv - 0.36) / 0.64;
      low.push({ x: x + R.r(-1, 1), y: h - 11 - k * R.r(1, 4), r: 2.4 + k * R.r(2.5, 6) });
    }
    low.sort((a, b) => a.y - b.y);
    puffs(Pn, low, CL2, -0.5, -0.7, h - 10);
    // distant sea line
    for (let x = 0; x < w; x++) {
      Pn.setE(x, 6, [92, 150, 222]);
      Pn.setE(x, 7, (x * 7) % 23 < 3 ? [190, 220, 250] : [74, 132, 214]);
      Pn.setE(x, 8, [110, 166, 230]);
    }
    // islands
    const jag = fbm1(w, [[18, 0.6], [7, 0.4]], 0xc0a50003);
    const isl = [
      { x: 0.08, hw: 70, h: 12, far: true }, { x: 0.24, hw: 34, h: 9, far: false, lh: true },
      { x: 0.47, hw: 90, h: 18, far: true }, { x: 0.58, hw: 26, h: 7, far: false },
      { x: 0.79, hw: 52, h: 13, far: false, palms: true }, { x: 0.93, hw: 44, h: 10, far: true },
    ];
    for (const I of isl) {
      const cx = Math.round(I.x * w);
      const body = I.far ? [104, 150, 188] : [44, 112, 84], top = I.far ? [134, 176, 206] : [82, 152, 98];
      const shade = I.far ? [90, 134, 176] : [32, 88, 70];
      for (let dx = -I.hw; dx <= I.hw; dx++) {
        const u = dx / I.hw;
        const eTop = Math.round(6 + I.h * Math.pow(1 - u * u, 0.8) + (jag[(cx + dx + w) % w] - 0.5) * (I.far ? 2 : 3));
        for (let e = 6; e <= eTop; e++) {
          let c = e >= eTop - 1 ? top : dx > (6 + I.h - e) * (I.hw / I.h) * 0.5 && e < eTop - 1 ? shade : body;
          if (!I.far && e <= 7) c = [232, 220, 168];
          Pn.setE(cx + dx, e, c);
        }
      }
      if (I.lh) {
        const lx = cx - 8, lb = 6 + Math.round(I.h * 0.9);
        for (let e = lb; e < lb + 9; e++) { const c = ((e - lb) >> 1) & 1 ? [226, 40, 40] : [250, 250, 250]; Pn.setE(lx, e, c); Pn.setE(lx + 1, e, c); }
        Pn.setE(lx, lb + 9, [255, 236, 120]); Pn.setE(lx + 1, lb + 9, [255, 236, 120]);
        Pn.setE(lx - 1, lb + 10, [60, 60, 70]); Pn.setE(lx, lb + 10, [60, 60, 70]); Pn.setE(lx + 1, lb + 10, [60, 60, 70]); Pn.setE(lx + 2, lb + 10, [60, 60, 70]);
      }
      if (I.palms) {
        for (const off of [-20, -9, 4, 15]) {
          const px = cx + off, u = off / I.hw, base = Math.round(6 + I.h * Math.pow(1 - u * u, 0.8)) - 1;
          const th = R.i(5, 8);
          for (let e = 0; e < th; e++) Pn.setE(px + (e > th / 2 ? 1 : 0), base + e, [96, 70, 44]);
          const tx = px + 1, te = base + th;
          for (const [dx, de] of [[-3, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [3, -1], [-1, 1], [1, 1], [-4, -2], [4, -2]]) Pn.setE(tx + dx, te + de, [30, 104, 56]);
        }
      }
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // ----------------------------------------------------------------- DUNE SEA
  function panoDesert(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0xd5e70002);
    const SKY = [[44, 18, 74], [76, 26, 98], [118, 36, 116], [164, 52, 122], [204, 76, 116], [232, 106, 100], [248, 140, 88], [255, 174, 100]];
    sky(Pn, SKY, 3, 0.95);
    // a few early stars in the purple top
    for (let s = 0; s < w / 30; s++) Pn.set(R.i(0, w - 1), R.i(0, 9), R.f() < 0.3 ? [255, 220, 240] : [150, 90, 160]);
    // big banded sunset sun
    const sx = Math.round(w * 0.18), sr = 19, se = 27;
    const SUN = [[255, 248, 196], [255, 226, 140], [255, 196, 100], [255, 160, 80]];
    for (let de = -sr - 8; de <= sr + 8; de++)
      for (let dx = -sr - 8; dx <= sr + 8; dx++) {
        const d = Math.hypot(dx, de), e = se + de;
        if (e < 0) continue;
        if (d <= sr + 0.4) {
          const below = -de;
          const gap = below > 2 && (below - 2) % 5 >= 5 - Math.min(3, 1 + ((below - 2) / 5) | 0);
          if (gap) continue;
          Pn.setE(sx + dx, e, SUN[clamp(Math.floor(((sr - de) / (2 * sr)) * 4), 0, 3)]);
        } else if (d < sr + 8 && bayer(sx + dx, h - 1 - e) < ((sr + 8 - d) / 8) * 0.6) Pn.blendE(sx + dx, e, [255, 210, 140], 0.4);
      }
    // thin horizontal cloud streaks
    for (let k = 0; k < Math.round(w / 70); k++) {
      const x0 = R.i(0, w - 1), y = R.i(10, 40), len = R.i(20, 70);
      const c = y < 24 ? [210, 90, 140] : [255, 170, 120];
      for (let i = 0; i < len; i++) { Pn.set(x0 + i, y, c); if (i > 4 && i < len - 6) Pn.set(x0 + i + 2, y + 1, mix(c, [120, 40, 90], 0.45)); }
    }
    // mesas (far = hazy, near = dark with lit rims)
    const jag = fbm1(w, [[20, 0.6], [6, 0.4]], 0xd5e70003);
    // flat-topped buttes: cap-rock rim, horizontal strata, sunlit left cliff, talus skirt
    const mesa = (cx, top, hgt, talus, col, rim, band) => {
      const half = top + talus, side = R.f() < 0.5 ? -1 : 1;
      const stepW = Math.round(top * R.r(0.15, 0.4)), stepH = R.i(2, 5), ph = R.i(0, 5);
      for (let dx = -half; dx <= half; dx++) {
        const a = Math.abs(dx), jg = jag[(((cx + dx) % w) + w) % w] - 0.5;
        let eTop;
        const cliff = a <= top;
        if (cliff) eTop = hgt + Math.round(jg * 2) - (dx * side > top - stepW ? stepH : 0);
        else eTop = Math.round(hgt * 0.55 * Math.pow(1 - (a - top) / talus, 1.3) + jg * 2);
        for (let e = 0; e <= eTop; e++) {
          let c = col;
          if (cliff && e >= eTop - 1) c = rim;
          else if (cliff && dx < -top + 3) c = rim;
          else if (!cliff) c = e === eTop ? col : band;
          else if ((e + ph) % 6 < 2) c = band;
          Pn.setE(cx + dx, e, c);
        }
      }
    };
    const sunX = Math.round(w * 0.18), pyx = Math.round(w * 0.56);
    const place = (cx, keep) => {
      for (const [ax, rr] of [[sunX, keep], [pyx, 110]]) if (Math.abs(wrapD(cx - ax, w)) < rr) cx = ax + rr * Math.sign(wrapD(cx - ax, w) || 1);
      return cx;
    };
    for (let k = 0; k < 8; k++) mesa(place(Math.round(((k + 0.5) / 8) * w + R.r(-40, 40)), 85), R.i(12, 34), R.i(20, 34), R.i(10, 20), [178, 86, 98], [214, 116, 110], [162, 76, 94]);
    for (let k = 0; k < 5; k++) mesa(place(Math.round(((k + 0.25) / 5) * w + R.r(-30, 30)), 70), R.i(10, 26), R.i(13, 22), R.i(8, 14), [112, 42, 62], [236, 124, 92], [94, 34, 56]);
    // pyramids
    for (const [ox, hw] of [[0, 40], [-60, 18], [62, 26]]) {
      const cx = pyx + ox, hh = Math.round(hw * 0.92);
      for (let dx = -hw; dx <= hw; dx++) {
        const eTop = Math.round(hh * (1 - Math.abs(dx) / hw));
        for (let e = 0; e <= eTop; e++) {
          const lit = dx < 0;
          let c = lit ? [236, 150, 96] : [138, 62, 66];
          if (e % 3 === 0 && e > 0) c = lit ? [214, 124, 84] : [120, 52, 60];
          if (dx === 0) c = [255, 196, 130];
          Pn.setE(cx + dx, e, c);
        }
      }
    }
    // foreground dune line
    const dune = fbm1(w, [[160, 0.7], [40, 0.3]], 0xd5e70004);
    for (let x = 0; x < w; x++) {
      const t = Math.round(3 + dune[x] * 6);
      for (let e = 0; e <= t; e++) Pn.setE(x, e, e === t ? [252, 186, 110] : [222, 128, 80]);
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // ------------------------------------------------------------- STORM VALLEY
  function panoGale(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0x6a1e0002);
    sky(Pn, [[18, 22, 28], [26, 32, 38], [36, 44, 50], [48, 58, 62], [62, 74, 76], [78, 92, 90], [96, 110, 104], [112, 126, 118]], 3, 1.0);
    const tex = noisePano(w, h, 40, 8, 0x6a1e0003);
    // storm cloud banks: scalloped lower edges, silver rims, dark bellies
    const layers = [
      { base: 24, amp: 10, col: [62, 74, 78], dark: [50, 60, 66], rim: [116, 128, 124], seed: 11 },
      { base: 37, amp: 10, col: [42, 50, 58], dark: [32, 38, 46], rim: [90, 100, 102], seed: 12 },
      { base: 52, amp: 8, col: [26, 30, 38], dark: [18, 22, 28], rim: [62, 70, 78], seed: 13 },
    ];
    for (const L of layers) {
      const n = fbm1(w, [[160, 0.6], [50, 0.4]], 0x6a1e0100 + L.seed);
      const gap = fbm1(w, [[220, 1]], 0x6a1e0200 + L.seed);
      const edge = new Float32Array(w);
      for (let x = 0; x < w; ) {
        let bw = R.i(8, 22);
        if (w - x - bw < 8) bw = w - x;
        const dep = R.r(2, 5);
        for (let i = 0; i < bw; i++) {
          const u = (i + 0.5) / bw * 2 - 1;
          // breaks in the cloud deck: a gentle lift only, so the scalloped
          // edge survives (a steep lift rendered as straight diagonal ramps)
          edge[x + i] = L.base + (n[x + i] - 0.5) * L.amp * 2 - dep * Math.sqrt(1 - u * u) + (gap[x + i] > 0.74 ? (gap[x + i] - 0.74) * 46 : 0);
        }
        x += bw;
      }
      for (let x = 0; x < w; x++) {
        const eb = Math.round(edge[x]);
        for (let e = Math.max(0, eb); e < h; e++) {
          const y = h - 1 - e;
          let c;
          if (e === eb) c = L.rim;
          else if (e <= eb + 2) c = L.dark;
          else c = tex[y * w + x] > 0.62 && bayer(x, y) < (tex[y * w + x] - 0.62) * 4 ? L.dark : tex[y * w + x] < 0.3 ? mix(L.col, L.rim, 0.25) : L.col;
          Pn.set(x, y, c);
        }
      }
    }
    // light shafts
    for (const sx of [w * 0.12, w * 0.47, w * 0.81]) {
      for (let e = 4; e < 30; e++) for (let i = 0; i < 9; i++) Pn.blendE(sx + i + (30 - e) * 0.6, e, [190, 200, 180], 0.08);
    }
    // lightning bolt
    {
      let x = w * 0.64, e = 47;
      const pts = [[x, e]];
      while (e > 8) { e -= R.i(3, 5); x += R.i(-3, 3); pts.push([x, e]); }
      for (let k = 1; k < pts.length; k++) {
        const [x0, e0] = pts[k - 1], [x1, e1] = pts[k];
        line(Pn, x0 - 1, h - 1 - e0, x1 - 1, h - 1 - e1, [120, 130, 190]);
        line(Pn, x0 + 1, h - 1 - e0, x1 + 1, h - 1 - e1, [120, 130, 190]);
      }
      for (let k = 1; k < pts.length; k++) line(Pn, pts[k - 1][0], h - 1 - pts[k - 1][1], pts[k][0], h - 1 - pts[k][1], [236, 238, 255]);
      const m = pts[Math.floor(pts.length / 2)];
      line(Pn, m[0], h - 1 - m[1], m[0] + 7, h - 1 - m[1] + 6, [200, 206, 250]);
    }
    // ridges
    const r1 = fbm1(w, [[200, 0.6], [60, 0.3], [16, 0.1]], 0x6a1e0004);
    const r2 = fbm1(w, [[140, 0.6], [40, 0.3], [10, 0.1]], 0x6a1e0005);
    const top1 = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const t1 = Math.round(6 + r1[x] * 18);
      top1[x] = t1;
      for (let e = 0; e <= t1; e++) Pn.setE(x, e, e === t1 ? [74, 88, 80] : [54, 66, 60]);
    }
    // wind turbines and lattice towers on the far ridge
    const TUR = [156, 164, 160], TOW = [34, 40, 40], RED = [232, 52, 44];
    for (let k = 0; k < 9; k++) {
      const x = Math.round(((k + R.r(0.2, 0.8)) / 9) * w), g = top1[((x % w) + w) % w], mh = R.i(14, 21);
      for (let e = g; e <= g + mh; e++) Pn.setE(x, e, TUR);
      const a0 = R.r(0, TAU), bl = R.i(8, 11), hy = h - 1 - (g + mh);
      for (let b = 0; b < 3; b++) {
        const a = a0 + (b * TAU) / 3;
        line(Pn, x, hy, x + Math.cos(a) * bl, hy + Math.sin(a) * bl, [184, 192, 188]);
      }
      Pn.setE(x, g + mh, [210, 216, 212]); Pn.setE(x + 1, g + mh, [130, 138, 134]);
      Pn.setE(x, g + mh + 1, RED);
    }
    for (let k = 0; k < 5; k++) {
      const x = Math.round(((k + R.r(0.1, 0.9)) / 5) * w), g = top1[((x % w) + w) % w], th = R.i(22, 32);
      for (let e = 0; e <= th; e++) {
        const half = Math.round((1 - e / th) * 3);
        Pn.setE(x - half, g + e, TOW); Pn.setE(x + half, g + e, TOW);
        if (e % 4 === 0) for (let i = -half; i <= half; i++) Pn.setE(x + i, g + e, TOW);
      }
      Pn.setE(x, g + th + 1, TOW); Pn.setE(x, g + th + 2, RED);
    }
    // near ridge
    for (let x = 0; x < w; x++) {
      const t2 = Math.round(3 + r2[x] * 9);
      for (let e = 0; e <= t2; e++) Pn.setE(x, e, e === t2 ? [56, 68, 62] : [38, 48, 44]);
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // -------------------------------------------------------------- FROST LINE
  function panoFrost(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0xf2050002);
    sky(Pn, [[92, 136, 208], [112, 154, 220], [134, 174, 230], [156, 192, 238], [178, 208, 244], [198, 222, 248], [214, 232, 250], [226, 238, 252]], 3, 1.1);
    // pale sun with halo ring
    const sx = Math.round(w * 0.82), sy = 16;
    for (let dy = -16; dy <= 16; dy++)
      for (let dx = -16; dx <= 16; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= 3.5) Pn.set(sx + dx, sy + dy, [255, 255, 250]);
        else if (d < 7 && bayer(sx + dx, sy + dy) < (7 - d) / 3.5 * 0.7) Pn.blend(sx + dx, sy + dy, [250, 252, 255], 0.6);
        else if (d > 12.5 && d < 13.6) Pn.blend(sx + dx, sy + dy, [236, 244, 255], 0.35);
      }
    // wispy clouds
    const CL = [[182, 204, 236], [218, 232, 248], [244, 248, 255]];
    // lens-shaped stratocumulus streaks: thick in the middle, tapering ends
    for (let g = 0; g < 7; g++) {
      const cx = ((g + R.r(0.1, 0.9)) / 7) * w, cy = R.i(12, 28), len = R.i(36, 84), list = [];
      for (let k = 0, n = Math.round(len / 3); k < n; k++) {
        const u = R.r(-1, 1), mid = 1 - Math.abs(u);
        list.push({ x: cx + (u * len) / 2, y: cy - mid * R.r(0.5, 3), r: (1.6 + 3.2 * mid) * R.r(0.75, 1.1) });
      }
      list.sort((a, b) => a.y - b.y);
      puffs(Pn, list, CL, -0.5, -0.7, cy + 2);
    }
    // mountain ranges
    const range = (peaks, jagAmp, jagSeed, col) => {
      const jag = fbm1(w, [[14, 0.6], [5, 0.4]], jagSeed);
      const streak = fbm1(w, [[5, 1]], jagSeed + 7);
      const rn = new Float32Array(h + 40);
      for (let i = 0; i < rn.length; i++) rn[i] = Math.sin(i * 0.7 + jagSeed) * 1.5 + Math.sin(i * 0.23) * 2;
      for (let x = 0; x < w; x++) {
        let best = -1e9, bp = null, bdx = 0;
        for (const p of peaks) {
          const dx = wrapD(x - p.x, w);
          const e = p.h * (1 - Math.abs(dx) / p.hw);
          if (e > best) { best = e; bp = p; bdx = dx; }
        }
        if (best < 0) continue;
        const top = Math.round(best + (jag[x] - 0.5) * jagAmp);
        for (let e = 0; e <= top; e++) {
          const ridge = (bp.h - e) * bp.skew + rn[Math.max(0, Math.round(bp.h - e))];
          const lit = bdx < ridge;
          const snowLine = bp.h * bp.snow + (jag[(x * 3) % w] - 0.5) * 6;
          const isSnow = e > snowLine || (e > bp.h * 0.3 && streak[x] > 0.72 && e > snowLine - (streak[x] - 0.72) * 40);
          let c = isSnow ? (lit ? col.snowLit : col.snowDark) : lit ? col.lit : col.dark;
          if (e === top && !isSnow) c = col.lit;
          Pn.setE(x, e, c);
        }
      }
    };
    const far = [], near = [];
    for (let k = 0; k < 11; k++) far.push({ x: ((k + R.r(0.2, 0.8)) / 11) * w, h: R.i(34, 50), hw: R.i(70, 120), skew: R.r(-0.25, 0.35), snow: R.r(0.62, 0.74) });
    for (let k = 0; k < 15; k++) near.push({ x: ((k + R.r(0.1, 0.9)) / 15) * w, h: R.i(20, 34), hw: R.i(44, 80), skew: R.r(-0.3, 0.4), snow: R.r(0.6, 0.74) });
    range(far, 3, 0xf2050003, { lit: [146, 164, 208], dark: [118, 136, 186], snowLit: [244, 248, 255], snowDark: [200, 214, 240] });
    range(near, 4, 0xf2050004, { lit: [96, 112, 156], dark: [68, 82, 126], snowLit: [255, 255, 255], snowDark: [186, 204, 234] });
    // pine tree line (height varies in forest bands)
    const forest = fbm1(w, [[90, 0.7], [30, 0.3]], 0xf2050005);
    for (let x = 0; x < w; ) {
      const th = Math.round(3 + forest[((x % w) + w) % w] * 6 + R.i(0, 3)), base = 4 + R.i(0, 1);
      for (let e = 0; e <= th; e++) {
        const half = Math.floor((th - e) * 0.45);
        for (let i = -half; i <= half; i++) Pn.setE(x + i, base + e, i < 0 ? [52, 86, 104] : [34, 62, 84]);
      }
      Pn.setE(x, base + th + 1, [34, 62, 84]);
      if (R.f() < 0.5) Pn.setE(x - 1, base + th - 2, [236, 244, 255]);
      for (let e = 0; e < base; e++) for (let i = -2; i <= 2; i++) Pn.setE(x + i, e, [210, 224, 244]);
      x += R.i(2, 5);
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // -------------------------------------------------------------- MAGMA FIELD
  function panoInferno(w, h, fog) {
    const Pn = makePano(w, h), R = makeRng(0x1f3e0002);
    sky(Pn, [[20, 4, 8], [36, 6, 12], [58, 10, 16], [86, 16, 18], [120, 26, 20], [156, 40, 22], [192, 62, 28], [220, 92, 36]], 3, 1.2);
    // dark ash haze bands
    const hz = noisePano(w, h, 60, 10, 0x1f3e0003);
    for (let y = 0; y < h * 0.6; y++)
      for (let x = 0; x < w; x++) {
        const v = hz[y * w + x];
        if (v > 0.6 && bayer(x, y) < (v - 0.6) * 3.5) Pn.blend(x, y, [16, 4, 6], 0.55);
      }
    // embers
    for (let s = 0; s < w / 10; s++) Pn.set(R.i(0, w - 1), R.i(4, h - 14), R.f() < 0.3 ? [255, 220, 120] : [255, 120, 40]);
    // far jagged ridge
    const jr = fbm1(w, [[80, 0.5], [20, 0.3], [6, 0.2]], 0x1f3e0004);
    for (let x = 0; x < w; x++) {
      const t = Math.round(4 + jr[x] * 12);
      for (let e = 0; e <= t; e++) Pn.setE(x, e, e === t ? [140, 40, 26] : [96, 24, 22]);
    }
    // volcanoes with smoke plumes and lava streams
    const vols = [
      { x: 0.14, h: 50, hw: 150, cw: 8 }, { x: 0.47, h: 36, hw: 104, cw: 6 },
      { x: 0.71, h: 58, hw: 170, cw: 9 }, { x: 0.93, h: 28, hw: 84, cw: 5 },
    ];
    const VP = 1.5;
    const smokeTex = noisePano(w, h, 9, 5, 0x1f3e0007);
    const vj = fbm1(w, [[10, 0.6], [4, 0.4]], 0x1f3e0005);
    for (const V of vols) {
      const cx = Math.round(V.x * w);
      // billowing smoke plume first (behind the cone), lit from below by the crater
      const list = [];
      let px = cx, py = h - 1 - V.h, r = 3;
      const drift = R.r(0.5, 1.1) * (R.f() < 0.5 ? -1 : 1);
      while (py > -20) {
        list.push({ x: px + R.r(-1, 1) * r * 0.2, y: py, r });
        if (r > 4) {
          for (const sg of [-1, 1]) list.push({ x: px + sg * r * R.r(0.5, 0.9), y: py + r * R.r(-0.4, 0.25), r: r * R.r(0.5, 0.75) });
        }
        py -= r * 0.5;
        px += drift * r * 0.3 * (1 + (h - py) / h);
        r = Math.min(r + 1.15, 21);
      }
      list.reverse();
      smoke(Pn, list, [[30, 12, 14], [54, 22, 24], [92, 36, 30], [150, 58, 34]], smokeTex);
      const body = [44, 12, 14], lit = [72, 20, 18];
      for (let dx = -V.hw; dx <= V.hw; dx++) {
        const a = Math.abs(dx);
        const u = Math.max(0, (a - V.cw) / (V.hw - V.cw));
        const eTop = Math.round(V.h * Math.pow(1 - u, VP) + (vj[((cx + dx) % w + w) % w] - 0.5) * 2);
        for (let e = 0; e <= eTop; e++) {
          let c = dx < -2 && e > eTop - 3 ? lit : body;
          if (a <= V.cw && e === eTop) c = [255, 176, 60];
          else if (a <= V.cw + 2 && e >= eTop - 1) c = [200, 70, 30];
          Pn.setE(cx + dx, e, c);
        }
      }
      // radial gullies converging on the crater
      for (let g = 0; g < 7; g++) {
        const s = g & 1 ? 1 : -1, f = R.r(0.2, 0.85);
        for (let e = V.h - 3; e >= 1; e--) {
          const a = V.cw + (1 - Math.pow(e / V.h, 1 / VP)) * (V.hw - V.cw);
          const x = Math.round(cx + s * f * a);
          Pn.setE(x, e, [30, 8, 10]);
          if (s < 0) Pn.setE(x - 1, e, [62, 18, 18]);
        }
      }
      // crater glow above rim
      for (let dx = -V.cw + 1; dx <= V.cw - 1; dx++) Pn.blendE(cx + dx, V.h + 1, [255, 140, 40], 0.6);
      // lava streams running radially down the flanks
      for (let k = 0; k < 4; k++) {
        const sgn = k & 1 ? 1 : -1, f0 = R.r(0.04, 0.55), stop = R.i(2, Math.round(V.h * 0.45)), wob = R.r(0, TAU);
        for (let e = V.h - 1; e >= stop; e--) {
          const a = V.cw * 0.7 + (1 - Math.pow(e / V.h, 1 / VP)) * (V.hw - V.cw);
          const f = f0 + 0.06 * Math.sin(e * 0.45 + wob);
          const x = Math.round(cx + sgn * f * a), t = (e - stop) / (V.h - stop);
          Pn.setE(x, e, t > 0.65 ? [255, 222, 110] : t > 0.3 ? [255, 146, 40] : [214, 66, 26]);
          if (t > 0.3) Pn.setE(x + sgn, e, [170, 40, 20]);
        }
      }
    }
    // near black rocks
    const nr = fbm1(w, [[50, 0.5], [12, 0.3], [4, 0.2]], 0x1f3e0006);
    for (let x = 0; x < w; x++) {
      const t = Math.round(1 + nr[x] * 7);
      for (let e = 0; e <= t; e++) Pn.setE(x, e, e === t ? [92, 30, 20] : [28, 10, 12]);
    }
    fogFade(Pn, fog, 6);
    return Pn.d;
  }

  // ==========================================================================
  // THEME DEFINITIONS
  // ==========================================================================
  const START_A = [242, 242, 246], START_B = [28, 28, 34];
  const DEFS = {
    neon: {
      name: 'NEON CITY',
      fog: [118, 40, 132],
      palette: {
        road: [70, 78, 106], roadAlt: [77, 85, 114], roadSeam: [46, 52, 76], roadLine: [222, 238, 255],
        railA: [255, 206, 40], railB: [64, 32, 22], railLight: [255, 144, 36], railDark: [22, 14, 20],
        shoulder: [18, 14, 34],
        startA: START_A, startB: START_B,
        pit: [228, 52, 168], pitStripe: [255, 152, 226],
        dash: [255, 132, 20], dashDark: [168, 52, 8],
        jump: [80, 220, 110], jumpDark: [24, 112, 64],
        rough: [140, 110, 72], roughDark: [84, 64, 42],
        ice: [176, 236, 255], iceLight: [248, 254, 255],
        minimapRoad: '#a8b4e8', minimapBg: 'rgba(14,8,36,0.72)', hudAccent: '#ff3cc8',
      },
      weather: null, weatherColor: '#e8d8ff',
      ground: groundNeon, pano: panoNeon,
    },
    coast: {
      name: 'BLUE COAST',
      fog: [196, 226, 250],
      palette: {
        road: [150, 156, 170], roadAlt: [158, 164, 178], roadSeam: [116, 122, 138], roadLine: [255, 255, 255],
        railA: [36, 92, 232], railB: [244, 248, 255], railLight: [255, 226, 80], railDark: [18, 32, 84],
        shoulder: [20, 40, 96],
        startA: START_A, startB: START_B,
        pit: [230, 54, 170], pitStripe: [255, 160, 226],
        dash: [255, 206, 30], dashDark: [220, 96, 0],
        jump: [60, 200, 90], jumpDark: [16, 110, 56],
        rough: [124, 96, 64], roughDark: [78, 58, 40],
        ice: [178, 238, 255], iceLight: [255, 255, 255],
        minimapRoad: '#e8eef8', minimapBg: 'rgba(10,40,110,0.65)', hudAccent: '#3ca0ff',
      },
      weather: 'sparkle', weatherColor: '#ffffff',
      ground: groundCoast, pano: panoCoast,
    },
    desert: {
      name: 'DUNE SEA',
      fog: [244, 166, 108],
      palette: {
        road: [158, 146, 130], roadAlt: [165, 153, 137], roadSeam: [120, 110, 98], roadLine: [255, 248, 230],
        railA: [222, 36, 30], railB: [250, 244, 236], railLight: [255, 230, 110], railDark: [80, 18, 16],
        shoulder: [96, 52, 34],
        startA: START_A, startB: START_B,
        pit: [226, 50, 170], pitStripe: [255, 150, 220],
        dash: [255, 214, 40], dashDark: [200, 90, 0],
        jump: [64, 196, 96], jumpDark: [20, 104, 60],
        rough: [104, 74, 52], roughDark: [64, 44, 30],
        ice: [170, 232, 250], iceLight: [250, 255, 255],
        minimapRoad: '#f4e6cc', minimapBg: 'rgba(90,36,20,0.65)', hudAccent: '#ff8a2a',
      },
      weather: 'sand', weatherColor: '#f2c890',
      ground: groundDesert, pano: panoDesert,
    },
    gale: {
      name: 'STORM VALLEY',
      fog: [104, 118, 110],
      palette: {
        road: [56, 58, 66], roadAlt: [62, 64, 72], roadSeam: [38, 40, 46], roadLine: [232, 240, 226],
        railA: [44, 196, 84], railB: [234, 242, 234], railLight: [255, 236, 120], railDark: [14, 44, 26],
        shoulder: [26, 30, 28],
        startA: START_A, startB: START_B,
        pit: [226, 52, 166], pitStripe: [255, 150, 220],
        dash: [255, 210, 40], dashDark: [206, 98, 4],
        jump: [96, 128, 255], jumpDark: [36, 48, 150],
        rough: [128, 108, 80], roughDark: [80, 66, 48],
        ice: [172, 232, 252], iceLight: [250, 255, 255],
        minimapRoad: '#d8e4d8', minimapBg: 'rgba(16,24,20,0.7)', hudAccent: '#4cd870',
      },
      weather: 'rain', weatherColor: 'rgba(170,196,210,0.75)',
      ground: groundGale, pano: panoGale,
    },
    frost: {
      name: 'FROST LINE',
      fog: [222, 234, 250],
      palette: {
        road: [128, 142, 168], roadAlt: [135, 149, 175], roadSeam: [98, 110, 138], roadLine: [255, 255, 255],
        railA: [40, 214, 240], railB: [24, 40, 112], railLight: [255, 240, 140], railDark: [10, 18, 52],
        shoulder: [58, 70, 100],
        startA: START_A, startB: START_B,
        pit: [226, 52, 170], pitStripe: [255, 156, 226],
        dash: [255, 206, 30], dashDark: [214, 96, 0],
        jump: [70, 206, 90], jumpDark: [20, 110, 56],
        rough: [118, 96, 80], roughDark: [74, 58, 48],
        ice: [188, 240, 255], iceLight: [255, 255, 255],
        minimapRoad: '#ffffff', minimapBg: 'rgba(20,40,90,0.6)', hudAccent: '#40d8f0',
      },
      weather: 'snow', weatherColor: '#ffffff',
      ground: groundFrost, pano: panoFrost,
    },
    inferno: {
      name: 'MAGMA FIELD',
      fog: [168, 54, 30],
      palette: {
        road: [94, 50, 42], roadAlt: [100, 55, 46], roadSeam: [64, 32, 28], roadLine: [255, 214, 120],
        railA: [255, 132, 24], railB: [34, 26, 26], railLight: [255, 242, 170], railDark: [18, 10, 10],
        shoulder: [26, 14, 14],
        startA: START_A, startB: START_B,
        pit: [236, 60, 180], pitStripe: [255, 160, 230],
        dash: [255, 226, 60], dashDark: [214, 120, 0],
        jump: [80, 214, 110], jumpDark: [24, 110, 60],
        rough: [126, 120, 116], roughDark: [76, 72, 70],
        ice: [176, 236, 255], iceLight: [250, 255, 255],
        minimapRoad: '#ffc890', minimapBg: 'rgba(40,6,6,0.7)', hudAccent: '#ff7a1a',
      },
      weather: 'embers', weatherColor: '#ffa040',
      ground: groundInferno, pano: panoInferno,
    },
  };

  const ids = ['neon', 'coast', 'desert', 'gale', 'frost', 'inferno'];
  const cache = Object.create(null);

  function build(id) {
    const d = DEFS[id];
    return {
      id,
      name: d.name,
      fog: d.fog.slice(),
      palette: d.palette,
      weather: d.weather,
      weatherColor: d.weatherColor,
      buildGroundTile(size) {
        const S = size === undefined ? 512 : size | 0;
        if (S < 16 || (S & (S - 1)) !== 0) throw new RangeError('THEMES: ground tile size must be a power of two ≥ 16');
        return d.ground(S);
      },
      buildPanorama(w, h) {
        const W = w === undefined ? 1536 : w | 0, H = h === undefined ? 72 : h | 0;
        if (W < 1 || H < 1) throw new RangeError('THEMES: panorama size must be ≥ 1×1');
        // The art is authored for a 72-row strip (silhouette heights in px);
        // widths ≥ 256 are composed natively. Any other size is nearest-
        // resampled from a native strip so the result is always exactly
        // W×H, wraps seamlessly and keeps its bottom row == fog.
        const BW = W >= 256 ? W : 1536, BH = 72;
        const base = d.pano(BW, BH, d.fog);
        if (BW === W && BH === H) return base;
        return resamplePano(base, BW, BH, W, H);
      },
    };
  }

  function get(id) {
    if (!DEFS[id]) id = ids[0];
    return cache[id] || (cache[id] = build(id));
  }

  return { ids, get };
})();
