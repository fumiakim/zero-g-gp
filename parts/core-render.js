// =====================================================================
// RENDER — Mode-7 world, software sprites/particles into one pixel buffer,
// plus the canvas HUD.  World rendering is DOM-free (headless testable).
// =====================================================================
const RENDER = (() => {
  'use strict';
  const { clamp, lerp, wrapA, TAU } = SIM;

  const W = 384, H = 216, HZ = 72, F = 192;
  const CAM_H = 26, CAM_D = 48;
  const ZFAR = 2300, FOG0 = 650;
  const MIPS = 6;

  const pack = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const packA = (c) => pack(c[0], c[1], c[2]);
  const R_ = (c) => c & 255, G_ = (c) => (c >>> 8) & 255, B_ = (c) => (c >>> 16) & 255;
  const mix = (a, b, t) => pack(
    (R_(a) + (R_(b) - R_(a)) * t) | 0,
    (G_(a) + (G_(b) - G_(a)) * t) | 0,
    (B_(a) + (B_(b) - B_(a)) * t) | 0,
  );
  const scale3 = (c, k) => pack(Math.min(255, R_(c) * k) | 0, Math.min(255, G_(c) * k) | 0, Math.min(255, B_(c) * k) | 0);
  const hash2 = (x, y) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // ------------------------------------------------------------------
  // World texture (track painted onto the theme ground) + mip chain
  // ------------------------------------------------------------------
  function mipDown(src, size) {
    const h = size >> 1, out = new Uint32Array(h * h);
    for (let y = 0; y < h; y++) {
      const r0 = 2 * y * size, r1 = r0 + size;
      for (let x = 0; x < h; x++) {
        const a = src[r0 + 2 * x], b = src[r0 + 2 * x + 1], c = src[r1 + 2 * x], d = src[r1 + 2 * x + 1];
        out[y * h + x] = pack(
          ((a & 255) + (b & 255) + (c & 255) + (d & 255)) >> 2,
          (((a >>> 8) & 255) + ((b >>> 8) & 255) + ((c >>> 8) & 255) + ((d >>> 8) & 255)) >> 2,
          (((a >>> 16) & 255) + ((b >>> 16) & 255) + ((c >>> 16) & 255) + ((d >>> 16) & 255)) >> 2,
        );
      }
    }
    return out;
  }

  function buildWorld(T, theme) {
    const N = SIM.MAP, n = T.n, step = T.step, L = T.L;
    const RAIL = SIM.RAIL_W;
    const pal = theme.palette;
    const C = {};
    for (const k in pal) if (Array.isArray(pal[k])) C[k] = packA(pal[k]);
    const TS = 512;
    const tile = theme.buildGroundTile(TS);
    const tex = new Uint32Array(N * N);
    for (let y = 0; y < N; y++) {
      const row = (y & (TS - 1)) * TS, o = y * N;
      for (let x = 0; x < N; x++) tex[o + x] = tile[row + (x & (TS - 1))];
    }
    // nearest centre-line segment for every texel near the track
    const EXT = RAIL + 18;
    const best = new Float32Array(N * N).fill(1e12);
    const sA = new Float32Array(N * N), dA = new Float32Array(N * N);
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const x0 = T.px[i], y0 = T.py[i], ex = T.px[i1] - x0, ey = T.py[i1] - y0;
      const l2 = ex * ex + ey * ey, len = Math.sqrt(l2), nx = -ey / len, ny = ex / len;
      const R = Math.max(T.hw[i], T.hw[i1]) + EXT, R2 = R * R;
      const xa = Math.max(0, Math.floor(Math.min(x0, x0 + ex) - R)), xb = Math.min(N - 1, Math.ceil(Math.max(x0, x0 + ex) + R));
      const ya = Math.max(0, Math.floor(Math.min(y0, y0 + ey) - R)), yb = Math.min(N - 1, Math.ceil(Math.max(y0, y0 + ey) + R));
      for (let y = ya; y <= yb; y++) {
        const wy = y + 0.5 - y0;
        let o = y * N + xa;
        for (let x = xa; x <= xb; x++, o++) {
          const wx = x + 0.5 - x0;
          let t = (wx * ex + wy * ey) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = wx - ex * t, qy = wy - ey * t;
          const d2 = qx * qx + qy * qy;
          if (d2 < R2 && d2 < best[o]) {
            best[o] = d2;
            sA[o] = (i + t) * step;
            const dist = Math.sqrt(d2);
            dA[o] = qx * nx + qy * ny >= 0 ? dist : -dist;
          }
        }
      }
    }
    const zones = T.zones, dash = T.dash, jump = T.jump, grid = T.grid;
    const lane = (hw) => (2 * hw) / 3;
    // stronger panel contrast than the theme's subtle roadAlt, and dashed lane marks
    const ext = (a, b, k) => pack(...[0, 8, 16].map((sh) => clamp(((a >>> sh) & 255) + ((((b >>> sh) & 255) - ((a >>> sh) & 255)) * k), 0, 255) | 0));
    const roadAlt2 = ext(C.road, C.roadAlt, 1.8);
    const laneDash = mix(C.road, C.roadLine, 0.55);
    for (let o = 0; o < N * N; o++) {
      if (best[o] > 1e11) continue;
      const s = sA[o], d = dA[o];
      const i0 = Math.floor(s / step) % n;
      const hw = T.hw[i0];
      const ad = d < 0 ? -d : d;
      const x = o % N, y = (o / N) | 0;
      if (ad < hw) {
        const u = d + hw;
        const lw = lane(hw);
        const ps = Math.floor(s / 32), pu = Math.floor(u / lw);
        let col = (ps + pu) & 1 ? roadAlt2 : C.road;
        // seams every 16 units and dashed lane dividers: strong cues for the sense of speed
        if (s % 16 < 1.4 || u % lw < 0.9) col = C.roadSeam;
        const lu = u % lw;
        if (u > lw * 0.5 && u < 2 * hw - lw * 0.5 && (lu < 1.8 || lu > lw - 0.2) && s % 24 < 12) col = laneDash;
        if (ad > hw - 6 && ad < hw - 3) col = C.roadLine;
        // start / finish
        if (s < 12) col = (Math.floor(s / 4) + Math.floor(u / 4)) & 1 ? C.startA : C.startB;
        // grid boxes
        if (s > L - 340) {
          for (let g = 0; g < grid.length; g++) {
            const G = grid[g];
            let ds = s - G.s;
            if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
            const dd = d - G.d;
            if (ds > -11 && ds < 11 && dd > -9.5 && dd < 9.5) {
              if (ds > 9 || dd < -8 || dd > 8) col = C.roadLine;
            }
          }
        }
        // zones
        const df = d / hw;
        for (let z = 0; z < zones.length; z++) {
          const Z = zones[z];
          if (!(Z.s0 <= Z.s1 ? s >= Z.s0 && s <= Z.s1 : s >= Z.s0 || s <= Z.s1)) continue;
          if (Z.type === 'wind') {
            const sg = Z.force > 0 ? 1 : -1;
            let a = (s % 150) - 75;
            const b = d * sg;
            const cc = b + Math.abs(a) * 0.8;
            if (Math.abs(a) < 16 && ((cc > 8 && cc < 14) || (cc > 22 && cc < 28))) col = mix(col, C.roadLine, 0.45);
            continue;
          }
          if (df < Z.d0 || df > Z.d1) continue;
          const edge = Math.min(Math.abs(df - Z.d0), Math.abs(df - Z.d1)) * hw < 1.6;
          if (Z.type === 'pit') {
            col = Math.floor((s + d) / 7) & 1 ? C.pit : C.pitStripe;
            if (edge) col = C.roadLine;
          } else if (Z.type === 'rough') {
            const h = hash2(x >> 2, y >> 2), h2 = hash2((x + 1) >> 1, (y + 7) >> 1);
            col = h < 0.42 ? C.roughDark : h2 < 0.2 ? mix(C.rough, C.roughDark, 0.5) : C.rough;
          } else if (Z.type === 'ice') {
            const st = (Math.floor(u / 3) * 7 + Math.floor(s / 22)) % 6 === 0;
            col = st ? C.iceLight : hash2(x >> 3, y >> 3) < 0.15 ? mix(C.ice, C.iceLight, 0.5) : C.ice;
          }
        }
        // plates
        for (let q = 0; q < dash.length; q++) {
          const P = dash[q];
          let a = s - P.s;
          if (a > L / 2) a -= L; else if (a < -L / 2) a += L;
          if (a < -P.len / 2 || a > P.len / 2) continue;
          const v = d - P.d;
          if (v < -P.wid / 2 || v > P.wid / 2) continue;
          const u2 = a + P.len / 2;
          col = C.dashDark;
          const cc = u2 + Math.abs(v) * 0.75;
          if ((cc > 9 && cc < 14) || (cc > 19 && cc < 24)) col = C.dash;
          if (Math.abs(v) > P.wid / 2 - 1.5 || u2 < 1.5 || u2 > P.len - 1.5) col = C.dash;
        }
        for (let q = 0; q < jump.length; q++) {
          const P = jump[q];
          let a = s - P.s;
          if (a > L / 2) a -= L; else if (a < -L / 2) a += L;
          if (a < -P.len / 2 || a > P.len / 2) continue;
          const v = d - P.d;
          if (v < -P.wid / 2 || v > P.wid / 2) continue;
          const u2 = a + P.len / 2;
          col = Math.floor(u2 / 4) & 1 ? C.jump : C.jumpDark;
          if (Math.abs(v) > P.wid / 2 - 2 || u2 < 2 || u2 > P.len - 2) col = C.jump;
        }
        tex[o] = col;
      } else if (ad < hw + RAIL) {
        const r = ad - hw;
        let col;
        if (r < 2 || r > RAIL - 2) col = C.railDark;
        else {
          const bs = s % 16;
          col = Math.floor(s / 16) & 1 ? C.railA : C.railB;
          if (bs > 6 && bs < 10 && r > 4 && r < RAIL - 4) col = C.railLight;
          if (bs < 1) col = C.railDark;
        }
        tex[o] = col;
      } else {
        const k = 0.3 + 0.7 * clamp((ad - hw - RAIL) / 18, 0, 1);
        tex[o] = k < 1 ? mix(C.shoulder, tex[o], k) : tex[o];
      }
    }
    const lv = [tex];
    for (let i = 1; i < MIPS; i++) lv.push(mipDown(lv[i - 1], N >> (i - 1)));
    const tl = [tile];
    for (let i = 1; i < MIPS; i++) tl.push(mipDown(tl[i - 1], TS >> (i - 1)));
    const pano = theme.buildPanorama(1536, HZ);
    const pano32 = new Uint32Array(pano.buffer.slice(pano.byteOffset, pano.byteOffset + 1536 * HZ * 4));
    return {
      T, theme, N, lv, TS, tl, pano32, panoW: 1536,
      fog: packA(theme.fog), fogRGB: theme.fog,
      C,
    };
  }

  // ------------------------------------------------------------------
  // View & camera
  // ------------------------------------------------------------------
  function createView() {
    return { W, H, buf: new Uint32Array(W * H), zbuf: null };
  }
  function createCamera() {
    return { x: 0, y: 0, th: 0, h: CAM_H, shake: 0, sx: 0, sy: 0, t: 0 };
  }
  function followCamera(cam, car, dt, snap) {
    let target = car.th;
    if (car.speed > 40 && !car.retired) {
      const va = Math.atan2(car.vy, car.vx);
      target = car.th + clamp(wrapA(va - car.th), -0.6, 0.6) * 0.35;
    }
    if (snap) cam.th = target;
    else cam.th = wrapA(cam.th + wrapA(target - cam.th) * Math.min(1, dt * 7 * SIM.PACE));
    cam.x = car.x - Math.cos(cam.th) * CAM_D;
    cam.y = car.y - Math.sin(cam.th) * CAM_D;
    cam.h = CAM_H + Math.max(0, car.z) * 0.55;
    cam.t += dt;
    if (cam.shake > 0) {
      cam.shake = Math.max(0, cam.shake - dt * 6);
      const a = cam.shake * 2.2;
      cam.x += (Math.random() - 0.5) * a; cam.y += (Math.random() - 0.5) * a;
    }
  }

  // ------------------------------------------------------------------
  // Sky + floor
  // ------------------------------------------------------------------
  function drawSky(view, world, cam) {
    const buf = view.buf, P = world.pano32, PW = world.panoW;
    let base = Math.round((wrapA(cam.th) / TAU) * PW - W / 2);
    base = ((base % PW) + PW) % PW;
    for (let y = 0; y < HZ; y++) {
      const ro = y * PW, wo = y * W;
      let c = base;
      for (let x = 0; x < W; x++) {
        buf[wo + x] = P[ro + c];
        if (++c === PW) c = 0;
      }
    }
  }

  const TAPU = new Float64Array(4), TAPV = new Float64Array(4);
  function drawFloor(view, world, cam) {
    const buf = view.buf;
    const ch = Math.cos(cam.th), sh = Math.sin(cam.th);
    const rx = -sh, ry = ch;
    const camH = cam.h;
    const fog = world.fog, fr = world.fogRGB[0], fg = world.fogRGB[1], fb = world.fogRGB[2];
    const N = world.N, TS = world.TS;
    for (let y = HZ; y < H; y++) {
      const dy = y - HZ + 0.5;
      const z = (camH * F) / dy;
      const wo = y * W;
      if (z > ZFAR) {
        for (let x = 0; x < W; x++) buf[wo + x] = fog;
        continue;
      }
      const k = z / F;
      const vstep = (z * z) / (camH * F);
      const foot = Math.max(k * 1.15, vstep * 0.3);
      let lod = foot <= 1 ? 0 : Math.floor(Math.log2(foot));
      if (lod > MIPS - 1) lod = MIPS - 1;
      const inv = 1 / (1 << lod);
      const tex = world.lv[lod], size = N >> lod, mask = ~(size - 1);
      const til = world.tl[lod], ts = TS >> lod, tm = ts - 1;
      let u = (cam.x + ch * z - rx * k * (W / 2 - 0.5)) * inv;
      let v = (cam.y + sh * z - ry * k * (W / 2 - 0.5)) * inv;
      const du = rx * k * inv, dv = ry * k * inv;
      const fa = z > FOG0 ? Math.min(1, (z - FOG0) / (ZFAR - FOG0)) : 0;
      const vTex = vstep * inv;
      const taps = vTex > 1.8 ? Math.min(4, Math.ceil(vTex / 1.5)) : 1;
      if (taps > 1) {
        // supersample along depth so seams and rail blocks do not crawl
        for (let j = 0; j < taps; j++) {
          const o = ((j + 0.5) / taps - 0.5) * vTex;
          TAPU[j] = ch * o; TAPV[j] = sh * o;
        }
        const a = fa * fa * (3 - 2 * fa), it = 1 / taps;
        for (let x = 0; x < W; x++) {
          let r = 0, g = 0, b = 0;
          for (let j = 0; j < taps; j++) {
            const iu = Math.floor(u + TAPU[j]), iv = Math.floor(v + TAPV[j]);
            const c = ((iu | iv) & mask) === 0 ? tex[iv * size + iu] : til[(iv & tm) * ts + (iu & tm)];
            r += c & 255; g += (c >>> 8) & 255; b += (c >>> 16) & 255;
          }
          r *= it; g *= it; b *= it;
          buf[wo + x] = pack((r + (fr - r) * a) | 0, (g + (fg - g) * a) | 0, (b + (fb - b) * a) | 0);
          u += du; v += dv;
        }
      } else if (fa === 0) {
        for (let x = 0; x < W; x++) {
          const iu = Math.floor(u), iv = Math.floor(v);
          buf[wo + x] = ((iu | iv) & mask) === 0 ? tex[iv * size + iu] : til[(iv & tm) * ts + (iu & tm)];
          u += du; v += dv;
        }
      } else {
        const a = fa * fa * (3 - 2 * fa);
        for (let x = 0; x < W; x++) {
          const iu = Math.floor(u), iv = Math.floor(v);
          const c = ((iu | iv) & mask) === 0 ? tex[iv * size + iu] : til[(iv & tm) * ts + (iu & tm)];
          const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
          buf[wo + x] = pack((r + (fr - r) * a) | 0, (g + (fg - g) * a) | 0, (b + (fb - b) * a) | 0);
          u += du; v += dv;
        }
      }
    }
  }

  // camera-space projection (writes into out)
  function project(cam, x, y, z, out) {
    const ch = Math.cos(cam.th), sh = Math.sin(cam.th);
    const dx = x - cam.x, dy = y - cam.y;
    const zc = dx * ch + dy * sh;
    const xc = -dx * sh + dy * ch;
    out.zc = zc;
    if (zc < 4) return false;
    const sc = F / zc;
    out.sc = sc;
    out.sx = W / 2 + xc * sc;
    out.sg = HZ + cam.h * sc;
    out.sy = HZ + (cam.h - z) * sc;
    return true;
  }

  // ------------------------------------------------------------------
  // Pixel helpers
  // ------------------------------------------------------------------
  function blend(buf, i, c, a) {
    const d = buf[i];
    buf[i] = pack(
      ((d & 255) + ((c & 255) - (d & 255)) * a) | 0,
      (((d >>> 8) & 255) + (((c >>> 8) & 255) - ((d >>> 8) & 255)) * a) | 0,
      (((d >>> 16) & 255) + (((c >>> 16) & 255) - ((d >>> 16) & 255)) * a) | 0,
    );
  }
  function addPix(buf, i, r, g, b) {
    const d = buf[i];
    buf[i] = pack(Math.min(255, (d & 255) + r), Math.min(255, ((d >>> 8) & 255) + g), Math.min(255, ((d >>> 16) & 255) + b));
  }
  function fillRect(view, x, y, w, h, c, a) {
    const buf = view.buf;
    let x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      const o = yy * W;
      for (let xx = x0; xx < x1; xx++) {
        if (a >= 1) buf[o + xx] = c;
        else blend(buf, o + xx, c, a);
      }
    }
  }
  function disc(view, cx, cy, r, c, a, yScale) {
    const buf = view.buf, ys = yScale || 1;
    const ry = r * ys;
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ys;
      const span = r * r - dy * dy;
      if (span < 0) continue;
      const hw = Math.sqrt(span);
      const x0 = Math.max(0, Math.round(cx - hw)), x1 = Math.min(W - 1, Math.round(cx + hw) - 1);
      const o = y * W;
      for (let x = x0; x <= x1; x++) {
        if (a >= 1) buf[o + x] = c;
        else blend(buf, o + x, c, a);
      }
    }
  }
  function glow(view, cx, cy, r, cr, cg, cb, inten) {
    const buf = view.buf;
    const R = r * 1.6;
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / R, dy = (y + 0.5 - cy) / R;
        const q = 1 - (dx * dx + dy * dy);
        if (q <= 0) continue;
        const k = q * q * inten;
        addPix(buf, y * W + x, (cr * k) | 0, (cg * k) | 0, (cb * k) | 0);
      }
    }
  }
  function line(view, x0, y0, x1, y1, c, a) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      blend(view.buf, y * W + x, c, a);
    }
  }

  // ------------------------------------------------------------------
  // Sprites
  // ------------------------------------------------------------------
  // sheets[design] = { near: {sheet, px:Uint32Array}, far: {...} }
  function prepSheets(cars, designs) {
    const out = {};
    for (const key of designs) {
      const mk = (ppu, pitch) => {
        const sh = cars.buildSheet(key, { pxPerUnit: ppu, pitchDeg: pitch, yawSteps: 32, bankDeg: [-18, 0, 18] });
        return { sheet: sh, px: new Uint32Array(sh.pixels.buffer, sh.pixels.byteOffset, sh.width * sh.height) };
      };
      // drawn from a lower angle than the camera geometry (like the SNES classic) so the
      // machines read as flat and hugging the road instead of pointing nose-up
      const near = mk(4, 16), mid = mk(3, 11), far = mk(2, 6), farHi = mk(2, 15);
      out[key] = { near, mid, far, farHi, list: [near, mid, far, farHi] };
    }
    return out;
  }

  // nearest-neighbour scaled blit; mode 0 normal, 1 white flash, 2 translucent
  function blit(view, S, yaw, bank, dx, dy, k, mode, alpha) {
    const sh = S.sheet, px = S.px, SW = sh.width;
    const f = sh.frame(yaw, bank);
    const fw = sh.frameW, fh = sh.frameH;
    const dw = fw * k, dh = fh * k;
    const x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(W, Math.ceil(dx + dw));
    const y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(H, Math.ceil(dy + dh));
    if (x0 >= x1 || y0 >= y1) return;
    const inv = 1 / k;
    const buf = view.buf;
    for (let y = y0; y < y1; y++) {
      const sy = Math.floor((y + 0.5 - dy) * inv);
      if (sy < 0 || sy >= fh) continue;
      const so = (f.sy + sy) * SW + f.sx;
      const o = y * W;
      for (let x = x0; x < x1; x++) {
        const sx = Math.floor((x + 0.5 - dx) * inv);
        if (sx < 0 || sx >= fw) continue;
        const c = px[so + sx];
        if (c >>> 24 === 0) continue;
        if (mode === 0) buf[o + x] = c;
        else if (mode === 1) buf[o + x] = mix(c, 0xffffffff, 0.75);
        else blend(buf, o + x, c, alpha);
      }
    }
  }

  // ------------------------------------------------------------------
  // Particles / effects (visual only)
  // ------------------------------------------------------------------
  function createFx() {
    return { parts: [], weather: [], streaks: [], flash: 0, flashCol: 0xffffffff, lastTh: null };
  }
  const PCOL = {
    spark: [pack(255, 250, 200), pack(255, 210, 80)],
    fire: [pack(255, 240, 160), pack(255, 150, 40), pack(200, 60, 20)],
    smoke: [pack(90, 90, 96), pack(60, 60, 66)],
    pit: [pack(140, 255, 220), pack(255, 140, 240)],
    dust: [pack(180, 150, 110), pack(140, 110, 80)],
    trail: [pack(170, 220, 255), pack(90, 140, 255)],
    debris: [pack(60, 60, 70), pack(120, 120, 130)],
    ice: [pack(230, 250, 255), pack(170, 220, 255)],
  };
  function spawn(fx, type, x, y, z, opts) {
    if (fx.parts.length > 600) return;
    const o = opts || {};
    const a = Math.random() * TAU, sp = (o.speed || 40) * (0.4 + Math.random() * 0.8);
    fx.parts.push({
      type, x, y, z,
      vx: (o.vx || 0) + Math.cos(a) * sp, vy: (o.vy || 0) + Math.sin(a) * sp,
      vz: (o.vz !== undefined ? o.vz : 20) * (0.5 + Math.random()),
      life: 0, max: (o.life || 0.5) * (0.7 + Math.random() * 0.6),
      size: o.size || 1, grow: o.grow || 0, g: o.g !== undefined ? o.g : 150,
      col: PCOL[type][(Math.random() * PCOL[type].length) | 0],
    });
  }
  function burst(fx, type, x, y, z, count, opts) {
    for (let i = 0; i < count; i++) spawn(fx, type, x, y, z, opts);
  }
  function updateFx(fx, dt) {
    const P = fx.parts;
    let w = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vz -= p.g * dt;
      if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.7; p.vy *= 0.7; }
      const drag = Math.exp(-dt * 1.5);
      p.vx *= drag; p.vy *= drag;
      p.size += p.grow * dt;
      P[w++] = p;
    }
    P.length = w;
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - dt * 3);
  }

  // weather & speed streaks, screen space
  function updateWeather(fx, kind, cam, dt, speed) {
    const Wt = fx.weather;
    const want = kind === 'snow' ? 90 : kind === 'rain' ? 70 : kind === 'sand' ? 60 : kind === 'embers' ? 45 : kind === 'sparkle' ? 30 : 0;
    while (Wt.length < want) Wt.push({ x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 0.6, t: Math.random() * 10 });
    if (Wt.length > want) Wt.length = want;
    let dth = 0;
    if (fx.lastTh !== null) dth = wrapA(cam.th - fx.lastTh);
    fx.lastTh = cam.th;
    const sp = speed / 300;
    for (const p of Wt) {
      p.t += dt;
      p.x -= dth * F * p.z;
      if (kind === 'snow') { p.y += (18 + 40 * p.z + sp * 60 * p.z) * dt; p.x += Math.sin(p.t * 1.7) * 10 * dt; p.y += sp * (p.y - HZ) * 0.5 * dt; }
      else if (kind === 'rain') { p.y += (220 + 120 * p.z) * dt; p.x -= 40 * dt; }
      else if (kind === 'sand') { p.x -= (90 + 120 * p.z) * dt; p.y += Math.sin(p.t * 3) * 6 * dt; }
      else if (kind === 'embers') { p.y -= (14 + 30 * p.z) * dt; p.x += Math.sin(p.t * 2.3) * 14 * dt; }
      if (p.x < -4) p.x += W + 8; if (p.x > W + 4) p.x -= W + 8;
      if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
      if (p.y < -6) { p.y = H + 4; p.x = Math.random() * W; }
    }
  }
  function cssToPacked(css) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(css || '').trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return pack((v >> 16) & 255, (v >> 8) & 255, v & 255);
  }
  function drawWeather(view, fx, kind, colorCss) {
    if (!kind) return;
    const col = cssToPacked(colorCss) || (kind === 'snow' ? pack(240, 248, 255) : kind === 'rain' ? pack(170, 190, 220) : kind === 'sand' ? pack(230, 190, 130) : kind === 'embers' ? pack(255, 150, 60) : pack(255, 255, 220));
    for (const p of fx.weather) {
      const x = p.x | 0, y = p.y | 0;
      if (kind === 'rain') line(view, x, y, x - 2, y + 6, col, 0.45 * p.z);
      else if (kind === 'sand') line(view, x, y, x + 5, y, col, 0.35 * p.z);
      else if (kind === 'snow') fillRect(view, x, y, p.z > 0.75 ? 2 : 1, p.z > 0.75 ? 2 : 1, col, 0.85);
      else if (kind === 'embers') { if (((p.t * 6) | 0) % 3) fillRect(view, x, y, 1, 1, col, 0.9); }
      else if (((p.t * 4) | 0) % 4 === 0) fillRect(view, x, y, 1, 1, col, 0.8);
    }
  }
  function drawSpeedStreaks(view, fx, amount, dt) {
    const S = fx.streaks;
    if (amount > 0.05 && S.length < 24 && dt > 0 && Math.random() < 1 - Math.pow(1 - Math.min(0.95, amount), dt * 60)) {
      const a = Math.random() * TAU;
      S.push({ a, r: 40 + Math.random() * 60, v: 500 + Math.random() * 300, life: 0 });
    }
    let w = 0;
    for (const s of S) {
      s.life += dt; s.r += s.v * dt;
      if (s.r > 260) continue;
      const cx = W / 2, cy = HZ + 50;
      const c = Math.cos(s.a), sn = Math.sin(s.a) * 0.6;
      line(view, cx + c * s.r, cy + sn * s.r, cx + c * (s.r + 26), cy + sn * (s.r + 26), 0xffffffff, 0.35 * Math.max(0, amount));
      S[w++] = s;
    }
    S.length = w;
  }

  // ------------------------------------------------------------------
  // Full world frame
  // ------------------------------------------------------------------
  const PRJ = {};
  const drawList = [];
  function renderWorld(view, world, cam, race, sheets, fx, opts) {
    opts = opts || {};
    drawSky(view, world, cam);
    drawFloor(view, world, cam);
    const T = world.T;
    drawList.length = 0;
    // cars
    for (const c of race.cars) {
      if (c.retired && c.boomT > 0.15 && c.retired !== 'courseout' && c.retired !== 'rankout') continue;
      if (c.retired === 'courseout' && c.z < -40) continue;
      if (!project(cam, c.x, c.y, c.z, PRJ)) continue;
      if (PRJ.sx < -80 || PRJ.sx > W + 80 || PRJ.zc > 1500) continue;
      drawList.push({ kind: 0, zc: PRJ.zc, sx: PRJ.sx, sy: PRJ.sy, sg: PRJ.sg, sc: PRJ.sc, c });
    }
    if (opts.ghost && project(cam, opts.ghost.x, opts.ghost.y, opts.ghost.z, PRJ)) {
      drawList.push({ kind: 3, zc: PRJ.zc, sx: PRJ.sx, sy: PRJ.sy, sg: PRJ.sg, sc: PRJ.sc, g: opts.ghost });
    }
    // mines
    for (const m of race.mines) {
      if (!m.active) continue;
      if (!project(cam, m.x, m.y, 2.5, PRJ) || PRJ.zc > 900 || PRJ.sx < -20 || PRJ.sx > W + 20) continue;
      drawList.push({ kind: 1, zc: PRJ.zc, sx: PRJ.sx, sy: PRJ.sy, sg: PRJ.sg, sc: PRJ.sc, m });
    }
    // particles
    for (const p of fx.parts) {
      if (!project(cam, p.x, p.y, p.z, PRJ) || PRJ.zc > 1200) continue;
      drawList.push({ kind: 2, zc: PRJ.zc, sx: PRJ.sx, sy: PRJ.sy, sg: PRJ.sg, sc: PRJ.sc, p });
    }
    drawList.sort((a, b) => b.zc - a.zc);
    // shadows first (they lie on the floor)
    for (const it of drawList) {
      if (it.kind !== 0 && it.kind !== 3) continue;
      const z = it.kind === 0 ? it.c.z : it.g.z;
      if (z < -1) continue;
      const r = 7.5 * it.sc * (1 - Math.min(0.5, z / 80));
      disc(view, it.sx, it.sg, r, 0xff000000, 0.38, Math.min(0.75, cam.h / Math.max(8, it.zc)));
    }
    const t = cam.t;
    for (const it of drawList) {
      if (it.kind === 0) drawCar(view, it, sheets, cam, t, opts);
      else if (it.kind === 3) drawGhost(view, it, sheets, cam, opts);
      else if (it.kind === 1) {
        const r = Math.max(1, 3.2 * it.sc);
        disc(view, it.sx, it.sy, r, pack(40, 40, 48), 1);
        disc(view, it.sx - r * 0.3, it.sy - r * 0.35, r * 0.35, pack(150, 150, 165), 1);
        if (((t * 4) | 0) & 1) glow(view, it.sx, it.sy - r * 0.9, Math.max(1, r * 0.5), 255, 40, 30, 1.6);
      } else {
        const p = it.p;
        const a = 1 - p.life / p.max;
        const sz = Math.max(1, p.size * it.sc);
        if (p.type === 'fire') glow(view, it.sx, it.sy, sz, (p.col & 255), (p.col >>> 8) & 255, (p.col >>> 16) & 255, 1.4 * a);
        else if (p.type === 'smoke') disc(view, it.sx, it.sy, sz, p.col, 0.5 * a);
        else if (p.type === 'pit' || p.type === 'trail' || p.type === 'spark' || p.type === 'ice') {
          const s2 = Math.min(sz, p.type === 'trail' ? 2.6 : 3.2);
          if (s2 <= 1.5) fillRect(view, it.sx, it.sy, s2 < 1.2 ? 1 : 2, s2 < 1.2 ? 1 : 2, p.col, Math.min(1, a * 1.5));
          else glow(view, it.sx, it.sy, s2, p.col & 255, (p.col >>> 8) & 255, (p.col >>> 16) & 255, a * (p.type === 'trail' ? 0.7 : 1.3));
        } else fillRect(view, it.sx - sz / 2, it.sy - sz / 2, sz, sz, p.col, Math.min(1, a * 1.3));
      }
    }
    if (world.theme.weather) drawWeather(view, fx, world.theme.weather, world.theme.weatherColor);
    if (opts.streaks) drawSpeedStreaks(view, fx, opts.streaks, opts.dt !== undefined ? opts.dt : 0.016);
    if (fx.flash > 0) {
      const buf = view.buf, a = Math.min(0.8, fx.flash);
      for (let i = 0; i < buf.length; i++) blend(buf, i, fx.flashCol, a);
    }
  }

  // pick the pre-rendered view whose camera pitch best matches the real one,
  // avoiding heavy down-scaling of big sheets and blocky up-scaling of small ones
  const ART_PITCH = 0.56; // sprite view pitch = camera pitch to the car x this
  function pickSheet(S2, sc, geomPitchDeg) {
    const pitchDeg = geomPitchDeg * ART_PITCH;
    let best = S2.far, bd = 1e9;
    for (const S of S2.list) {
      const ppu = S.sheet.pxPerUnit, k = sc / ppu;
      if (k < 0.5 && ppu > 2) continue;
      const d = Math.abs(S.sheet.pitchDeg - pitchDeg) + (k > 1.1 ? (k - 1.1) * 40 : 0) + (k < 0.5 ? (0.5 - k) * 8 : 0);
      if (d < bd) { bd = d; best = S; }
    }
    return best;
  }

  function yawIndex(c, cam, th) {
    const bearing = Math.atan2(c.y - cam.y, c.x - cam.x);
    const rel = wrapA(th - bearing);
    return ((Math.round(rel / (TAU / 32)) % 32) + 32) % 32;
  }

  function drawCar(view, it, sheets, cam, t, opts) {
    const c = it.c;
    const S2 = sheets[c.design];
    if (!S2) return;
    // pitch to the ground point: a car's own altitude never swaps its sheet mid-jump
    const S = pickSheet(S2, it.sc, (Math.atan2(cam.h, it.zc) * 180) / Math.PI);
    const sh = S.sheet;
    const near = sh.pxPerUnit === 4;
    const k = it.sc / sh.pxPerUnit;
    const yaw = yawIndex(c, cam, c.th);
    const bank = c.bank > 0.4 ? 2 : c.bank < -0.4 ? 0 : 1;
    let dx = it.sx - sh.anchorX * k, dy = it.sy - sh.anchorY * k;
    if (k > 0.98 && k < 1.02) { dx = Math.round(dx); dy = Math.round(dy); }
    // hover bob: a whole-pixel step so it survives the rounding above
    if (!c.retired && c.z <= 0.01 && near) dy += ((cam.t * 2.6 + c.id * 0.37) | 0) & 1;
    let mode = 0;
    if (c.retired && c.boomT >= 0 && c.boomT <= 0.15) mode = 1;
    else if (c.hitFlash > 0 && ((t * 30) | 0) & 1) mode = 1;
    else if (c.onPit && c.energy < SIM.ENERGY_MAX && ((t * 16) | 0) & 1) mode = 1;
    const alpha = c.retired === 'courseout' ? clamp(1 + c.z / 40, 0, 1) : 1;
    blit(view, S, yaw, bank, dx, dy, k, alpha < 1 ? 2 : mode, alpha);
    // engine flames
    if (c.retired) return;
    const ex = sh.exhaust[yaw] && sh.exhaust[yaw][bank];
    if (!ex) return;
    const boost = c.boostT > 0 || c.dashT > 0;
    const thr = c.input.throttle || boost ? 1 : 0.3;
    const flick = 0.8 + 0.2 * Math.sin(t * 60 + c.id * 3);
    for (const e of ex) {
      if (!e.visible) continue;
      const x = dx + e.x * k, y = dy + e.y * k;
      const r0 = Math.max(0.8, (e.r || 1.5 * sh.pxPerUnit / 4) * k) * flick;
      const fdx = (e.dx || 0) * k, fdy = (e.dy || 0) * k;
      if (boost) {
        // flame tongue streaming back along the nozzle's flame direction
        for (let q = 3; q >= 1; q--) glow(view, x + fdx * q * 2.2, y + fdy * q * 2.2, r0 * (1.9 - q * 0.35), 255, 100 + q * 25, 30, 1.25 - q * 0.2);
        glow(view, x, y, r0 * 1.5, 255, 150, 50, 1.2);
        glow(view, x, y, r0 * 0.9, 230, 240, 255, 1.2);
      } else {
        glow(view, x + fdx * 0.8, y + fdy * 0.8, r0 * (0.9 + 0.6 * thr), 70, 150, 255, 1.3);
        glow(view, x, y, r0 * 0.6, 220, 245, 255, 1.1 * thr + 0.3);
      }
    }
  }
  function drawGhost(view, it, sheets, cam, opts) {
    const g = it.g;
    const S2 = sheets[opts.ghostDesign];
    if (!S2) return;
    const S = pickSheet(S2, it.sc, (Math.atan2(cam.h, it.zc) * 180) / Math.PI);
    const sh = S.sheet, k = it.sc / sh.pxPerUnit;
    const yaw = yawIndex(g, cam, g.th);
    blit(view, S, yaw, 1, it.sx - sh.anchorX * k, it.sy - sh.anchorY * k, k, 2, 0.45);
  }

  // ------------------------------------------------------------------
  // Canvas-side helpers (browser only)
  // ------------------------------------------------------------------
  function buildMinimap(T, theme, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < T.n; i++) { x0 = Math.min(x0, T.px[i]); y0 = Math.min(y0, T.py[i]); x1 = Math.max(x1, T.px[i]); y1 = Math.max(y1, T.py[i]); }
    const pad = 4, sc = (size - pad * 2) / Math.max(x1 - x0, y1 - y0);
    const ox = pad + (size - pad * 2 - (x1 - x0) * sc) / 2 - x0 * sc, oy = pad + (size - pad * 2 - (y1 - y0) * sc) / 2 - y0 * sc;
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= T.n; i++) {
        const j = i % T.n;
        const x = ox + T.px[j] * sc, y = oy + T.py[j] * sc;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    };
    g.fillStyle = theme.palette.minimapBg || 'rgba(0,0,0,0.55)';
    g.fillRect(1, 1, size - 2, size - 2);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 1, 1, size - 2); g.fillRect(size - 1, 1, 1, size - 2); g.fillRect(1, 0, size - 2, 1); g.fillRect(1, size - 1, size - 2, 1);
    g.lineJoin = 'round';
    path(); g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = Math.max(3, size / 22); g.stroke();
    path(); g.strokeStyle = theme.palette.minimapRoad || '#ccd'; g.lineWidth = Math.max(1.5, size / 48); g.stroke();
    // start line marker
    g.fillStyle = '#fff';
    g.fillRect(ox + T.px[0] * sc - 2, oy + T.py[0] * sc - 2, 4, 4);
    return { canvas: cv, ox, oy, sc, size };
  }

  const HERO_DOT = { comet: '#4aa3ff', lynx: '#ffd23a', bison: '#5fd35f', hornet: '#ff4a6a' };

  function drawHUD(ctx, race, p, mm, opts) {
    const FONTD = FONT.draw;
    const t = opts.time || 0;
    const blink = ((t * 4) | 0) & 1;
    const SH = '#000';
    // --- top-left: lap & time
    const lap = Math.min(race.laps, p.lapsDone + 1);
    FONTD(ctx, 'LAP', 6, 5, { color: '#ffd23a', shadow: SH, italic: true });
    FONTD(ctx, `${lap}/${race.laps}`, 34, 5, { color: '#fff', shadow: SH, italic: true });
    const rt = race.phase === 'run' ? (p.finished ? p.finishT : p.retired ? p.retireT : race.t) : 0;
    FONTD(ctx, SIM.fmtTime(rt), 6, 15, { color: '#fff', scale: 2, shadow: SH, italic: true });
    // lap splits
    const touchL = !!opts.touch;
    const laps = p.lapTimes;
    for (let i = 0; i < laps.length && i < 5; i++) {
      FONTD(ctx, `${i + 1} ${SIM.fmtTime(laps[i])}`, touchL ? 56 : 6, 35 + i * 9, { color: i === laps.length - 1 && t - (opts.lastLapAt || -9) < 3 && blink ? '#ffd23a' : '#9fb4d8', shadow: SH });
    }
    // --- top-right: POWER meter + boosts
    const bx = W - 122, by = 6;
    FONTD(ctx, 'POWER', bx, by, { color: '#ffd23a', shadow: SH, italic: true });
    const e = clamp(p.energy / SIM.ENERGY_MAX, 0, 1);
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 1, by + 9, 118, 9);
    ctx.fillStyle = '#20263a';
    ctx.fillRect(bx, by + 10, 116, 7);
    let col = e > 0.5 ? '#3cf0c0' : e > 0.25 ? '#ffd23a' : '#ff3a3a';
    if (e <= 0.25 && blink) col = '#ffffff';
    if (p.onPit && e < 1 && ((t * 10) | 0) & 1) col = '#ff7af0';
    ctx.fillStyle = col;
    ctx.fillRect(bx + 1, by + 11, Math.round(114 * e), 5);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(bx + 1, by + 11, Math.round(114 * e), 1);
    for (let i = 1; i < 8; i++) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(bx + 1 + Math.round(i * 114 / 8), by + 11, 1, 5); }
    if (p.onPit && e < 1) FONTD(ctx, 'CHARGE', bx + 60, by, { color: blink ? '#ff7af0' : '#fff', shadow: SH });
    else if (e <= 0.25 && race.phase === 'run' && !p.retired && !p.finished) FONTD(ctx, e <= 0 ? 'DANGER' : 'LOW', bx + 60, by, { color: blink ? '#ff3a3a' : '#fff', shadow: SH });
    // boost stock
    for (let i = 0; i < SIM.MAX_BOOSTS; i++) {
      const has = i < p.boostStock;
      const x = bx + i * 15, y = by + 21;
      ctx.fillStyle = has ? '#000' : 'rgba(0,0,0,0.4)';
      ctx.fillRect(x, y, 13, 11);
      ctx.fillStyle = has ? (p.boostT > 0 && blink ? '#fff' : '#ff8a20') : '#3a3f55';
      ctx.fillRect(x + 1, y + 1, 11, 9);
      FONTD(ctx, 'S', x + 3, y + 2, { color: has ? '#fff' : '#5a6078' });
    }
    if (p.boostStock > 0 && race.phase === 'run' && p.boostT <= 0 && !p.retired && !p.finished) FONTD(ctx, 'BOOST OK', bx + 48, by + 23, { color: blink ? '#ffb040' : '#fff', shadow: SH });
    // --- minimap + rank + speed (touch layout keeps them clear of the on-screen buttons)
    if (mm && opts.minimap) {
      const mx = 6, my = touchL ? 34 : H - mm.size - 6;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(mm.canvas, mx, my);
      ctx.globalAlpha = 1;
      for (const c of race.cars) {
        if (c === p || (c.retired && c.boomT > 0.5)) continue;
        const x = Math.round(mx + mm.ox + c.x * mm.sc), y = Math.round(my + mm.oy + c.y * mm.sc);
        const sz = c.isHero ? 3 : 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(x - 2, y - 2, sz + 2, sz + 2);
        ctx.fillStyle = c.isHero ? HERO_DOT[c.design] || '#fff' : '#c8ccd8';
        ctx.fillRect(x - 1, y - 1, sz, sz);
      }
      const x = Math.round(mx + mm.ox + p.x * mm.sc), y = Math.round(my + mm.oy + p.y * mm.sc);
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = blink ? '#fff' : '#ff3a3a';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    const rank = p.rank;
    if (race.cars.length > 1) {
      const rs = String(rank);
      const lim = race.rankOut && !p.finished && !p.retired && p.lapsDone < SIM.RANK_LIMITS.length ? SIM.RANK_LIMITS[p.lapsDone] : 0;
      const limCol = rank > lim ? (blink ? '#ff3a3a' : '#fff') : '#7fe0a0';
      if (touchL) {
        // right-aligned so it always ends before the POWER meter
        const txt = `${rs}/${race.cars.length}`;
        const tw = FONT.measure(txt, 2);
        const rx = Math.min(W / 2 + 2, W - 130 - tw);
        FONTD(ctx, txt, rx, 5, { color: '#fff', scale: 2, outline: '#000', italic: true });
        FONTD(ctx, 'RANK', rx - 4 - FONT.measure('RANK'), 9, { color: '#ffd23a', shadow: SH, italic: true });
        if (lim) FONTD(ctx, `SAFE ${lim}`, rx + tw / 2, 23, { color: limCol, shadow: SH, align: 'center' });
      } else {
        const rx = mm && opts.minimap ? mm.size + 14 : 8;
        FONTD(ctx, 'RANK', rx, H - 40, { color: '#ffd23a', shadow: SH, italic: true });
        FONTD(ctx, rs, rx, H - 30, { color: '#fff', scale: 3, shadow: SH, outline: '#000', italic: true });
        FONTD(ctx, `/${race.cars.length}`, rx + FONT.measure(rs, 3) + 4, H - 16, { color: '#c8d4ee', outline: '#000' });
        if (lim) FONTD(ctx, `SAFE ${lim}`, rx, H - 50, { color: limCol, shadow: SH });
      }
    }
    // speed (a wreck shows its real drifting speed, not the speed at impact)
    const v = p.retired ? Math.hypot(p.vx, p.vy) : Math.max(0, p.vf);
    const sp = String(Math.round(v * SIM.KMH));
    const spCol = p.boostT > 0 || p.dashT > 0 ? '#ffb040' : '#fff';
    if (touchL) {
      FONTD(ctx, sp, W - 46, 40, { color: spCol, scale: 2, outline: '#000', italic: true, align: 'right' });
      FONTD(ctx, 'km/h', W - 42, 48, { color: '#c8d4ee', outline: '#000', italic: true });
    } else {
      FONTD(ctx, sp, W - 50, H - 30, { color: spCol, scale: 3, shadow: SH, outline: '#000', italic: true, align: 'right' });
      FONTD(ctx, 'km/h', W - 42, H - 16, { color: '#c8d4ee', outline: '#000', italic: true });
    }
  }

  return {
    W, H, HZ, F, CAM_H, CAM_D, pack, mix,
    buildWorld, createView, createCamera, followCamera, renderWorld, project,
    prepSheets, createFx, spawn, burst, updateFx, updateWeather,
    buildMinimap, drawHUD, fillRect, glow, disc, HERO_DOT,
  };
})();
