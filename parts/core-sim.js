// =====================================================================
// SIM — tracks, machines, physics, AI, race rules (no DOM: runs in Node)
// =====================================================================
const SIM = (() => {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapA = (a) => {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  };
  function rng(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const MAP = 2048;
  const STEP = 8; // target centre-line sample spacing (units)
  const RAIL_W = 10; // guard rail band width
  const CAR_R = 7; // collision radius
  const LAPS = 5;
  const RANK_LIMITS = [15, 10, 7, 5]; // must be at or above this rank when completing laps 1..4
  // The whole race runs PACE times faster than real time: physics, AI and track
  // geometry are unchanged (same lines, same balance), only the clock is warped.
  const PACE = 1.3;
  const KMH = 1.25 * PACE; // sim units/s -> displayed km/h (real speed)
  const DT = 1 / 120;
  const GRAVITY = 300;
  const ENERGY_MAX = 100;
  const PIT_RATE = 26; // energy / s
  const MAX_BOOSTS = 3;

  // ------------------------------------------------------------------
  // Machines
  // ------------------------------------------------------------------
  const MACHINES = {
    comet: {
      key: 'comet', name: 'BLUE COMET', pilot: 'NOVA KAI',
      vmax: 300, accel: 142, turn: 2.35, grip: 6.2, brake: 270, body: 1.0, mass: 1.0,
      boostMul: 1.32, boostTime: 2.4,
      bars: { speed: 3, accel: 3, grip: 3, body: 3 },
      desc: 'BALANCED ALL-ROUNDER',
    },
    lynx: {
      key: 'lynx', name: 'GOLD LYNX', pilot: 'MIRA SOL',
      vmax: 286, accel: 172, turn: 2.42, grip: 6.5, brake: 280, body: 1.45, mass: 0.82,
      boostMul: 1.32, boostTime: 2.2,
      bars: { speed: 2, accel: 5, grip: 4, body: 1 },
      desc: 'QUICK ACCEL/FRAGILE',
    },
    bison: {
      key: 'bison', name: 'IRON BISON', pilot: 'DOC GRANT',
      vmax: 296, accel: 134, turn: 2.31, grip: 7.3, brake: 255, body: 0.6, mass: 1.38,
      boostMul: 1.30, boostTime: 2.7,
      bars: { speed: 3, accel: 2, grip: 4, body: 5 },
      desc: 'ARMORED/STEADY GRIP',
    },
    hornet: {
      key: 'hornet', name: 'RED HORNET', pilot: 'VEGA RAY',
      vmax: 324, accel: 124, turn: 2.24, grip: 5.6, brake: 245, body: 0.92, mass: 1.15,
      boostMul: 1.34, boostTime: 2.5,
      bars: { speed: 5, accel: 2, grip: 2, body: 3 },
      desc: 'TOP SPEED/HEAVY TURN',
    },
  };
  const HERO_KEYS = ['comet', 'lynx', 'bison', 'hornet'];
  const DRONE = {
    key: 'drone', name: 'DRONE', vmax: 276, accel: 130, turn: 2.4, grip: 6.4, brake: 260,
    body: 1.1, mass: 0.95, boostMul: 1.25, boostTime: 2.0,
  };

  const DIFFICULTY = {
    beginner: { label: 'BEGINNER', rival: 0.9, drone: 0.82, rivalSkill: 0.86, rubber: 0.05 },
    standard: { label: 'STANDARD', rival: 0.965, drone: 0.87, rivalSkill: 0.93, rubber: 0.05 },
    master: { label: 'MASTER', rival: 1.02, drone: 0.91, rivalSkill: 0.985, rubber: 0.04 },
  };

  // ------------------------------------------------------------------
  // Courses.  pts: [x, y, cornerRadius, halfWidth?] — straights joined by
  // circular fillets.  The start line sits on the straight from the LAST
  // vertex to the FIRST one (startFrac along it).  Edge k = straight from
  // vertex k to k+1, corner k = fillet at vertex k.
  // Feature d values are fractions of the local half-width (-1 left .. +1 right).
  // ------------------------------------------------------------------
  const COURSES = [
    {
      id: 'neon', name: 'NEON CITY', theme: 'neon', bgm: 'neon', hw: 62, startFrac: 0.62,
      pts: [
        [1760, 1760, 230], [1760, 300, 210], [1080, 300, 150], [1080, 880, 130],
        [760, 880, 130], [760, 300, 150], [290, 300, 210], [290, 1760, 230],
      ],
      features: [
        { type: 'pit', edge: 0, t0: 0.12, t1: 0.7, d0: -0.98, d1: -0.42 },
        { type: 'dash', edge: 1, t: 0.45, d: 0 },
        { type: 'dash', edge: 6, t: 0.35, d: -0.35 },
        { type: 'dash', edge: 6, t: 0.62, d: 0.35 },
      ],
    },
    {
      id: 'coast', name: 'BLUE COAST', theme: 'coast', bgm: 'coast', hw: 64, startFrac: 0.6,
      pts: [
        [1720, 1680, 260], [1800, 760, 260], [1420, 300, 220], [980, 600, 200],
        [560, 280, 200], [280, 760, 220], [620, 1180, 200], [360, 1720, 170],
      ],
      features: [
        { type: 'pit', edge: 0, t0: 0.15, t1: 0.75, d0: 0.42, d1: 0.98 },
        { type: 'jump', edge: 3, t: 0.22, d: 0, wid: 1.6 },
        { type: 'dash', edge: 1, t: 0.5, d: -0.3 },
        { type: 'dash', edge: 4, t: 0.5, d: 0.3 },
        { type: 'dash', edge: 7, t: 0.25, d: 0 },
        { type: 'rough', corner: 2, t0: 0.1, t1: 0.9, side: 'out' },
        { type: 'rough', corner: 5, t0: 0.15, t1: 0.85, side: 'out' },
        { type: 'rough', corner: 7, t0: 0.2, t1: 0.8, side: 'out' },
      ],
    },
    {
      id: 'desert', name: 'DUNE SEA', theme: 'desert', bgm: 'desert', hw: 58, startFrac: 0.55,
      pts: [
        [1780, 1500, 220], [1640, 330, 170], [1260, 520, 150], [1300, 1180, 120],
        [950, 1260, 120], [800, 420, 170], [330, 330, 190], [260, 1620, 210], [900, 1790, 200],
      ],
      features: [
        { type: 'pit', edge: 8, t0: 0.62, t1: 0.95, d0: -0.98, d1: -0.42 },
        { type: 'rough', edge: 2, t0: 0.25, t1: 0.75, d0: -1.0, d1: -0.35 },
        { type: 'rough', edge: 4, t0: 0.3, t1: 0.7, d0: 0.35, d1: 1.0 },
        { type: 'rough', corner: 3, t0: 0, t1: 1, side: 'out' },
        { type: 'rough', corner: 4, t0: 0, t1: 1, side: 'out' },
        { type: 'rough', corner: 6, t0: 0.2, t1: 0.8, side: 'in', depth: 0.35 },
        { type: 'dash', edge: 0, t: 0.55, d: 0 },
        { type: 'dash', edge: 5, t: 0.4, d: 0 },
        { type: 'dash', edge: 6, t: 0.5, d: 0.3 },
        { type: 'jump', edge: 6, t: 0.2, d: -0.25, wid: 0.9 },
      ],
    },
    {
      id: 'gale', name: 'STORM VALLEY', theme: 'gale', bgm: 'gale', hw: 58, startFrac: 0.58,
      pts: [
        [1780, 1700, 220], [1640, 900, 200], [1780, 330, 170], [1150, 300, 160],
        [1260, 1000, 150], [880, 1180, 150], [680, 360, 180], [260, 520, 180], [330, 1500, 200],
      ],
      features: [
        { type: 'pit', edge: 8, t0: 0.66, t1: 0.97, d0: 0.42, d1: 0.98 },
        { type: 'wind', edge: 0, t0: 0.05, t1: 0.95, force: 95 },
        { type: 'wind', corner: 6, t0: 0.5, t1: 1, force: -95 },
        { type: 'wind', edge: 6, t0: 0, t1: 1, force: -95 },
        { type: 'wind', corner: 7, t0: 0, t1: 0.5, force: -95 },
        { type: 'wind', edge: 3, t0: 0.1, t1: 0.9, force: 70 },
        { type: 'mines', edge: 3, t0: 0.25, t1: 0.75, count: 5 },
        { type: 'mines', edge: 5, t0: 0.3, t1: 0.7, count: 4 },
        { type: 'dash', edge: 2, t: 0.5, d: 0 },
        { type: 'dash', edge: 7, t: 0.45, d: -0.3 },
        { type: 'dash', edge: 7, t: 0.7, d: 0.3 },
        { type: 'rough', corner: 4, t0: 0.1, t1: 0.9, side: 'out' },
      ],
    },
    {
      id: 'frost', name: 'FROST LINE', theme: 'frost', bgm: 'frost', hw: 60, startFrac: 0.6,
      pts: [
        [1760, 1700, 230], [1760, 980, 200], [1380, 820, 170], [1700, 300, 180], [960, 280, 200],
        [1060, 880, 160], [640, 1000, 160], [420, 280, 130], [220, 520, 130], [280, 1700, 220],
      ],
      features: [
        { type: 'pit', edge: 9, t0: 0.66, t1: 0.97, d0: -0.98, d1: -0.42 },
        { type: 'ice', corner: 2, t0: 0, t1: 1, d0: -1.0, d1: 1.0 },
        { type: 'ice', corner: 5, t0: 0.1, t1: 0.9, side: 'out', depth: 0.7 },
        { type: 'ice', edge: 6, t0: 0.3, t1: 0.75, d0: -1.0, d1: -0.1 },
        { type: 'ice', corner: 7, t0: 0, t1: 1, side: 'in', depth: 0.5 },
        { type: 'jump', edge: 3, t: 0.3, d: 0, wid: 1.6 },
        { type: 'dash', edge: 0, t: 0.5, d: 0 },
        { type: 'dash', edge: 4, t: 0.55, d: -0.3 },
        { type: 'dash', edge: 8, t: 0.6, d: 0 },
      ],
    },
    {
      id: 'inferno', name: 'MAGMA FIELD', theme: 'inferno', bgm: 'inferno', hw: 54, startFrac: 0.6,
      pts: [
        [1780, 1780, 200], [1780, 1040, 150], [1420, 1080, 120], [1430, 700, 120],
        [1780, 640, 150], [1720, 270, 160], [980, 300, 150], [1040, 860, 130],
        [640, 980, 130], [600, 300, 150], [270, 300, 150], [270, 1780, 200],
      ],
      features: [
        { type: 'pit', edge: 11, t0: 0.7, t1: 0.98, d0: 0.42, d1: 0.98 },
        { type: 'rough', corner: 2, t0: 0, t1: 1, side: 'out' },
        { type: 'rough', corner: 7, t0: 0, t1: 1, side: 'out' },
        { type: 'rough', corner: 8, t0: 0, t1: 1, side: 'out' },
        { type: 'rough', edge: 7, t0: 0.3, t1: 0.7, d0: -0.25, d1: 0.25 },
        { type: 'mines', edge: 5, t0: 0.2, t1: 0.8, count: 6 },
        { type: 'mines', edge: 10, t0: 0.66, t1: 0.94, count: 5 },
        { type: 'dash', edge: 0, t: 0.5, d: -0.3 },
        { type: 'dash', edge: 5, t: 0.5, d: 0.45 },
        { type: 'dash', edge: 9, t: 0.5, d: 0 },
        { type: 'jump', edge: 10, t: 0.3, d: 0, wid: 1.7 },
      ],
    },
  ];

  const CUPS = [
    { id: 'comet', name: 'COMET CUP', courses: ['neon', 'coast', 'desert'] },
    { id: 'nova', name: 'NOVA CUP', courses: ['gale', 'frost', 'inferno'] },
    { id: 'galaxy', name: 'GALAXY CUP', courses: ['neon', 'coast', 'desert', 'gale', 'frost', 'inferno'] },
  ];
  const POINTS = [20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  const courseById = (id) => COURSES.find((c) => c.id === id);

  // ------------------------------------------------------------------
  // Track builder
  // ------------------------------------------------------------------
  function buildTrack(def) {
    const V = def.pts.map((p) => ({ x: p[0], y: p[1], r: p[2], w: p.length > 3 ? p[3] : def.hw }));
    const n = V.length;
    const C = [];
    const errors = [];
    for (let k = 0; k < n; k++) {
      const P = V[(k + n - 1) % n], Q = V[k], N = V[(k + 1) % n];
      let ax = Q.x - P.x, ay = Q.y - P.y;
      const al = Math.hypot(ax, ay);
      ax /= al; ay /= al;
      let bx = N.x - Q.x, by = N.y - Q.y;
      const bl = Math.hypot(bx, by);
      bx /= bl; by /= bl;
      const phi = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      const sg = phi >= 0 ? 1 : -1;
      const r = Q.r;
      const t = r * Math.tan(Math.abs(phi) / 2);
      const sx = Q.x - ax * t, sy = Q.y - ay * t;
      const ex = Q.x + bx * t, ey = Q.y + by * t;
      const cx = sx - ay * sg * r, cy = sy + ax * sg * r;
      C.push({ k, sx, sy, ex, ey, cx, cy, r, phi, sg, t, len: r * Math.abs(phi), a0: Math.atan2(sy - cy, sx - cx), w: Q.w });
      if (Q.w + RAIL_W + 6 > r && Math.abs(phi) > 0.05) errors.push(`corner ${k}: radius ${r} too small for half-width ${Q.w}`);
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const el = Math.hypot(V[k2].x - V[k].x, V[k2].y - V[k].y);
      if (C[k].t + C[k2].t > el + 1e-6) errors.push(`edge ${k}: fillets overlap (${(C[k].t + C[k2].t).toFixed(0)} > ${el.toFixed(0)})`);
    }
    // pieces, starting with the straight from vertex n-1 to vertex 0
    const pieces = [];
    for (let k = 0; k < n; k++) {
      const pk = (k + n - 1) % n;
      const prev = C[pk], cur = C[k];
      const len = Math.max(0, Math.hypot(cur.sx - prev.ex, cur.sy - prev.ey));
      pieces.push({ kind: 'edge', k: pk, len, x0: prev.ex, y0: prev.ey, x1: cur.sx, y1: cur.sy, w0: V[pk].w, w1: V[k].w });
      pieces.push({ kind: 'corner', k, len: cur.len, c: cur, w0: cur.w, w1: cur.w });
    }
    let acc = 0;
    for (const p of pieces) { p.u0 = acc; acc += p.len; }
    const Ltot = acc;
    const startU = def.startFrac * pieces[0].len;
    const ns = Math.round(Ltot / STEP);
    const step = Ltot / ns;
    const px = new Float32Array(ns), py = new Float32Array(ns);
    const tx = new Float32Array(ns), ty = new Float32Array(ns);
    const hw = new Float32Array(ns), head = new Float32Array(ns);
    const pieceOf = new Int16Array(ns);
    const evalAt = (u, out) => {
      u = ((u % Ltot) + Ltot) % Ltot;
      let j = 0;
      while (j < pieces.length - 1 && pieces[j].u0 + pieces[j].len <= u) j++;
      const p = pieces[j];
      const v = u - p.u0;
      if (p.kind === 'edge') {
        const f = p.len > 0 ? v / p.len : 0;
        out.x = lerp(p.x0, p.x1, f); out.y = lerp(p.y0, p.y1, f);
        const l = p.len > 0 ? p.len : 1;
        out.tx = p.len > 0 ? (p.x1 - p.x0) / l : 1; out.ty = p.len > 0 ? (p.y1 - p.y0) / l : 0;
        out.w = lerp(p.w0, p.w1, f);
      } else {
        const c = p.c;
        const a = c.a0 + (c.sg * v) / c.r;
        out.x = c.cx + Math.cos(a) * c.r; out.y = c.cy + Math.sin(a) * c.r;
        out.tx = -Math.sin(a) * c.sg; out.ty = Math.cos(a) * c.sg;
        out.w = c.w;
      }
      out.piece = j;
      return out;
    };
    const tmp = {};
    for (let i = 0; i < ns; i++) {
      evalAt(startU + i * step, tmp);
      px[i] = tmp.x; py[i] = tmp.y; tx[i] = tmp.tx; ty[i] = tmp.ty; hw[i] = tmp.w;
      head[i] = Math.atan2(tmp.ty, tmp.tx);
      pieceOf[i] = tmp.piece;
    }
    // curvature (signed, + = right turn), smoothed radius and racing-line offset
    const kap = new Float32Array(ns);
    for (let i = 0; i < ns; i++) kap[i] = wrapA(head[(i + 1) % ns] - head[(i + ns - 1) % ns]) / (2 * step);
    const smooth = (src, rad) => {
      const out = new Float32Array(ns);
      for (let i = 0; i < ns; i++) {
        let s = 0;
        for (let k = -rad; k <= rad; k++) s += src[(i + k + ns) % ns];
        out[i] = s / (2 * rad + 1);
      }
      return out;
    };
    const kapS = smooth(kap, 3);
    const R = new Float32Array(ns);
    for (let i = 0; i < ns; i++) R[i] = 1 / Math.max(Math.abs(kapS[i]), 1e-5);
    const kapL = smooth(smooth(kap, 14), 8);
    const line = new Float32Array(ns);
    for (let i = 0; i < ns; i++) line[i] = clamp(kapL[i] * 72, -0.55, 0.55);

    const T = {
      def, id: def.id, name: def.name, theme: def.theme, L: Ltot, n: ns, step,
      px, py, tx, ty, hw, head, kap: kapS, R, line, pieceOf,
      errors, warnings: [],
      dash: [], jump: [], zones: [], mines: [], grid: [],
    };
    // piece s-ranges in track coordinates
    const pieceS = (j) => (((pieces[j].u0 - startU) % Ltot) + Ltot) % Ltot;
    const findPiece = (kind, k) => pieces.findIndex((p) => p.kind === kind && p.k === k);
    const anchor = (f) => {
      const j = f.edge !== undefined ? findPiece('edge', f.edge) : findPiece('corner', f.corner);
      if (j < 0) { errors.push(`feature ${f.type}: bad anchor`); return null; }
      return { s0: pieceS(j), len: pieces[j].len };
    };
    const hwAt = (s) => hw[Math.floor(wrapS(T, s) / step) % ns];
    let fid = 0;
    for (let f of def.features) {
      const a = anchor(f);
      if (!a) continue;
      if (f.type === 'dash' || f.type === 'jump') {
        const s = wrapS(T, a.s0 + f.t * a.len);
        const w = hwAt(s);
        T[f.type].push({
          id: fid++, s, d: f.d * w,
          len: f.type === 'dash' ? 26 : 30,
          wid: (f.wid !== undefined ? f.wid : f.type === 'dash' ? 0.5 : 1.2) * w,
        });
      } else if (f.type === 'mines') {
        const r = rng(fid * 977 + 13);
        for (let m = 0; m < f.count; m++) {
          const u = f.count > 1 ? m / (f.count - 1) : 0.5;
          const s = wrapS(T, a.s0 + lerp(f.t0, f.t1, u) * a.len);
          const w = hwAt(s);
          // alternate sides, keeping a narrow clear lane down the middle
          const d = (m % 2 ? 1 : -1) * (0.42 + 0.26 * r()) * w;
          const p = posAt(T, s, d);
          T.mines.push({ id: fid++, x: p.x, y: p.y, s, d, active: true, respawn: 0 });
        }
      } else {
        if (f.side) {
          const j = findPiece('corner', f.corner);
          const sg = j >= 0 ? pieces[j].c.sg : 1;
          const depth = f.depth || 0.45;
          const outSide = f.side === 'out' ? -sg : sg;
          f = { ...f, d0: outSide < 0 ? -1 : 1 - depth, d1: outSide < 0 ? -1 + depth : 1 };
        }
        const z = {
          id: fid++, type: f.type,
          s0: wrapS(T, a.s0 + f.t0 * a.len), s1: wrapS(T, a.s0 + f.t1 * a.len),
          d0: f.d0 !== undefined ? f.d0 : -1, d1: f.d1 !== undefined ? f.d1 : 1,
          force: f.force || 0,
        };
        T.zones.push(z);
      }
    }
    T.pit = T.zones.find((z) => z.type === 'pit') || null;
    // per-sample hazard flags for the AI
    T.slip = new Uint8Array(ns);
    for (let i = 0; i < ns; i++) {
      const s = i * step;
      for (const z of T.zones) if (z.type === 'ice' && inS(T, s, z.s0, z.s1)) T.slip[i] = 1;
    }
    // starting grid: 20 slots behind the line, two staggered columns
    for (let g = 0; g < 20; g++) {
      const row = g >> 1, col = g & 1;
      const s = wrapS(T, -34 - row * 30 - col * 15);
      const w = hwAt(s);
      const d = (col ? 0.38 : -0.38) * w;
      const p = posAt(T, s, d);
      T.grid.push({ x: p.x, y: p.y, th: Math.atan2(p.ty, p.tx), s, d });
    }
    validateTrack(T);
    return T;
  }

  function wrapS(T, s) {
    s %= T.L;
    return s < 0 ? s + T.L : s;
  }
  function sdiff(T, a, b) {
    // signed shortest distance a - b along the loop
    let d = a - b;
    if (d > T.L / 2) d -= T.L;
    else if (d < -T.L / 2) d += T.L;
    return d;
  }
  function inS(T, s, s0, s1) {
    return s0 <= s1 ? s >= s0 && s <= s1 : s >= s0 || s <= s1;
  }
  function posAt(T, s, d) {
    s = wrapS(T, s);
    const f = s / T.step;
    const i0 = Math.floor(f) % T.n, i1 = (i0 + 1) % T.n, t = f - Math.floor(f);
    const x = lerp(T.px[i0], T.px[i1], t), y = lerp(T.py[i0], T.py[i1], t);
    let tx = lerp(T.tx[i0], T.tx[i1], t), ty = lerp(T.ty[i0], T.ty[i1], t);
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    return { x: x - ty * d, y: y + tx * d, tx, ty, hw: lerp(T.hw[i0], T.hw[i1], t) };
  }

  function validateTrack(T) {
    // clearance between non-adjacent parts of the loop
    const n = T.n;
    const minGap = (i, j) => T.hw[i] + T.hw[j] + 2 * RAIL_W + 36;
    let worst = Infinity;
    for (let i = 0; i < n; i += 2) {
      for (let j = i + 2; j < n; j += 2) {
        let di = Math.abs(i - j);
        di = Math.min(di, n - di) * T.step;
        if (di < (T.hw[i] + T.hw[j]) * 2.2 + 60) continue;
        const d = Math.hypot(T.px[i] - T.px[j], T.py[i] - T.py[j]);
        const g = d - minGap(i, j);
        if (g < worst) worst = g;
        if (g < 0) {
          T.errors.push(`clearance: s=${(i * T.step) | 0} vs s=${(j * T.step) | 0} gap ${d.toFixed(0)} < ${minGap(i, j).toFixed(0)}`);
          i += 8;
          break;
        }
      }
    }
    T.clearance = worst;
    // inside the map with margin
    const M = 150;
    for (let i = 0; i < n; i++) {
      const m = T.hw[i] + RAIL_W + 20;
      if (T.px[i] < m + M * 0.3 || T.py[i] < m + M * 0.3 || T.px[i] > MAP - m - M * 0.3 || T.py[i] > MAP - m - M * 0.3) {
        T.errors.push(`out of map at s=${(i * T.step) | 0}`);
        break;
      }
    }
    // grid must sit on the start straight (no curvature)
    const g = T.grid[T.grid.length - 1];
    const gi = Math.floor(g.s / T.step);
    for (let i = gi; i !== 0; i = (i + 1) % n) if (Math.abs(T.kap[i]) > 1e-4) { T.errors.push('starting grid reaches a corner'); break; }
  }

  // nearest-segment projection with a local search window
  function locate(T, x, y, hint, out) {
    const n = T.n, px = T.px, py = T.py;
    let best = 0, bd = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const d = (px[i] - x) * (px[i] - x) + (py[i] - y) * (py[i] - y);
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let k = -12; k <= 12; k++) {
        const i = (hint + k + n) % n;
        const d = (px[i] - x) * (px[i] - x) + (py[i] - y) * (py[i] - y);
        if (d < bd) { bd = d; best = i; }
      }
    }
    let ri = best, rt = 0, rd = Infinity;
    for (let q = 0; q < 2; q++) {
      const i0 = q === 0 ? (best + n - 1) % n : best, i1 = (i0 + 1) % n;
      const ex = px[i1] - px[i0], ey = py[i1] - py[i0];
      let t = ((x - px[i0]) * ex + (y - py[i0]) * ey) / (ex * ex + ey * ey);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px[i0] + ex * t - x, qy = py[i0] + ey * t - y;
      const d = qx * qx + qy * qy;
      if (d < rd) { rd = d; ri = i0; rt = t; }
    }
    const i1 = (ri + 1) % n;
    const ex = px[i1] - px[ri], ey = py[i1] - py[ri];
    const l = Math.hypot(ex, ey);
    const nx = -ey / l, ny = ex / l;
    out.i = ri;
    let s = (ri + rt) * T.step;
    if (s >= T.L) s -= T.L;
    out.s = s;
    out.d = (x - px[ri]) * nx + (y - py[ri]) * ny;
    out.hw = T.hw[ri] + (T.hw[i1] - T.hw[ri]) * rt;
    out.nx = nx; out.ny = ny;
    return out;
  }

  // ------------------------------------------------------------------
  // Cars
  // ------------------------------------------------------------------
  function makeCar(id, spec) {
    return {
      id,
      name: spec.name,
      key: spec.key, // machine key (stats)
      design: spec.design, // sprite key
      m: spec.m,
      isPlayer: !!spec.isPlayer,
      isHero: !!spec.isHero,
      ai: null,
      vmul: 1, amul: 1,
      x: 0, y: 0, z: 0, vz: 0, th: 0, vx: 0, vy: 0, speed: 0, vf: 0,
      steer: 0, lean: 0, bank: 0,
      input: { steer: 0, throttle: 0, brake: 0, lean: 0, boost: 0 },
      prevBoost: 0,
      energy: ENERGY_MAX, boostStock: 0, boostT: 0, dashT: 0,
      seg: -1, s: 0, d: 0, hw: 60, nx: 0, ny: 0,
      raceDist: 0, maxRD: 0, lapsDone: 0, lapStartT: 0, lapTimes: [],
      finished: false, finishT: 0, place: 0, rank: id + 1,
      retired: null, retireT: 0, retireDist: 0, boomT: -1,
      onPit: false, onRough: false, onIce: false, wind: 0,
      scrapeT: 0, hitFlash: 0, sparkT: 0, plateCD: 0, plateId: -1,
      wrongT: 0, airT: 0, lastLand: 0, throttleSince: -1, rocket: false, overRail: false,
      stats: { wallHits: 0, carHits: 0, maxSpeed: 0 },
    };
  }

  function placeOnGrid(race, c, slot) {
    const g = race.track.grid[slot];
    c.x = g.x; c.y = g.y; c.th = g.th; c.vx = c.vy = 0; c.z = c.vz = 0; c.overRail = false;
    c.seg = -1;
    const L = locate(race.track, c.x, c.y, -1, {});
    c.seg = L.i; c.s = L.s; c.d = L.d; c.hw = L.hw;
    c.raceDist = c.s > race.track.L / 2 ? c.s - race.track.L : c.s;
    c.maxRD = c.raceDist;
    c.gridSlot = slot;
  }

  // ------------------------------------------------------------------
  // Race
  // ------------------------------------------------------------------
  // opts: { course, playerMachine|null, mode: 'gp'|'free'|'ta'|'attract', difficulty, gridOrder?, seed }
  function createRace(track, opts) {
    const r = rng(opts.seed || 1234);
    const diff = DIFFICULTY[opts.difficulty || 'standard'];
    const race = {
      track, opts, mode: opts.mode, diff, rand: r,
      cars: [], player: null,
      phase: 'countdown', count: opts.countdown !== undefined ? opts.countdown : 3.6, t: 0, tick: 0,
      events: [], finishCount: 0, rankOut: opts.mode === 'gp',
      laps: opts.laps || LAPS, doneT: -1,
      mines: track.mines.map((m) => ({ ...m })),
      ghostRec: [], newFinish: [], rankCheck: 0, goTick: 0,
    };
    const solo = opts.mode === 'ta';
    const specs = [];
    const pm = opts.playerMachine;
    if (pm) specs.push({ key: pm, design: pm, m: MACHINES[pm], name: MACHINES[pm].name, isPlayer: true, isHero: true });
    if (!solo) {
      for (const k of HERO_KEYS) if (k !== pm) specs.push({ key: k, design: k, m: MACHINES[k], name: MACHINES[k].name, isHero: true });
      let di = 0;
      while (specs.length < 20) {
        specs.push({ key: 'drone', design: 'drone' + (di % 6), m: DRONE, name: 'DRONE ' + (di + 1) });
        di++;
      }
    }
    specs.forEach((sp, i) => race.cars.push(makeCar(i, sp)));
    race.player = race.cars.find((c) => c.isPlayer) || null;
    // grid order: rivals up front, player in slot given by opts.playerSlot
    const order = opts.gridOrder ? opts.gridOrder.slice() : defaultGrid(race, opts);
    order.forEach((carIdx, slot) => placeOnGrid(race, race.cars[carIdx], slot));
    // AI setup
    for (const c of race.cars) {
      if (c.isPlayer && opts.mode !== 'attract') continue;
      setupAI(race, c);
    }
    updateRanks(race);
    return race;
  }

  function defaultGrid(race, opts) {
    const cars = race.cars;
    const heroes = cars.filter((c) => c.isHero && !c.isPlayer).map((c) => c.id);
    const drones = cars.filter((c) => !c.isHero).map((c) => c.id);
    const order = [];
    // drones fill the front, heroes mid-pack, player near the back like the classic
    const want = opts.playerSlot !== undefined ? opts.playerSlot : 9;
    const pslot = Math.max(0, Math.min(cars.length - 1, want));
    const rest = [...drones.slice(0, 4), ...heroes, ...drones.slice(4)];
    for (let s = 0; s < cars.length; s++) {
      if (race.player && s === pslot) order.push(race.player.id);
      else order.push(rest.shift());
    }
    return order;
  }

  function setupAI(race, c) {
    const r = race.rand;
    const d = race.diff;
    const hero = c.isHero;
    c.ai = {
      skill: hero ? d.rivalSkill + r() * 0.03 : 0.9 + r() * 0.06,
      lane: (r() - 0.5) * 0.7,
      laneT: 1 + r() * 3,
      avoid: 0,
      pitAt: hero ? 38 + r() * 10 : 34,
      boostWait: 2 + r() * 4,
      reaction: 0,
      rubber: hero && race.mode !== 'attract',
    };
    if (c.isPlayer) {
      // autopilot (attract mode / after finishing)
      c.ai.skill = 0.92; c.ai.rubber = false;
    }
    if (hero) {
      c.vmul = c.isPlayer ? 1 : d.rival;
      c.amul = c.isPlayer ? 1 : 0.92 + d.rival * 0.08;
    } else {
      c.vmul = d.drone * (0.96 + r() * 0.06);
      c.amul = 0.9;
    }
    if (race.mode === 'attract') { c.vmul = hero ? 0.98 : 0.9; c.amul = 1; }
  }

  // speed the AI can carry through radius R
  function cornerSpeed(c, R) {
    const turn = c.m.turn, vmax = c.m.vmax * c.vmul;
    return (0.86 * R * turn) / (1 + (0.32 * R * turn) / vmax);
  }

  const PLAN_N = 13;
  const OBS = [];
  function planLane(race, c, pref, sp) {
    const T = race.track;
    OBS.length = 0;
    const range = 90 + Math.max(0, sp) * 0.55;
    for (const o of race.cars) {
      if (o === c || o.retired || o.z > 6) continue;
      const ds = sdiff(T, o.s, c.s);
      if (ds < -10 || ds > range) continue;
      const closing = sp - Math.max(0, o.vf);
      if (ds > 0 && closing < -10) continue;
      OBS.push(ds, o.d, 17, closing > 30 ? 1 : 0.5);
    }
    for (const mn of race.mines) {
      if (!mn.active) continue;
      const ds = sdiff(T, mn.s, c.s);
      if (ds < 0 || ds > range + 60) continue;
      OBS.push(ds, mn.d, 17, 2.4);
    }
    const sR = wrapS(T, c.s + 50 + Math.max(0, sp) * 0.3);
    let best = pref, bestC = Infinity;
    for (let k = 0; k < PLAN_N; k++) {
      const cd = -0.8 + (1.6 * k) / (PLAN_N - 1);
      const dU = cd * c.hw;
      let cost = Math.abs(cd - pref) * 1.2 + (Math.abs(dU - c.d) / c.hw) * 0.25;
      for (let q = 0; q < OBS.length; q += 4) {
        const ds = OBS[q], R = OBS[q + 2];
        const f = clamp(ds / 90, 0, 1);
        const gap = Math.abs(c.d + (dU - c.d) * f - OBS[q + 1]);
        if (gap < R) cost += ((R - gap) / R) * OBS[q + 3] * (1.2 - 0.6 * clamp(ds / range, 0, 1));
      }
      for (const z of T.zones) {
        if (z.type === 'rough' && inS(T, sR, z.s0, z.s1) && cd > z.d0 - 0.12 && cd < z.d1 + 0.12) cost += 0.8;
      }
      if (cost < bestC) { bestC = cost; best = cd; }
    }
    return best;
  }

  function aiControl(race, c, dt) {
    const T = race.track, ai = c.ai, inp = c.input;
    const n = T.n;
    const fx = Math.cos(c.th), fy = Math.sin(c.th);
    const sp = c.vx * fx + c.vy * fy;
    ai.laneT -= dt;
    if (ai.laneT <= 0) {
      ai.lane = (race.rand() - 0.5) * (c.isHero ? 0.5 : 0.8);
      ai.laneT = 2.5 + race.rand() * 4;
    }
    const look = 30 + Math.max(0, sp) * 0.3;
    const sT = c.s + look;
    const iT = Math.floor(wrapS(T, sT) / T.step) % n;
    const lineV = T.line[iT];
    let dFrac = lineV + ai.lane * (1 - Math.min(1, Math.abs(lineV) * 1.5));
    // pit stop: prefer the pit lane when energy is low
    const pit = T.pit;
    if (pit && c.energy < ai.pitAt) {
      const ahead = sdiff(T, pit.s0, c.s);
      if ((ahead > 0 && ahead < 500) || inS(T, c.s, pit.s0, pit.s1)) dFrac = (pit.d0 + pit.d1) / 2;
    }
    // lane planner (30 Hz, staggered per car): dodge mines, slower cars and rough patches
    if (ai.planD === undefined || ((race.tick + c.id) & 3) === 0) ai.planD = planLane(race, c, dFrac, sp);
    if (ai.curD === undefined) ai.curD = c.d / c.hw;
    ai.curD += clamp(ai.planD - ai.curD, -dt * 1.8, dt * 1.8);
    dFrac = ai.curD;
    dFrac = clamp(dFrac, -0.8, 0.8);
    const tgt = posAt(T, sT, dFrac * T.hw[iT]);
    const desired = Math.atan2(tgt.y - c.y, tgt.x - c.x);
    const err = wrapA(desired - c.th);
    // wall guard
    let steer = err * 3.2;
    const margin = c.hw - Math.abs(c.d);
    if (margin < 16) {
      const vOut = (c.vx * c.nx + c.vy * c.ny) * Math.sign(c.d);
      if (vOut > 0) steer -= Math.sign(c.d) * 0.6;
    }
    inp.steer = clamp(steer, -1, 1);
    // speed plan
    let vt = c.m.vmax * c.vmul * (c.boostT > 0 ? c.m.boostMul : 1) * (c.dashT > 0 ? 1.22 : 1);
    const DEC = 170;
    const i0 = c.seg;
    // a jump plate ahead means no braking while airborne after it
    let jumpAt = -1;
    for (const jp of T.jump) {
      const ds = sdiff(T, jp.s, c.s);
      if (ds > 0 && ds < 600 && Math.abs(c.d - jp.d) < jp.wid / 2 + 20) { jumpAt = ds; break; }
    }
    for (let k = 2; k < 80; k += 2) {
      const j = (i0 + k) % n;
      const vs = cornerSpeed(c, T.R[j]) * (0.9 + 0.1 * ai.skill) * (T.slip[j] ? 0.72 : 1);
      let dist = k * T.step;
      if (jumpAt >= 0 && dist > jumpAt) dist = Math.max(0, dist - Math.min(230, dist - jumpAt));
      const v = Math.sqrt(vs * vs + 2 * DEC * dist);
      if (v < vt) vt = v;
    }
    vt *= 0.97 + 0.03 * ai.skill;
    if (c.onRough) vt = Math.min(vt, c.m.vmax * 0.55);
    if (ai.rubber && race.player && !race.player.retired) {
      const lead = c.raceDist - race.player.raceDist;
      const k = race.diff.rubber;
      vt *= clamp(1 - (lead / 2500) * k, 1 - k, 1 + k);
    }
    if (c.isPlayer || !c.isHero) vt *= ai.skill > 0.95 ? 1 : 0.985 + 0.015 * ai.skill;
    inp.throttle = sp < vt ? 1 : 0;
    inp.brake = sp > vt + 22 ? 1 : 0;
    inp.lean = Math.abs(err) > 0.3 && sp > 160 ? Math.sign(err) : 0;
    // boost on long straights
    inp.boost = 0;
    if (c.boostStock > 0 && c.boostT <= 0 && race.phase === 'run') {
      ai.boostWait -= dt;
      if (ai.boostWait <= 0) {
        let straight = true;
        for (let k = 0; k < 70; k += 3) if (T.R[(i0 + k) % n] < 900) { straight = false; break; }
        if (straight && c.isHero) { inp.boost = 1; ai.boostWait = 3 + race.rand() * 5; }
      }
    }
  }

  // ------------------------------------------------------------------
  // Physics
  // ------------------------------------------------------------------
  function emit(race, type, c, extra) {
    const e = { type, car: c ? c.id : -1, x: c ? c.x : 0, y: c ? c.y : 0, z: c ? c.z : 0 };
    if (extra) Object.assign(e, extra);
    race.events.push(e);
  }

  // lethal=false for continuous rail grinding: only real impacts destroy an empty machine
  function damage(race, c, amt, lethal) {
    if (amt <= 0 || c.retired || c.finished) return;
    const wasEmpty = c.energy <= 0;
    c.energy = Math.max(0, c.energy - amt);
    if (amt > 1.5) c.hitFlash = 0.3;
    if (wasEmpty && lethal !== false && amt > 0.12) destroy(race, c, 'crash');
  }

  function destroy(race, c, reason) {
    if (c.retired || c.finished) return;
    c.retired = reason;
    c.retireT = race.t;
    c.retireDist = c.raceDist;
    c.boomT = 0;
    c.boostT = c.dashT = 0;
    emit(race, reason === 'courseout' ? 'fall' : 'explode', c);
    if (c.isPlayer) emit(race, 'playerOut', c, { reason });
  }

  function retire(race, c, reason) {
    // retire without exploding (rank out)
    if (c.retired || c.finished) return;
    c.retired = reason;
    c.retireT = race.t;
    c.retireDist = c.raceDist;
    if (c.isPlayer) emit(race, 'playerOut', c, { reason });
  }

  function carPhysics(race, c, dt) {
    const m = c.m, inp = c.input;
    const air = c.z > 0.01;
    // steering (keyboard ramp)
    const st = clamp(inp.steer, -1, 1);
    const rate = 7.5;
    c.steer += clamp(st - c.steer, -rate * dt, rate * dt);
    c.lean = inp.lean;
    // boost trigger
    if (inp.boost && !c.prevBoost && c.boostStock > 0 && c.boostT <= 0 && race.phase === 'run' && !c.retired) {
      c.boostStock--;
      c.boostT = m.boostTime;
      emit(race, 'boost', c);
    }
    c.prevBoost = inp.boost;
    const vmaxBase = m.vmax * c.vmul;
    let vmax = vmaxBase, accel = m.accel * c.amul;
    if (c.boostT > 0) { vmax *= m.boostMul; accel *= 2.6; c.boostT -= dt; }
    if (c.dashT > 0) { vmax = Math.max(vmax, vmaxBase * 1.24); accel *= 3; c.dashT -= dt; }
    if (c.onRough && !air) vmax = Math.min(vmax, vmaxBase * 0.52);
    let fx = Math.cos(c.th), fy = Math.sin(c.th);
    let vf = c.vx * fx + c.vy * fy;
    const r = clamp(vf / vmaxBase, 0, 1);
    let turn = m.turn * (1 - 0.32 * r);
    const leanIn = c.lean !== 0 && Math.sign(c.lean) === Math.sign(c.steer) && Math.abs(c.steer) > 0.2;
    if (leanIn) turn *= 1.32;
    if (air) turn *= 0.45;
    c.th = wrapA(c.th + c.steer * turn * dt);
    fx = Math.cos(c.th); fy = Math.sin(c.th);
    vf = c.vx * fx + c.vy * fy;
    let vl = -c.vx * fy + c.vy * fx;
    if (!air) {
      if (inp.throttle) {
        if (vf < 0) vf += accel * 1.6 * dt;
        else if (vf < vmax) vf = Math.min(vmax, vf + accel * Math.pow(1 - vf / vmax, 0.6) * dt);
      } else if (!inp.brake) {
        const dec = (16 + 0.1 * Math.abs(vf)) * dt;
        vf = vf > 0 ? Math.max(0, vf - dec) : Math.min(0, vf + dec);
      }
      if (vf > vmax) vf = Math.max(vmax, vf - ((vf - vmax) * 1.5 + 25) * dt);
      if (inp.brake) {
        if (vf > 0) vf = Math.max(0, vf - m.brake * dt);
        else if (!inp.throttle) vf = Math.max(-45, vf - 70 * dt);
      }
    } else {
      vf -= 3 * dt * Math.sign(vf);
    }
    let grip = m.grip;
    if (c.onIce && !air) grip *= 0.22;
    if (leanIn) grip *= 0.72;
    if (air) grip *= 0.04;
    vl *= Math.exp(-grip * dt);
    if (c.lean && !air) vl += c.lean * 150 * dt;
    c.vx = fx * vf - fy * vl;
    c.vy = fy * vf + fx * vl;
    // wind
    if (c.wind && !c.retired) {
      const g = 0.6 + 0.4 * Math.sin(race.t * 1.9 + c.id * 0.7) * Math.sin(race.t * 0.73);
      const wf = c.wind * g * (air ? 1.4 : 1) / m.mass;
      c.vx += c.nx * wf * dt;
      c.vy += c.ny * wf * dt;
    }
    // vertical
    if (air || c.vz > 0) {
      c.vz -= GRAVITY * dt;
      c.z += c.vz * dt;
      c.airT += dt;
      if (c.z <= 0) {
        const impact = -c.vz;
        c.z = 0;
        c.vz = impact > 90 ? impact * 0.22 : 0;
        if (impact > 60) emit(race, 'land', c, { power: clamp(impact / 200, 0, 1) });
        c.airT = 0;
        c.landed = true;
      }
    }
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.vf = vf;
    c.speed = Math.hypot(c.vx, c.vy);
    if (c.speed > c.stats.maxSpeed) c.stats.maxSpeed = c.speed;
    c.bank += (c.steer * (air ? 0.5 : 1) - c.bank) * Math.min(1, dt * 8);
    if (c.hitFlash > 0) c.hitFlash -= dt;
  }

  const LOC = {};
  function trackInteract(race, c, dt) {
    const T = race.track;
    locate(T, c.x, c.y, c.seg, LOC);
    const prevS = c.s;
    c.seg = LOC.i; c.s = LOC.s; c.d = LOC.d; c.hw = LOC.hw; c.nx = LOC.nx; c.ny = LOC.ny;
    let ds = c.s - prevS;
    if (ds > T.L / 2) ds -= T.L;
    else if (ds < -T.L / 2) ds += T.L;
    c.raceDist += ds;
    // landing outside the track
    if (c.landed) {
      c.landed = false;
      if (Math.abs(c.d) > c.hw + 4) { destroy(race, c, 'courseout'); return; }
    }
    // flew over the guard rail: falling outside it is a course out
    const beyond = Math.abs(c.d) > c.hw + RAIL_W + CAR_R; // whole machine past the rail band
    if (c.z >= 7) c.overRail = beyond;
    else if (c.overRail) {
      c.overRail = false;
      if (beyond && !c.finished) { destroy(race, c, 'courseout'); return; }
    }
    // guard rails
    const lim = c.hw - CAR_R;
    c.scraping = false;
    if (Math.abs(c.d) > lim && c.z < 7) {
      const sg = c.d > 0 ? 1 : -1;
      const nx = c.nx * sg, ny = c.ny * sg;
      const over = Math.abs(c.d) - lim;
      c.x -= nx * over; c.y -= ny * over;
      c.d -= sg * over;
      const vn = c.vx * nx + c.vy * ny;
      if (vn > 0) {
        c.vx -= nx * vn * 1.45; c.vy -= ny * vn * 1.45;
        const fr = Math.max(0, 1 - 1.2 * dt);
        c.vx *= fr; c.vy *= fr;
        if (vn > 18) {
          damage(race, c, (vn - 12) * 0.075 * c.m.body);
          c.stats.wallHits++;
          emit(race, 'wallHit', c, { power: clamp(vn / 180, 0, 1), side: sg });
        }
      }
      c.scraping = true;
      c.scrapeT = 0.12;
      const sp = Math.hypot(c.vx, c.vy);
      damage(race, c, 5 * c.m.body * dt * clamp(sp / 150, 0.2, 2), false);
      c.sparkT -= dt;
      if (c.sparkT <= 0 && sp > 40) { c.sparkT = 0.035; emit(race, 'spark', c, { side: sg, x: c.x + nx * CAR_R, y: c.y + ny * CAR_R }); }
      if (c.retired) return;
    }
    if (c.scrapeT > 0) c.scrapeT -= dt;
    // surfaces
    c.onPit = c.onRough = c.onIce = false;
    c.wind = 0;
    const ground = c.z < 1;
    const df = c.d / c.hw;
    for (const z of T.zones) {
      if (!inS(T, c.s, z.s0, z.s1)) continue;
      if (z.type === 'wind') { c.wind = z.force; continue; }
      if (!ground || df < z.d0 - 0.05 || df > z.d1 + 0.05) continue;
      if (z.type === 'pit') c.onPit = true;
      else if (z.type === 'rough') c.onRough = true;
      else if (z.type === 'ice') c.onIce = true;
    }
    if (c.onPit && !c.retired && race.phase === 'run') {
      const before = c.energy;
      c.energy = Math.min(ENERGY_MAX, c.energy + PIT_RATE * dt);
      if (before < ENERGY_MAX && c.energy >= ENERGY_MAX) emit(race, 'pitFull', c);
    }
    // plates
    if (c.plateCD > 0) c.plateCD -= dt;
    if (ground) {
      for (const p of T.dash) {
        if (Math.abs(sdiff(T, c.s, p.s)) < p.len / 2 + 2 && Math.abs(c.d - p.d) < p.wid / 2 + 3) {
          if (c.plateId !== p.id || c.plateCD <= 0) {
            c.plateId = p.id; c.plateCD = 0.5;
            const fx = Math.cos(c.th), fy = Math.sin(c.th);
            const vf = c.vx * fx + c.vy * fy;
            const target = c.m.vmax * c.vmul * 1.18;
            if (vf < target) { c.vx += fx * (target - vf); c.vy += fy * (target - vf); }
            c.dashT = 0.9;
            emit(race, 'dash', c);
          }
        }
      }
      for (const p of T.jump) {
        if (Math.abs(sdiff(T, c.s, p.s)) < p.len / 2 + 2 && Math.abs(c.d - p.d) < p.wid / 2 + 2) {
          if (c.plateId !== p.id || c.plateCD <= 0) {
            c.plateId = p.id; c.plateCD = 0.8;
            const sp = Math.max(60, c.speed);
            c.vz = 45 + sp * 0.17;
            c.z = 0.05;
            emit(race, 'jump', c);
          }
        }
      }
    }
    // mines
    for (const mn of race.mines) {
      if (!mn.active || c.z > 6) continue;
      const dx = c.x - mn.x, dy = c.y - mn.y;
      if (dx * dx + dy * dy < (CAR_R + 5) * (CAR_R + 5)) {
        mn.active = false;
        mn.respawn = 9;
        const l = Math.hypot(dx, dy) || 1;
        c.vx = c.vx * 0.55 + (dx / l) * 90;
        c.vy = c.vy * 0.55 + (dy / l) * 90;
        c.vz = 75; c.z = 0.05;
        c.th = wrapA(c.th + (race.rand() - 0.5) * 0.9);
        emit(race, 'mine', c, { x: mn.x, y: mn.y });
        damage(race, c, 7 * c.m.body);
        if (c.retired) return;
      }
    }
    // wrong way detector
    const along = c.vx * T.tx[c.seg] + c.vy * T.ty[c.seg];
    if (along < -30) c.wrongT += dt;
    else c.wrongT = Math.max(0, c.wrongT - dt * 2);
  }

  function collideCars(race) {
    const cars = race.cars;
    const R = CAR_R * 2;
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.retired) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.retired) continue;
        if (Math.abs(a.z - b.z) > 6) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        const ma = a.m.mass, mb = b.m.mass;
        const over = R - d;
        a.x -= nx * over * (mb / (ma + mb)); a.y -= ny * over * (mb / (ma + mb));
        b.x += nx * over * (ma / (ma + mb)); b.y += ny * over * (ma / (ma + mb));
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          const jimp = (-(1 + 0.6) * rv) / (1 / ma + 1 / mb);
          a.vx -= (jimp / ma) * nx; a.vy -= (jimp / ma) * ny;
          b.vx += (jimp / mb) * nx; b.vy += (jimp / mb) * ny;
          const hit = -rv;
          if (hit > 12) {
            // AI-vs-AI bumps hurt less so the pack does not wipe itself out
            const k = a.isPlayer || b.isPlayer ? 0.045 : 0.03;
            damage(race, a, (hit - 10) * k * a.m.body);
            damage(race, b, (hit - 10) * k * b.m.body);
            a.stats.carHits++; b.stats.carHits++;
            emit(race, 'carHit', a, { other: b.id, power: clamp(hit / 160, 0, 1), x: a.x + nx * CAR_R, y: a.y + ny * CAR_R });
          }
        }
      }
    }
  }

  function lapLogic(race, c) {
    const T = race.track;
    if (c.raceDist > c.maxRD) c.maxRD = c.raceDist;
    const done = Math.max(0, Math.floor(c.maxRD / T.L));
    while (c.lapsDone < done && !c.finished && !c.retired) {
      c.lapsDone++;
      // interpolate the exact line-crossing time inside this tick
      const over = Math.max(0, c.maxRD - c.lapsDone * T.L);
      const along = c.vx * T.tx[c.seg] + c.vy * T.ty[c.seg];
      const tc = Math.max(c.lapStartT, race.t - Math.min(DT, over / Math.max(1, along * PACE)));
      c.lapTimes.push(tc - c.lapStartT);
      c.lapStartT = tc;
      if (c.lapsDone >= race.laps) {
        c.finished = true;
        c.finishT = tc;
        race.newFinish.push(c); // places are handed out after every car moved this tick
        break;
      }
      if (c.boostStock < MAX_BOOSTS) {
        c.boostStock++;
        if (c.isPlayer) emit(race, 'boostReady', c);
      }
      emit(race, 'lap', c, { lap: c.lapsDone, time: c.lapTimes[c.lapTimes.length - 1] });
      if (c.isPlayer && race.rankOut && c.lapsDone <= RANK_LIMITS.length) race.rankCheck = c.lapsDone;
    }
  }

  function updateRanks(race) {
    const arr = race.cars.slice();
    arr.sort((a, b) => {
      if (a.finished || b.finished) {
        if (a.finished && b.finished) return a.place - b.place;
        return a.finished ? -1 : 1;
      }
      if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;
      if (a.retired && b.retired) return b.retireDist - a.retireDist;
      return b.raceDist - a.raceDist;
    });
    for (let i = 0; i < arr.length; i++) arr[i].rank = i + 1;
    race.order = arr;
  }

  // ghost frame j is the player's pose at race time j/30 s
  function recordGhost(race) {
    const p = race.player;
    race.ghostRec.push(Math.round(p.x * 8), Math.round(p.y * 8), Math.round(wrapA(p.th) * 10000), Math.round(p.z * 8));
  }

  // one fixed simulation tick
  function step(race, dt) {
    dt = dt || DT;
    race.tick++;
    if (race.phase === 'countdown') {
      race.count -= dt;
      for (const c of race.cars) {
        // revving: remember when the throttle went down for the rocket start
        if (c.isPlayer && race.opts.mode !== 'attract') {
          if (c.input.throttle) { if (c.throttleSince < 0) c.throttleSince = race.count; }
          else c.throttleSince = -1;
        }
        c.bank *= 0.9;
      }
      if (race.count <= 0) {
        race.phase = 'run';
        race.t = 0;
        for (const c of race.cars) {
          c.lapStartT = 0;
          if (c.isPlayer && c.throttleSince >= 0 && c.throttleSince < 0.45) {
            c.dashT = 0.8; c.rocket = true;
            emit(race, 'rocket', c);
          }
          if (c.ai && !c.isPlayer && race.rand() < 0.35) c.dashT = 0.3;
        }
        race.goTick = race.tick;
        if (race.player && race.opts.mode === 'ta') recordGhost(race);
        emit(race, 'go', null);
      }
      return;
    }
    race.t += dt; // real seconds (lap times, ghost, countdown)
    const dp = dt * PACE; // simulated seconds
    for (const c of race.cars) {
      if (c.retired) {
        if (c.boomT >= 0) c.boomT += dt;
        // drift to a halt
        c.vx *= Math.exp(-dp * 2.5); c.vy *= Math.exp(-dp * 2.5);
        c.x += c.vx * dp; c.y += c.vy * dp;
        if (c.retired === 'courseout') { c.z -= 60 * dt; }
        continue;
      }
      if (c.ai && (!c.isPlayer || c.finished || race.opts.mode === 'attract' || race.autopilot)) aiControl(race, c, dp);
      carPhysics(race, c, dp);
    }
    collideCars(race);
    for (const c of race.cars) {
      if (c.retired) continue;
      trackInteract(race, c, dp);
      if (!c.retired) lapLogic(race, c);
    }
    if (race.newFinish.length) {
      race.newFinish.sort((a, b) => a.finishT - b.finishT);
      for (const c of race.newFinish) {
        c.place = ++race.finishCount;
        c.rank = c.place;
        emit(race, 'finish', c, { place: c.place });
        if (c.isPlayer && race.opts.mode !== 'attract') {
          // autopilot takes over after the goal
          setupAI(race, c);
          c.ai.skill = 0.9;
          c.vmul = 0.9;
          c.energy = ENERGY_MAX;
        }
      }
      race.newFinish.length = 0;
    }
    if (race.rankCheck) {
      // rank-out uses ranks that include this tick's movement of every car
      updateRanks(race);
      const p = race.player;
      if (p && !p.retired && !p.finished && p.rank > RANK_LIMITS[race.rankCheck - 1]) {
        retire(race, p, 'rankout');
        emit(race, 'rankOut', p);
      }
      race.rankCheck = 0;
    }
    for (const mn of race.mines) {
      if (!mn.active) { mn.respawn -= dp; if (mn.respawn <= 0) mn.active = true; }
    }
    if ((race.tick & 3) === 0) updateRanks(race);
    // ghost recording (30 Hz)
    if (race.player && race.opts.mode === 'ta' && !race.player.finished && ((race.tick - race.goTick) & 3) === 0) recordGhost(race);
    // race over? (everyone done, or long after the player)
    const active = race.cars.filter((c) => !c.finished && !c.retired);
    if (race.doneT < 0 && (active.length === 0 || (race.player && (race.player.finished || race.player.retired) && race.t - (race.player.finishT || race.player.retireT) > 30))) {
      race.doneT = race.t;
      emit(race, 'raceDone', null);
    }
  }

  // final classification (positions + times) for the results screen
  function classify(race) {
    updateRanks(race);
    return race.order.map((c, i) => ({
      id: c.id, name: c.name, key: c.key, design: c.design, isPlayer: c.isPlayer, isHero: c.isHero,
      pos: i + 1, time: c.finished ? c.finishT : null, retired: c.retired, lapTimes: c.lapTimes.slice(),
      bestLap: c.lapTimes.length ? Math.min(...c.lapTimes) : null,
    }));
  }

  function fmtTime(t) {
    if (t === null || t === undefined || !isFinite(t)) return "-'--\"--";
    const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
    return `${m}'${s < 10 ? '0' : ''}${s}"${cs < 10 ? '0' : ''}${cs}`;
  }

  // ghost playback: data = Int16-ish flat array at 30 Hz
  function ghostAt(data, t) {
    if (!data || data.length < 8) return null;
    const f = t * 30;
    const i = Math.floor(f), frac = f - i;
    const nFrames = data.length / 4;
    if (i >= nFrames - 1) return null;
    const a = i * 4, b = a + 4;
    let th0 = data[a + 2] / 10000, th1 = data[b + 2] / 10000;
    return {
      x: lerp(data[a], data[b], frac) / 8,
      y: lerp(data[a + 1], data[b + 1], frac) / 8,
      th: th0 + wrapA(th1 - th0) * frac,
      z: lerp(data[a + 3], data[b + 3], frac) / 8,
    };
  }

  return {
    TAU, clamp, lerp, wrapA, rng,
    MAP, STEP, RAIL_W, CAR_R, LAPS, RANK_LIMITS, KMH, DT, PACE, ENERGY_MAX, MAX_BOOSTS,
    MACHINES, HERO_KEYS, DRONE, DIFFICULTY, COURSES, CUPS, POINTS, courseById,
    buildTrack, wrapS, sdiff, inS, posAt, locate,
    createRace, step, updateRanks, classify, setupAI, fmtTime, ghostAt, cornerSpeed,
  };
})();
