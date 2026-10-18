// ZERO-G GP — CARS module
// Pre-rendered pixel-art sprite sheets of the hover machines, produced by a small software
// rasterizer (triangle meshes + z-buffer + per-pixel quantised shading with smoothing groups +
// crease/despeckle/outline passes). No DOM.
//
// Conventions (see dev/CONTRACT.md):
//   model space  +X forward (nose), +Y right, +Z up, origin = ground point under the car centre.
//   view         orthographic, pitched down by pitchDeg. Yaw index i = heading relative to the
//                camera of i*360/yawSteps degrees, clockwise seen from above:
//                i=0 tail toward camera, i=yawSteps/4 nose screen-right, i=yawSteps/2 nose toward
//                camera, i=3*yawSteps/4 nose screen-left.
//   bank         roll bankDeg[b] degrees, positive = right side dips.
//                (Physically, with the nose screen-right the camera faces the car's RIGHT flank; the
//                machines are left/right symmetric so this is indistinguishable from the left one.)
//   anchor       the ground point under the car centre projects exactly onto the top-left corner
//                of pixel (anchorX, anchorY): draw a frame at (sx - anchorX, sy - anchorY).
//   exhaust      [yaw][bank] -> [{x, y, visible, r, dx, dy}] in frame px, one entry per nozzle in a
//                fixed order (left side first). Extras beyond the contract: r = nozzle radius px,
//                (dx, dy) = screen offset of a point 1 world unit behind the nozzle (flame direction).
const CARS = (() => {
  'use strict';

  const DEG = Math.PI / 180;

  // ------------------------------------------------------------------------------------------
  // Materials. A rendered pixel stores code = mat * 8 + shade.
  //   shade 0..3  diffuse levels (darkest .. light)
  //   shade 4     specular highlight (glossy materials)
  //   shade 5     crease line (dark internal outline drawn where a part overlaps another)
  // code 0 = transparent, OUTLINE = silhouette outline.
  // ------------------------------------------------------------------------------------------
  const BODY = 1, BODY2 = 2, TRIM = 3, CANOPY = 4, METAL = 5, NOZZLE = 6, GLOW = 7, DARK = 8;
  const MAT_KEYS = [null, 'body', 'body2', 'trim', 'canopy', 'metal', 'nozzle', 'glow', 'dark'];
  const OUTLINE = 255;
  const CREASE_SHADE = 5;

  // Per material: specular threshold on N.H (2 = never), and emissive flag (constant shade 3).
  const MAT_SPEC = [2, 0.992, 0.992, 0.995, 0.955, 0.985, 2, 2, 2];
  // Far (small) sheets: only the canopy keeps its glint — body glints become random bright flecks.
  const MAT_SPEC_FAR = [2, 2, 2, 2, 0.955, 2, 2, 2, 2];
  const MAT_EMISSIVE = [0, 0, 0, 0, 0, 0, 0, 1, 0];

  // ------------------------------------------------------------------------------------------
  // Designs (visual only). Colours are CSS hex strings; `main`/`accent` are handy for HUD dots.
  // ------------------------------------------------------------------------------------------
  const DRONE_COMMON = {
    body2: '#3c4152', metal: '#6c7488', canopy: '#2c4a78', nozzle: '#1a1622',
    glow: '#ff4040', dark: '#262a36', outline: '#0b0b16',
  };
  function drone(name, body, trim) {
    return { name, shape: 'drone', colors: Object.assign({ main: body, accent: trim, body, trim }, DRONE_COMMON) };
  }
  const DESIGNS = {
    comet: {
      name: 'BLUE COMET', shape: 'comet',
      colors: {
        main: '#2a5ce0', accent: '#ffcc22',
        body: '#2a5ce0', body2: '#e8eef8', trim: '#ffc81e', canopy: '#2cc4f0',
        metal: '#8890a8', nozzle: '#1a1626', glow: '#ff3c50', dark: '#283050', outline: '#0a0a1c',
      },
    },
    lynx: {
      name: 'GOLD LYNX', shape: 'lynx',
      colors: {
        main: '#f4b414', accent: '#24222c',
        body: '#f4b414', body2: '#2a2733', trim: '#fff2b8', canopy: '#36dcb4',
        metal: '#8c8478', nozzle: '#1a1622', glow: '#ff5030', dark: '#2a2630', outline: '#0e0a0a',
      },
    },
    bison: {
      name: 'IRON BISON', shape: 'bison',
      colors: {
        main: '#347a40', accent: '#6c7684',
        body: '#347a40', body2: '#6c7684', trim: '#f0a81e', canopy: '#f08420',
        metal: '#50585f', nozzle: '#16161a', glow: '#ff4a2a', dark: '#262c2e', outline: '#080c0a',
      },
    },
    hornet: {
      name: 'RED HORNET', shape: 'hornet',
      colors: {
        main: '#dc2232', accent: '#ff6aa8',
        body: '#dc2232', body2: '#ff6aa8', trim: '#f6f2f6', canopy: '#7c54e0',
        metal: '#8a8090', nozzle: '#1a1420', glow: '#ffd040', dark: '#3a2030', outline: '#120610',
      },
    },
    drone0: drone('DRONE PURPLE', '#8a40d8', '#d6a8ff'),
    drone1: drone('DRONE ORANGE', '#f07a18', '#ffd08a'),
    drone2: drone('DRONE TEAL', '#14aa9c', '#9cf2e4'),
    drone3: drone('DRONE GREY', '#8a90a2', '#e2e6ee'),
    drone4: drone('DRONE PINK', '#ec5aa8', '#ffc4e2'),
    drone5: drone('DRONE LIME', '#84cc1e', '#e2ff9a'),
  };

  const DEFAULT_OPTS = { pxPerUnit: 4, pitchDeg: 28, yawSteps: 32, bankDeg: [-18, 0, 18] };

  // ------------------------------------------------------------------------------------------
  // Colour helpers: hue-shifted shade ramps (shadows lean blue/violet, lights lean warm).
  // ------------------------------------------------------------------------------------------
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s <= 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  }
  function hueToward(h, target, amount) {
    let d = ((target - h + 540) % 360) - 180;
    if (Math.abs(d) < amount) return target;
    return h + Math.sign(d) * amount;
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // -> 6 colours: [darkest, dark, base, light, highlight, crease]
  function shadeRamp(hex) {
    const [r, g, b] = hexToRgb(hex);
    let [h, s, l] = rgbToHsl(r, g, b);
    const grey = s < 0.08;
    const hs = (target, amt, ss) => (grey ? [230, Math.min(0.18, s + ss)] : [hueToward(h, target, amt), clamp01(s * (1 + ss))]);
    const out = [];
    let [h0, s0] = hs(245, 22, 0.15); out.push(hslToRgb(h0, s0, l * 0.40));
    let [h1, s1] = hs(245, 10, 0.08); out.push(hslToRgb(h1, s1, l * 0.66));
    out.push([r, g, b]);
    let [h3, s3] = grey ? [h, s] : [hueToward(h, 55, 12), clamp01(s * 1.02)];
    out.push(hslToRgb(h3, s3, l + (1 - l) * 0.30));
    out.push(hslToRgb(h3, s3 * 0.5, l + (1 - l) * 0.80));
    let [h5, s5] = hs(250, 28, 0.2); out.push(hslToRgb(h5, s5, l * 0.24));
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Mesh builder
  // ------------------------------------------------------------------------------------------
  // Face normals are per FACE, not per triangle: both triangles of a loft quad and every
  // triangle of a cap/plate fan share one model-space normal (diagonal cross product / Newell),
  // so non-planar quads don't split into two differently-shaded halves. getMesh() then derives
  // smoothed corner normals (smoothing groups, SMOOTH_DEG crease angle) that the rasterizer
  // interpolates per pixel: gentle curvature shades as clean bands instead of facet patchwork,
  // while chines, octagonal pods, wing edges and caps stay crisp.
  const SMOOTH_DEG = 40;
  const SMOOTH_COS = Math.cos(SMOOTH_DEG * Math.PI / 180);
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function unit3(n) {
    const l = Math.hypot(n[0], n[1], n[2]);
    return l > 1e-9 ? [n[0] / l, n[1] / l, n[2] / l] : null;
  }
  function newellNormal(pts) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    return unit3([nx, ny, nz]);
  }

  function MeshBuilder() {
    this.v = [];        // flat xyz
    this.t = [];        // a, b, c, mat, part, paint
    this.n = [];        // per-triangle model-space shading normal (NaN = use the triangle's own)
    this.parts = 0;
    this.nozzles = [];  // {x, y, z, r}
    this.paints = [null];
    this.curPaint = 0;
  }
  MeshBuilder.prototype.vert = function (p) { this.v.push(p[0], p[1], p[2]); return this.v.length / 3 - 1; };
  MeshBuilder.prototype.newPart = function () { return ++this.parts; };
  MeshBuilder.prototype.tri = function (a, b, c, mat, part, n) {
    if (!mat) return;
    this.t.push(a, b, c, mat, part, this.curPaint);
    if (n) this.n.push(n[0], n[1], n[2]); else this.n.push(NaN, NaN, NaN);
  };
  // Livery: fn(X, Y, Z, mat) -> mat, evaluated per pixel in model space for following parts.
  MeshBuilder.prototype.paint = function (fn) {
    if (!fn) { this.curPaint = 0; return; }
    this.paints.push(fn);
    this.curPaint = this.paints.length - 1;
  };
  MeshBuilder.prototype.fan = function (sec, ids, mat, part) {
    let cx = 0, cy = 0, cz = 0;
    for (const p of sec) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const ci = this.vert([cx / sec.length, cy / sec.length, cz / sec.length]);
    const n = newellNormal(sec);
    for (let j = 0; j < ids.length; j++) this.tri(ci, ids[j], ids[(j + 1) % ids.length], mat, part, n);
  };
  // Connect cross-sections (arrays of [x,y,z], same length, closed loops) with quads.
  // matFn(k, j) or constant: material of strip j in segment k (0 = skip).
  MeshBuilder.prototype.loft = function (secs, matFn, cap0, cap1, part) {
    if (!part) part = this.newPart();
    const n = secs[0].length;
    const ids = secs.map((sec) => sec.map((p) => this.vert(p)));
    const fn = typeof matFn === 'function' ? matFn : () => matFn;
    for (let k = 0; k < secs.length - 1; k++) {
      for (let j = 0; j < n; j++) {
        const mat = fn(k, j);
        if (!mat) continue;
        const j2 = (j + 1) % n;
        const a = ids[k][j], b = ids[k][j2], c = ids[k + 1][j2], d = ids[k + 1][j];
        const qn = unit3(cross3(sub3(secs[k + 1][j2], secs[k][j]), sub3(secs[k + 1][j], secs[k][j2])));
        this.tri(a, b, c, mat, part, qn);
        this.tri(a, c, d, mat, part, qn);
      }
    }
    if (cap0) this.fan(secs[0], ids[0], cap0, part);
    if (cap1) this.fan(secs[secs.length - 1], ids[secs.length - 1], cap1, part);
    return part;
  };
  // Thin extruded polygon (fins, wings, struts): pts = one face, off = extrusion vector.
  MeshBuilder.prototype.plate = function (pts, off, faceMat, edgeMat, part) {
    const back = pts.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
    return this.loft([pts, back], edgeMat === undefined ? faceMat : edgeMat, faceMat, faceMat, part);
  };
  MeshBuilder.prototype.box = function (x0, x1, y0, y1, z0, z1, mat, part) {
    const s0 = [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]];
    const s1 = s0.map((p) => [x1, p[1], p[2]]);
    return this.loft([s0, s1], mat, mat, mat, part);
  };

  // Hull cross-section (7 points): bottom pair, chines, top shoulders and a central ridge.
  // key = [x, w(chine half-width), wb(bottom), wt(top), zb, zc, zt, zr]
  // strips j: 0 bottom, 1 R lower, 2 R upper, 3 R top, 4 L top, 5 L upper, 6 L lower
  const HULL_KIND = [0, 1, 2, 3, 3, 2, 1];
  const HULL_SIDE = [0, 1, 1, 1, -1, -1, -1];
  function hullSec(k, yc) {
    const [x, w, wb, wt, zb, zc, zt, zr] = k;
    return [[x, yc - wb, zb], [x, yc + wb, zb], [x, yc + w, zc], [x, yc + wt, zt], [x, yc, zr], [x, yc - wt, zt], [x, yc - w, zc]];
  }
  // mats(k, kind, side) -> material
  function hull(m, keys, yc, mats, cap0, cap1, part) {
    const secs = keys.map((k) => hullSec(k, yc));
    return m.loft(secs, (k, j) => mats(k, HULL_KIND[j], HULL_SIDE[j]), cap0, cap1, part);
  }
  // Octagonal ring around the X axis (flat faces on top/bottom/sides).
  function ring(x, yc, zc, ry, rz, n) {
    n = n || 8;
    const out = [];
    for (let j = 0; j < n; j++) {
      const a = Math.PI / n + (j * 2 * Math.PI) / n;
      out.push([x, yc + ry * Math.cos(a), zc + rz * Math.sin(a)]);
    }
    return out;
  }
  // Pod along X: keys = [[x, ry, rz, dz?]]; mats(k, j, angleMid)
  function pod(m, yc, zc, keys, mats, cap0, cap1, n, part) {
    n = n || 8;
    const secs = keys.map((k) => ring(k[0], yc, zc + (k[3] || 0), k[1], k[2], n));
    const fn = typeof mats === 'function' ? (k, j) => mats(k, j, Math.PI / n + ((j + 0.5) * 2 * Math.PI) / n) : mats;
    return m.loft(secs, fn, cap0, cap1, part);
  }
  // Engine nozzle: shell from x back to x-len, bright rim, recessed dark throat.
  function nozzle(m, x, y, z, r, len, shellMat, rimMat) {
    const part = m.newPart();
    const xe = x - len;
    m.loft([ring(x, y, z, r * 0.92, r * 0.92), ring(xe, y, z, r, r)], shellMat, 0, 0, part);
    m.loft([ring(xe, y, z, r, r), ring(xe, y, z, r * 0.66, r * 0.66)], rimMat, 0, 0, part);
    m.loft([ring(xe, y, z, r * 0.66, r * 0.66), ring(xe + 0.45, y, z, r * 0.58, r * 0.58)], NOZZLE, 0, NOZZLE, part);
    m.nozzles.push({ x: xe, y, z, r });
    return part;
  }
  const mirrorPts = (pts) => pts.map((p) => [p[0], -p[1], p[2]]);
  // Canopy bubble along the spine. keys = [x, halfWidth, zBase, zTop]
  function canopy(m, keys, yc, mat) {
    yc = yc || 0;
    const secs = keys.map(([x, w, zb, zt]) => {
      const h = zt - zb;
      return [[x, yc - w, zb], [x, yc - w * 0.78, zb + h * 0.6], [x, yc - w * 0.36, zt], [x, yc + w * 0.36, zt], [x, yc + w * 0.78, zb + h * 0.6], [x, yc + w, zb]];
    });
    return m.loft(secs, (k, j) => (j === 5 ? 0 : mat || CANOPY), 0, mat || CANOPY);
  }
  // Vertical fin centred on plane y=yc: pts = [[x, z], ...] (star-shaped polygon), thickness t.
  function fin(m, yc, t, pts, faceMat, edgeMat) {
    return m.plate(pts.map(([x, z]) => [x, yc + t / 2, z]), [0, -t, 0], faceMat, edgeMat);
  }
  // Stripe helper: true when lo < v < hi, widened to at least ~1 sprite pixel at the current scale.
  let minStripe = 0.26;
  function band(v, lo, hi) {
    const c = (lo + hi) / 2, h = Math.max((hi - lo) / 2, minStripe / 2);
    return v > c - h && v < c + h;
  }
  const hullMatsStd = (k, kind) => (kind === 0 ? DARK : kind === 1 ? BODY2 : BODY);

  // ------------------------------------------------------------------------------------------
  // Shapes. Length ~22 (x -11..11), width ~13 (y -6.5..6.5), hull bottom z=1.5, top ~5-6.
  // Liveries are painted per pixel in model space (m.paint) so stripes stay crisp.
  // ------------------------------------------------------------------------------------------
  const SHAPES = {};

  // BLUE COMET — sleek arrowhead, swept barbed wings, twin engines, single tall tail fin.
  SHAPES.comet = function () {
    const m = new MeshBuilder();
    m.paint((X, Y, Z, mat) => {
      if (mat !== BODY && mat !== BODY2) return mat;
      const ay = Math.abs(Y);
      if (Z > 2.75) {
        if (X > 9.0) return BODY2;                          // white nose tip
        const c = 7.7 - 1.15 * ay;                          // yellow chevron
        if (band(X, c - 0.8, c)) return TRIM;
        if (X < -2.2 && ay < 0.5) return BODY2;             // white spine stripe
      }
      if (band(Z, 2.24, 2.6) && X < 8.6) return TRIM;        // chine pinstripe
      return mat;
    });
    hull(m, [
      [11.3, 0.15, 0.1, 0.1, 2.35, 2.5, 2.65, 2.7],
      [8.2, 1.7, 1.0, 0.85, 1.85, 2.45, 3.05, 3.3],
      [3.5, 2.8, 1.8, 1.45, 1.55, 2.5, 3.6, 3.95],
      [-3.0, 3.1, 2.1, 1.7, 1.5, 2.55, 3.85, 4.2],
      [-9.7, 2.9, 2.1, 1.6, 1.6, 2.6, 3.75, 4.0],
    ], 0, hullMatsStd, 0, METAL);
    m.paint(null);
    for (const s of [-1, 1]) m.box(-9.85, -9.65, s * 0.6, s * 1.5, 2.85, 3.3, GLOW);
    canopy(m, [[6.6, 0, 3.15, 3.2], [4.8, 0.85, 3.25, 4.25], [2.4, 1.25, 3.55, 4.85], [-0.2, 1.05, 3.8, 4.55], [-1.9, 0.4, 3.95, 4.1]]);
    // barbed delta wings: white with blue tips, yellow edges
    m.paint((X, Y, Z, mat) => (mat === BODY2 && Math.abs(Y) > 5.8 ? BODY : mat));
    for (const s of [-1, 1]) {
      const z0 = 2.75, z1 = 2.25;
      const top = [[4.8, 2.3, z0], [-6.8, 6.5, z1], [-10.4, 6.6, z1], [-8.6, 4.5, (z0 + z1) / 2], [-9.3, 2.3, z0]];
      m.plate(s > 0 ? top : mirrorPts(top), [0, 0, -0.45], BODY2, TRIM);
    }
    // engine nacelles: blue, white intake cone, yellow ring
    m.paint((X, Y, Z, mat) => {
      if (mat !== BODY) return mat;
      if (X > -2.3) return BODY2;
      if (band(X, -5.5, -4.7)) return TRIM;
      return mat;
    });
    for (const s of [-1, 1]) {
      pod(m, s * 3.65, 3.05, [[-0.6, 0.1, 0.1], [-2.8, 0.95, 0.85], [-5.0, 1.3, 1.2], [-7.4, 1.3, 1.2], [-9.3, 1.25, 1.15]],
        (k, j, a) => (Math.sin(a) < -0.5 ? DARK : BODY), 0, 0);
    }
    m.paint(null);
    for (const s of [-1, 1]) nozzle(m, -9.3, s * 3.65, 3.05, 1.2, 0.85, METAL, TRIM);
    // tail fin: blue, white band, yellow tip
    m.paint((X, Y, Z, mat) => (Z > 6.25 ? TRIM : band(Z, 5.2, 5.65) ? BODY2 : mat));
    fin(m, 0, 0.7, [[-4.4, 3.95], [-8.3, 6.95], [-10.6, 6.95], [-9.75, 3.8]], BODY, BODY);
    m.paint(null);
    m.pivotZ = 3.2;
    return m;
  };

  // GOLD LYNX — needle-nosed slim fuselage, twin outrigger pods on short arms.
  SHAPES.lynx = function () {
    const m = new MeshBuilder();
    m.paint((X, Y, Z, mat) => {
      if (mat !== BODY && mat !== BODY2) return mat;
      if (X > 7.4) return BODY2;                                   // black needle nose
      if (Z > 2.95 && Math.abs(Y) < 0.4 && (X > 4.2 || X < -3.2)) return BODY2;  // black spine stripe
      if (band(Z, 2.42, 2.78)) return TRIM;                         // cream chine stripe
      return mat;
    });
    hull(m, [
      [11.8, 0.1, 0.05, 0.05, 2.55, 2.6, 2.7, 2.72],
      [8.0, 0.95, 0.5, 0.5, 2.1, 2.5, 2.95, 3.1],
      [3.0, 1.8, 1.1, 1.0, 1.7, 2.6, 3.5, 3.8],
      [-3.0, 2.25, 1.4, 1.3, 1.6, 2.7, 3.9, 4.2],
      [-9.4, 1.9, 1.2, 1.05, 1.8, 2.8, 3.75, 3.95],
    ], 0, (k, kind) => (kind === 0 ? DARK : kind === 1 ? BODY2 : BODY), 0, METAL);
    m.paint(null);
    m.box(-9.6, -9.4, -0.7, 0.7, 2.95, 3.3, GLOW);
    canopy(m, [[4.6, 0, 3.3, 3.35], [3.0, 0.9, 3.35, 4.3], [0.6, 1.15, 3.6, 4.85], [-1.8, 0.9, 3.85, 4.45], [-3.2, 0.3, 4.0, 4.1]]);
    for (const s of [-1, 1]) {
      const yc = s * 5.0, zc = 2.85;
      m.paint((X, Y, Z, mat) => {
        if (mat !== BODY) return mat;
        if (X > 2.6) return BODY2;                         // black nose cone
        if (X > -0.2 && X < 0.9) return BODY2;              // black band
        if (band(X, -6.7, -6.1)) return TRIM;               // cream ring
        if (Z > zc + 0.7 && Math.abs(Y - yc) < 0.35 && X < -0.2) return TRIM;
        return mat;
      });
      pod(m, yc, zc, [[5.6, 0.05, 0.05], [3.4, 0.75, 0.7], [0.8, 1.2, 1.1], [-2.0, 1.25, 1.15], [-8.0, 1.25, 1.15], [-9.4, 1.12, 1.05]],
        (k, j, a) => (Math.sin(a) < -0.5 ? DARK : BODY), 0, 0);
      m.paint(null);
      nozzle(m, -9.4, yc, zc, 1.05, 0.8, METAL, METAL);
      // short arms (front + rear) joining pods to the fuselage
      const arm = (xa, xb, xc, xd) => {
        const t = [[xa, 1.6, 3.15], [xb, 4.3, 3.0], [xc, 4.3, 3.0], [xd, 1.6, 3.15]];
        m.plate(s > 0 ? t : mirrorPts(t), [0, 0, -0.5], BODY2, BODY2);
      };
      arm(-1.0, -2.2, -4.2, -4.6);
      arm(-6.6, -7.2, -8.6, -8.9);
      // small pod fins: gold with a black tip (all-black fins read as holes in the fuselage
      // in the side views, where the near pod's fin overlaps the hull)
      m.paint((X, Y, Z, mat) => (Z > 4.75 ? BODY2 : mat));
      fin(m, yc, 0.5, [[-5.0, 3.8], [-7.6, 5.3], [-9.0, 5.3], [-8.8, 3.8]], BODY, BODY);
      m.paint(null);
    }
    m.pivotZ = 3.0;
    return m;
  };

  // IRON BISON — wide, low, armoured; blunt nose, big side pods, four nozzles, rear spoiler.
  SHAPES.bison = function () {
    const m = new MeshBuilder();
    m.paint((X, Y, Z, mat) => {
      const ay = Math.abs(Y);
      if (mat === BODY && Z > 3.0) {
        if (X > 8.5 && X < 9.3) return TRIM;                                   // amber nose band
        if (ay < 1.0 && X < 1.6) return BODY2;                                 // gunmetal armour spine
        if (ay > 2.1 && X < 1.6 && X > -8.5 && (Math.floor((X + 20) / 3.1) & 1) && ay < 2.5) return DARK; // vents
      }
      return mat;
    });
    hull(m, [
      [10.8, 2.6, 2.2, 1.8, 1.9, 2.3, 2.75, 2.85],
      [9.4, 3.2, 2.7, 2.3, 1.6, 2.5, 3.3, 3.45],
      [4.0, 3.5, 2.9, 2.5, 1.5, 2.65, 4.3, 4.65],
      [-5.0, 3.5, 2.9, 2.5, 1.5, 2.7, 4.7, 5.05],
      [-10.3, 3.3, 2.7, 2.3, 1.6, 2.7, 4.45, 4.75],
    ], 0, (k, kind) => (kind === 0 ? DARK : kind === 1 ? BODY2 : BODY), METAL, METAL);
    m.paint(null);
    // slit visor
    canopy(m, [[7.2, 0.3, 3.8, 3.85], [6.3, 2.0, 3.92, 4.3], [4.7, 2.3, 4.15, 4.72], [3.3, 2.15, 4.4, 4.85], [2.6, 1.5, 4.55, 4.75]]);
    for (const s of [-1, 1]) {
      const yc = s * 5.05;
      m.paint((X, Y, Z, mat) => {
        if (mat === BODY && X > 6.2 && X < 7.2) return TRIM;          // amber band
        if ((mat === BODY || mat === BODY2) && minStripe < 0.4 && X > -3.4 && X < -3.0) return DARK;   // panel seam (near only)
        return mat;
      });
      hull(m, [
        [9.8, 0.8, 0.6, 0.5, 1.8, 2.1, 2.5, 2.55],
        [7.0, 1.7, 1.35, 1.1, 1.55, 2.4, 3.45, 3.55],
        [0.0, 1.85, 1.45, 1.2, 1.5, 2.5, 3.85, 3.95],
        [-9.4, 1.85, 1.45, 1.2, 1.5, 2.5, 3.85, 3.95],
        [-10.4, 1.7, 1.3, 1.1, 1.6, 2.5, 3.7, 3.8],
      ], yc, (k, kind) => (kind === 0 ? DARK : kind === 1 ? METAL : kind === 2 ? BODY2 : BODY), METAL, METAL);
      m.paint(null);
      nozzle(m, -10.4, yc, 2.9, 1.1, 0.8, METAL, TRIM);
      nozzle(m, -10.3, s * 1.75, 3.15, 1.15, 0.8, METAL, TRIM);
      m.box(-10.6, -10.4, yc + 0.35 * s, yc + 1.25 * s, 3.25, 3.55, GLOW);
      // spoiler struts
      fin(m, s * 2.7, 0.5, [[-7.4, 4.45], [-8.3, 5.5], [-9.7, 5.5], [-9.9, 4.3]], METAL, METAL);
    }
    // rear spoiler (green, amber edge)
    m.plate([[-7.9, -4.6, 5.75], [-7.9, 4.6, 5.75], [-9.9, 4.9, 5.55], [-9.9, -4.9, 5.55]], [0, 0, -0.45], BODY, TRIM);
    m.pivotZ = 3.0;
    return m;
  };

  // RED HORNET — long body, two forward mandible prongs, big raised rear wing, single nozzle.
  SHAPES.hornet = function () {
    const m = new MeshBuilder();
    m.paint((X, Y, Z, mat) => {
      if (mat !== BODY) return mat;
      const ay = Math.abs(Y);
      if (Z > 3.3 && ay < 0.5 && (X > 6.0 || X < -2.2)) return TRIM;      // white racing stripe
      if (band(Z, 2.6, 2.95)) return BODY2;                                // pink chine stripe
      return mat;
    });
    hull(m, [
      [9.0, 0.6, 0.35, 0.3, 2.45, 2.65, 2.9, 2.95],
      [5.5, 2.2, 1.5, 1.3, 1.8, 2.7, 3.6, 3.9],
      [-2.0, 2.9, 2.0, 1.8, 1.5, 2.8, 4.1, 4.45],
      [-8.4, 2.8, 2.0, 1.75, 1.6, 2.9, 4.2, 4.45],
      [-10.0, 2.4, 1.8, 1.55, 1.8, 2.9, 4.0, 4.15],
    ], 0, (k, kind) => (kind === 0 ? DARK : kind === 1 ? BODY2 : BODY), 0, METAL);
    m.paint(null);
    canopy(m, [[6.2, 0, 3.2, 3.25], [4.6, 0.95, 3.35, 4.3], [2.0, 1.25, 3.7, 4.95], [-0.8, 1.0, 4.05, 4.6], [-2.4, 0.35, 4.2, 4.3]]);
    nozzle(m, -10.0, 0, 3.0, 1.65, 0.95, METAL, TRIM);
    for (const s of [-1, 1]) m.box(-10.2, -10.0, s * 1.75, s * 2.3, 3.4, 3.8, GLOW);
    for (const s of [-1, 1]) {
      // mandible prongs: pink, white tips, red band
      m.paint((X, Y, Z, mat) => {
        if (mat !== BODY2) return mat;
        if (X > 9.2) return TRIM;
        if (X > 5.6 && X < 6.6) return BODY;
        return mat;
      });
      hull(m, [
        [11.6, 0.08, 0.05, 0.05, 2.45, 2.5, 2.6, 2.62],
        [8.6, 0.8, 0.55, 0.45, 2.0, 2.45, 2.95, 3.05],
        [3.5, 1.15, 0.8, 0.65, 1.7, 2.5, 3.35, 3.5],
        [-2.5, 1.2, 0.85, 0.7, 1.6, 2.55, 3.4, 3.55],
        [-6.0, 1.0, 0.7, 0.6, 1.7, 2.55, 3.25, 3.35],
      ], s * 3.6, (k, kind) => (kind === 0 ? DARK : BODY2), 0, METAL);
      m.paint(null);
      // wing struts + end plates
      fin(m, s * 2.0, 0.44, [[-7.2, 4.0], [-8.4, 6.0], [-9.6, 6.0], [-9.4, 4.0]], DARK, DARK);
      fin(m, s * 6.55, 0.4, [[-7.9, 5.0], [-8.3, 6.9], [-11.0, 6.9], [-11.0, 5.4]], BODY, BODY);
    }
    // big rear wing: white with red stripes near the tips
    m.paint((X, Y, Z, mat) => {
      const ay = Math.abs(Y);
      return mat === TRIM && ((ay > 4.4 && ay < 5.1) || ay < 0.45) ? BODY : mat;
    });
    const wingTop = [[-6.8, 0, 6.35], [-8.0, 6.6, 6.55], [-10.9, 6.6, 6.55], [-10.0, 0, 6.35], [-10.9, -6.6, 6.55], [-8.0, -6.6, 6.55]];
    m.plate(wingTop, [0, 0, -0.5], TRIM, BODY);
    m.paint(null);
    m.pivotZ = 3.2;
    return m;
  };

  // DRONE — shared simpler manta shape: wide flat wedge, twin fins, twin nozzles.
  SHAPES.drone = function () {
    const m = new MeshBuilder();
    m.paint((X, Y, Z, mat) => {
      if (mat !== BODY) return mat;
      const ay = Math.abs(Y);
      if (Z > 2.9 && ay < 0.45 && X > 4.4) return TRIM;          // nose stripe
      if (band(ay, 3.3, 3.85) && X > -8.0) return TRIM;           // wing stripe
      if (band(X, -6.6, -6.0) && ay < 3.3 && Z > 2.9) return BODY2;
      return mat;
    });
    hull(m, [
      [10.6, 0.15, 0.1, 0.1, 2.3, 2.4, 2.5, 2.55],
      [6.0, 2.7, 1.4, 1.2, 1.7, 2.4, 3.1, 3.35],
      [-2.0, 4.9, 2.3, 2.0, 1.5, 2.35, 3.65, 4.0],
      [-8.6, 5.3, 2.5, 2.2, 1.6, 2.45, 3.6, 3.9],
      [-9.8, 4.8, 2.3, 2.0, 1.7, 2.45, 3.4, 3.65],
    ], 0, hullMatsStd, 0, METAL);
    m.paint(null);
    canopy(m, [[5.0, 0, 3.0, 3.05], [3.4, 0.9, 3.1, 4.0], [1.0, 1.15, 3.4, 4.55], [-1.6, 0.8, 3.75, 4.2]]);
    m.paint((X, Y, Z, mat) => (mat === BODY && band(X, -4.6, -3.9) ? TRIM : mat));
    for (const s of [-1, 1]) {
      // engine pods at the wing edges
      pod(m, s * 5.1, 2.6, [[1.8, 0.08, 0.08], [-0.6, 0.8, 0.7], [-3.0, 1.0, 0.9], [-9.4, 1.0, 0.9]],
        (k, j, a) => (Math.sin(a) < -0.5 ? DARK : k === 0 ? BODY2 : BODY), 0, 0);
    }
    m.paint(null);
    for (const s of [-1, 1]) {
      nozzle(m, -9.4, s * 5.1, 2.6, 0.95, 0.7, METAL, TRIM);
      fin(m, s * 2.7, 0.44, [[-4.8, 3.7], [-7.6, 5.3], [-9.1, 5.3], [-9.6, 3.4]], BODY, TRIM);
      m.box(-9.95, -9.8, s * 0.6, s * 1.9, 2.75, 3.1, GLOW);
    }
    m.pivotZ = 3.0;
    return m;
  };

  // Compile a builder into typed arrays.
  const meshCache = {};
  function getMesh(shape) {
    if (meshCache[shape]) return meshCache[shape];
    if (!SHAPES[shape]) throw new Error('CARS: unknown shape ' + shape);
    const b = SHAPES[shape]();
    const nt = b.t.length / 6;
    const mesh = {
      v: new Float64Array(b.v),
      nv: b.v.length / 3,
      tri: new Uint16Array(nt * 3),
      mat: new Uint8Array(nt),
      part: new Uint16Array(nt),
      paint: new Uint8Array(nt),
      paintFns: b.paints,
      nt,
      nrm: new Float64Array(nt * 3),   // model-space shading normal per triangle (unit)
      nozzles: b.nozzles.slice(),
      pivotZ: b.pivotZ || 3,
    };
    const V = b.v;
    for (let i = 0; i < nt; i++) {
      const o = i * 6;
      const i0 = b.t[o], i1 = b.t[o + 1], i2 = b.t[o + 2];
      mesh.tri[i * 3] = i0; mesh.tri[i * 3 + 1] = i1; mesh.tri[i * 3 + 2] = i2;
      mesh.mat[i] = b.t[o + 3]; mesh.part[i] = b.t[o + 4]; mesh.paint[i] = b.t[o + 5];
      let n = Number.isNaN(b.n[i * 3]) ? null : [b.n[i * 3], b.n[i * 3 + 1], b.n[i * 3 + 2]];
      if (!n) {
        const p0 = [V[i0 * 3], V[i0 * 3 + 1], V[i0 * 3 + 2]];
        n = unit3(cross3(sub3([V[i1 * 3], V[i1 * 3 + 1], V[i1 * 3 + 2]], p0), sub3([V[i2 * 3], V[i2 * 3 + 1], V[i2 * 3 + 2]], p0))) || [0, 0, 1];
      }
      mesh.nrm[i * 3] = n[0]; mesh.nrm[i * 3 + 1] = n[1]; mesh.nrm[i * 3 + 2] = n[2];
    }
    // Smoothing groups: each triangle corner gets the average of the face normals around that
    // vertex whose angle to its own face is below SMOOTH_DEG (same part only). Gentle curvature
    // (hull segments along the length, rounded decks) shades as smooth bands; chines, wing edges,
    // caps and fin faces stay crisp.
    const nrm = mesh.nrm, cn = new Float64Array(nt * 9);
    const vt = Array.from({ length: mesh.nv }, () => []);
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vt[mesh.tri[t * 3 + k]].push(t);
    for (let t = 0; t < nt; t++) {
      const fx = nrm[t * 3], fy = nrm[t * 3 + 1], fz = nrm[t * 3 + 2];
      for (let k = 0; k < 3; k++) {
        let sx = 0, sy = 0, sz = 0;
        for (const u of vt[mesh.tri[t * 3 + k]]) {
          if (mesh.part[u] !== mesh.part[t]) continue;
          const ux = nrm[u * 3], uy = nrm[u * 3 + 1], uz = nrm[u * 3 + 2];
          if (ux * fx + uy * fy + uz * fz < SMOOTH_COS) continue;
          sx += ux; sy += uy; sz += uz;
        }
        const n = unit3([sx, sy, sz]) || [fx, fy, fz];
        cn[t * 9 + k * 3] = n[0]; cn[t * 9 + k * 3 + 1] = n[1]; cn[t * 9 + k * 3 + 2] = n[2];
      }
    }
    mesh.cn = cn;
    if (mesh.nv > 65535) throw new Error('CARS: mesh too large for Uint16 indices');
    meshCache[shape] = mesh;
    return mesh;
  }

  // ------------------------------------------------------------------------------------------
  // Light (view space: x right, y up, z toward the viewer) — upper-left-front, fixed.
  // ------------------------------------------------------------------------------------------
  const L = (() => { const v = [-0.52, 0.62, 0.58]; const n = Math.hypot(...v); return v.map((c) => c / n); })();
  const H = (() => { const v = [L[0], L[1], L[2] + 1]; const n = Math.hypot(...v); return v.map((c) => c / n); })();
  const T3 = 0.88, T2 = 0.47, T1 = 0.12;   // diffuse quantisation thresholds

  // ------------------------------------------------------------------------------------------
  // Frame rendering
  // ------------------------------------------------------------------------------------------
  function normOpts(opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    // invalid values (undefined, NaN, <= 0 scale) fall back to the defaults instead of producing
    // NaN geometry / zero-sized sheets
    const num = (v, def) => (Number.isFinite(+v) ? +v : def);
    o.pxPerUnit = num(o.pxPerUnit, DEFAULT_OPTS.pxPerUnit);
    if (!(o.pxPerUnit > 0)) o.pxPerUnit = DEFAULT_OPTS.pxPerUnit;
    o.pitchDeg = num(o.pitchDeg, DEFAULT_OPTS.pitchDeg);
    o.yawSteps = Math.max(1, num(o.yawSteps, DEFAULT_OPTS.yawSteps) | 0);
    o.bankDeg = (Array.isArray(o.bankDeg) && o.bankDeg.length ? o.bankDeg : DEFAULT_OPTS.bankDeg).map((b) => num(b, 0));
    return o;
  }

  // Transforms all vertices of `mesh` for (yaw, bank) into view depth + screen px and, when `out`
  // has normal buffers, the face normals (z only: facing test) and smoothed corner normals into
  // view space (x right, y up, z toward the viewer; same rotation, no translation).
  function transform(mesh, ctx, yawRad, bankRad, ax, ay, out) {
    const { v, nv, pivotZ } = mesh;
    const s = ctx.s, cp = ctx.cp, sp = ctx.sp;
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad), cb = Math.cos(bankRad), sb = Math.sin(bankRad);
    const { vz, px, py } = out;
    for (let i = 0; i < nv; i++) {
      const X = v[i * 3], Y = v[i * 3 + 1], Z = v[i * 3 + 2] - pivotZ;
      const Y1 = Y * cb + Z * sb;
      const Z1 = -Y * sb + Z * cb + pivotZ;
      const a = X * cy - Y1 * sy;           // along camera forward (away from viewer)
      const r = X * sy + Y1 * cy;           // screen right
      const h = a * sp + Z1 * cp;           // screen up
      vz[i] = -(a * cp - Z1 * sp);          // toward the viewer (depth = -vz)
      px[i] = ax + r * s; py[i] = ay - h * s;
    }
    if (!out.fz) return;
    // face normal z decides which side faces the viewer; corner normals carry the shading
    const { nrm, cn, nt } = mesh;
    const { fz, cx, cy: cny, cz } = out;
    for (let t = 0; t < nt; t++) {
      const X = nrm[t * 3], Y = nrm[t * 3 + 1], Z = nrm[t * 3 + 2];
      const Y1 = Y * cb + Z * sb, Z1 = -Y * sb + Z * cb;
      fz[t] = -((X * cy - Y1 * sy) * cp - Z1 * sp);
    }
    for (let c = 0; c < nt * 3; c++) {
      const X = cn[c * 3], Y = cn[c * 3 + 1], Z = cn[c * 3 + 2];
      const Y1 = Y * cb + Z * sb, Z1 = -Y * sb + Z * cb;
      const a = X * cy - Y1 * sy;
      cx[c] = X * sy + Y1 * cy; cny[c] = a * sp + Z1 * cp; cz[c] = -(a * cp - Z1 * sp);
    }
  }
  function projectPoint(ctx, pivotZ, yawRad, bankRad, ax, ay, X, Y, Z) {
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad), cb = Math.cos(bankRad), sb = Math.sin(bankRad);
    const Zr = Z - pivotZ;
    const Y1 = Y * cb + Zr * sb, Z1 = -Y * sb + Zr * cb + pivotZ;
    const a = X * cy - Y1 * sy, r = X * sy + Y1 * cy;
    return { x: ax + r * ctx.s, y: ay - (a * ctx.sp + Z1 * ctx.cp) * ctx.s, depth: a * ctx.cp - Z1 * ctx.sp };
  }

  function codeOf(mat, d, sp, spec) {
    if (MAT_EMISSIVE[mat]) return mat * 8 + 3;
    let sh;
    if (sp >= spec[mat]) sh = 4;
    else if (mat === NOZZLE) sh = d > T2 ? 1 : 0;
    else sh = d > T3 ? 3 : d > T2 ? 2 : d > T1 ? 1 : 0;
    return mat * 8 + sh;
  }

  // Rasterise all triangles into depth/code/part buffers (W x H).
  function rasterize(mesh, tv, W, H, depth, code, partBuf, spec) {
    const { tri, mat, part, paint, paintFns, nt, v } = mesh;
    const { vz, px, py, fz, cx, cy: cny, cz } = tv;
    const Lx = L[0], Ly = L[1], Lz = L[2], Hx = H[0], Hy = H[1], Hz = H[2];
    for (let t = 0; t < nt; t++) {
      let i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
      let k1 = 1, k2 = 2;   // which corners ended up as vertices 1 and 2
      let x0 = px[i0], y0 = py[i0], x1 = px[i1], y1 = py[i1], x2 = px[i2], y2 = py[i2];
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area > -1e-9 && area < 1e-9) continue;
      if (area < 0) {
        const tmp = i1; i1 = i2; i2 = tmp; k1 = 2; k2 = 1;
        x1 = px[i1]; y1 = py[i1]; x2 = px[i2]; y2 = py[i2];
        area = -area;
      }
      // smoothed corner normals in view space, oriented toward the viewer by the face normal
      const sg = fz[t] < 0 ? -1 : 1;
      const c0 = t * 3, ca = t * 3 + k1, cb = t * 3 + k2;
      const n0x = cx[c0] * sg, n0y = cny[c0] * sg, n0z = cz[c0] * sg;
      const n1x = cx[ca] * sg, n1y = cny[ca] * sg, n1z = cz[ca] * sg;
      const n2x = cx[cb] * sg, n2y = cny[cb] * sg, n2z = cz[cb] * sg;
      const baseMat = mat[t];
      const pfn = paint[t] ? paintFns[paint[t]] : null;
      const pid = part[t];
      const d0 = -vz[i0], d1 = -vz[i1], d2 = -vz[i2];
      let minX = Math.floor(Math.min(x0, x1, x2)), maxX = Math.ceil(Math.max(x0, x1, x2));
      let minY = Math.floor(Math.min(y0, y1, y2)), maxY = Math.ceil(Math.max(y0, y1, y2));
      if (minX < 0) minX = 0; if (minY < 0) minY = 0;
      if (maxX > W) maxX = W; if (maxY > H) maxY = H;
      const inv = 1 / area;
      const A0 = -(y2 - y1), A1 = -(y0 - y2), A2 = -(y1 - y0);
      // model-space corners for livery evaluation
      const X0 = v[i0 * 3], Y0 = v[i0 * 3 + 1], Z0 = v[i0 * 3 + 2];
      const X1 = v[i1 * 3], Y1 = v[i1 * 3 + 1], Z1 = v[i1 * 3 + 2];
      const X2 = v[i2 * 3], Y2 = v[i2 * 3 + 1], Z2 = v[i2 * 3 + 2];
      for (let y = minY; y < maxY; y++) {
        const cy = y + 0.5;
        const cx0 = minX + 0.5;
        let w0 = (x2 - x1) * (cy - y1) - (y2 - y1) * (cx0 - x1);
        let w1 = (x0 - x2) * (cy - y2) - (y0 - y2) * (cx0 - x2);
        let w2 = (x1 - x0) * (cy - y0) - (y1 - y0) * (cx0 - x0);
        let idx = y * W + minX;
        for (let x = minX; x < maxX; x++, idx++, w0 += A0, w1 += A1, w2 += A2) {
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = (w0 * d0 + w1 * d1 + w2 * d2) * inv;
          if (z < depth[idx]) {
            depth[idx] = z; partBuf[idx] = pid;
            const b0 = w0 * inv, b1 = w1 * inv, b2 = w2 * inv;
            const nx = b0 * n0x + b1 * n1x + b2 * n2x, ny = b0 * n0y + b1 * n1y + b2 * n2y, nz = b0 * n0z + b1 * n1z + b2 * n2z;
            const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
            const d = (nx * Lx + ny * Ly + nz * Lz) * il, sp = (nx * Hx + ny * Hy + nz * Hz) * il;
            const m2 = pfn ? pfn(b0 * X0 + b1 * X1 + b2 * X2, b0 * Y0 + b1 * Y1 + b2 * Y2, b0 * Z0 + b1 * Z1 + b2 * Z2, baseMat) : baseMat;
            code[idx] = codeOf(m2, d, sp, spec);
          }
        }
      }
    }
  }

  // Pixel-art cleanup: a pixel whose code appears nowhere in its 8-neighbourhood is an orphan
  // (shading fleck, stripe fragment, lone crease dot, silhouette sliver). Replace it with the most
  // common 4-neighbour code (ties prefer the same material). Tail lights, nozzles and canopy glints
  // are intentional 1-px details and are kept; transparent pixels never change, so the
  // silhouette is untouched.
  function despeckle(W, H, code, src) {
    src.set(code);
    const n4 = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, c = src[i];
        if (!c) continue;
        const m = c >> 3;
        if (m === GLOW || m === NOZZLE || (m === CANOPY && (c & 7) === 4)) continue;
        let same = false;
        for (let dy = -1; dy <= 1 && !same; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx || dy) && xx >= 0 && xx < W && src[yy * W + xx] === c) { same = true; break; }
          }
        }
        if (same) continue;
        n4[0] = x > 0 ? src[i - 1] : 0; n4[1] = x + 1 < W ? src[i + 1] : 0;
        n4[2] = y > 0 ? src[i - W] : 0; n4[3] = y + 1 < H ? src[i + W] : 0;
        let best = 0, bestScore = 0;
        for (let k = 0; k < 4; k++) {
          const q = n4[k];
          if (!q || (q >> 3) === GLOW || (q >> 3) === NOZZLE) continue;
          let score = (q >> 3) === m ? 1 : 0;
          for (let j = 0; j < 4; j++) if (n4[j] === q) score += 2;
          if (score > bestScore) { bestScore = score; best = q; }
        }
        if (best) code[i] = best;
      }
    }
  }

  // Crease lines (where a part overlaps a different, clearly farther part) + silhouette outline.
  function postProcess(W, H, depth, code, partBuf, tmp, creaseDepth, scratch) {
    if (creaseDepth > 0) {
      tmp.fill(0);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!code[i]) continue;
          const di = depth[i], pi = partBuf[i];
          // neighbours: right and down (check both directions symmetric)
          if (x + 1 < W) {
            const j = i + 1;
            if (code[j] && partBuf[j] !== pi) {
              if (depth[j] - di > creaseDepth) tmp[j] = 1;
              else if (di - depth[j] > creaseDepth) tmp[i] = 1;
            }
          }
          if (y + 1 < H) {
            const j = i + W;
            if (code[j] && partBuf[j] !== pi) {
              if (depth[j] - di > creaseDepth) tmp[j] = 1;
              else if (di - depth[j] > creaseDepth) tmp[i] = 1;
            }
          }
        }
      }
      for (let i = 0; i < W * H; i++) {
        if (tmp[i]) {
          const m = code[i] >> 3;
          if (m !== GLOW && m !== NOZZLE) code[i] = m * 8 + CREASE_SHADE;
        }
      }
    }
    despeckle(W, H, code, scratch);
    // outline: transparent pixels 4-adjacent to the silhouette
    tmp.fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (code[i]) continue;
        if ((x > 0 && code[i - 1]) || (x + 1 < W && code[i + 1]) || (y > 0 && code[i - W]) || (y + 1 < H && code[i + W])) tmp[i] = 1;
      }
    }
    for (let i = 0; i < W * H; i++) if (tmp[i]) code[i] = OUTLINE;
  }

  // ------------------------------------------------------------------------------------------
  // Index sheets (shape + view options) are cached; colourising per design is cheap.
  // ------------------------------------------------------------------------------------------
  const indexCache = new Map();

  function buildIndexSheet(shape, o) {
    const cacheKey = [shape, o.pxPerUnit, o.pitchDeg, o.yawSteps, o.bankDeg.join(',')].join('|');
    if (indexCache.has(cacheKey)) return indexCache.get(cacheKey);
    const mesh = getMesh(shape);
    const ctx = { s: o.pxPerUnit, cp: Math.cos(o.pitchDeg * DEG), sp: Math.sin(o.pitchDeg * DEG) };
    const YS = o.yawSteps, NB = o.bankDeg.length;
    const nv = mesh.nv, nt = mesh.nt;
    const bounds = { vz: new Float64Array(nv), px: new Float64Array(nv), py: new Float64Array(nv) };
    const tv = {
      vz: new Float64Array(nv), px: new Float64Array(nv), py: new Float64Array(nv),
      fz: new Float64Array(nt), cx: new Float64Array(nt * 3), cy: new Float64Array(nt * 3), cz: new Float64Array(nt * 3),
    };
    const yawRad = (i) => (i * 2 * Math.PI) / YS;
    const bankRad = (b) => o.bankDeg[b] * DEG;

    // pass 1: bounds over all frames (anchor at 0,0)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < YS; i++) {
      for (let b = 0; b < NB; b++) {
        transform(mesh, ctx, yawRad(i), bankRad(b), 0, 0, bounds);
        for (let k = 0; k < nv; k++) {
          const x = bounds.px[k], y = bounds.py[k];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const PAD = 2; // 1 px outline + 1 px clear border
    const anchorX = PAD - Math.floor(minX), anchorY = PAD - Math.floor(minY);
    const frameW = Math.floor(anchorX + maxX - 0.5) + 1 + PAD;
    const frameH = Math.floor(anchorY + maxY - 0.5) + 1 + PAD;
    const cols = Math.min(YS, 8), rowsPerBank = Math.ceil(YS / cols);
    const width = cols * frameW, height = rowsPerBank * NB * frameH;
    const frameOf = (i, b) => ({ sx: (i % cols) * frameW, sy: (b * rowsPerBank + Math.floor(i / cols)) * frameH });

    const codes = new Uint8Array(width * height);
    const N = frameW * frameH;
    const depth = new Float32Array(N), code = new Uint8Array(N), partBuf = new Uint16Array(N), tmp = new Uint8Array(N), scratch = new Uint8Array(N);
    const exhaust = [];
    const creaseDepth = o.pxPerUnit >= 3 ? 1.6 : 0;
    const spec = o.pxPerUnit >= 3 ? MAT_SPEC : MAT_SPEC_FAR;

    for (let i = 0; i < YS; i++) {
      const row = [];
      for (let b = 0; b < NB; b++) {
        const yr = yawRad(i), br = bankRad(b);
        transform(mesh, ctx, yr, br, anchorX, anchorY, tv);
        minStripe = 1.05 / o.pxPerUnit;
        depth.fill(Infinity); code.fill(0); partBuf.fill(0);
        rasterize(mesh, tv, frameW, frameH, depth, code, partBuf, spec);
        // nozzle visibility from the clean depth buffer
        const ex = mesh.nozzles.map((nz) => {
          const c = projectPoint(ctx, mesh.pivotZ, yr, br, anchorX, anchorY, nz.x, nz.y, nz.z);
          const back = projectPoint(ctx, mesh.pivotZ, yr, br, anchorX, anchorY, nz.x - 1, nz.y, nz.z);
          let visible = false;
          for (const t of [0, 0.5, 1.0]) {
            const p = t === 0 ? c : projectPoint(ctx, mesh.pivotZ, yr, br, anchorX, anchorY, nz.x - t, nz.y, nz.z);
            const xi = Math.floor(p.x), yi = Math.floor(p.y);
            if (xi < 0 || yi < 0 || xi >= frameW || yi >= frameH) { visible = true; break; }
            const zb = depth[yi * frameW + xi];
            if (zb === Infinity || p.depth <= zb + 0.35) { visible = true; break; }
          }
          return {
            x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, visible,
            r: Math.round(nz.r * o.pxPerUnit * 100) / 100,
            dx: Math.round((back.x - c.x) * 100) / 100, dy: Math.round((back.y - c.y) * 100) / 100,
          };
        });
        row.push(ex);
        postProcess(frameW, frameH, depth, code, partBuf, tmp, creaseDepth, scratch);
        const { sx, sy } = frameOf(i, b);
        for (let y = 0; y < frameH; y++) codes.set(code.subarray(y * frameW, (y + 1) * frameW), (sy + y) * width + sx);
      }
      exhaust.push(row);
    }
    const res = { frameW, frameH, width, height, anchorX, anchorY, cols, rowsPerBank, codes, exhaust, frameOf };
    indexCache.set(cacheKey, res);
    return res;
  }

  function buildPalette(colors) {
    const pal = new Uint32Array(256);
    const pack = (c) => ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
    for (let m = 1; m < MAT_KEYS.length; m++) {
      const hex = colors[MAT_KEYS[m]] || '#ff00ff';
      const r = shadeRamp(hex);
      for (let sh = 0; sh < 6; sh++) pal[m * 8 + sh] = pack(r[sh]);
    }
    pal[OUTLINE] = pack(hexToRgb(colors.outline || '#0a0a14'));
    return pal;
  }

  function buildSheet(key, opts) {
    const design = DESIGNS[key];
    if (!design) throw new Error('CARS: unknown design ' + key);
    const o = normOpts(opts);
    const idx = buildIndexSheet(design.shape, o);
    const pal = buildPalette(design.colors);
    const pixels = new Uint8ClampedArray(idx.width * idx.height * 4);
    const out32 = new Uint32Array(pixels.buffer);
    const codes = idx.codes;
    for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c) out32[i] = pal[c]; }
    const exhaust = idx.exhaust.map((row) => row.map((list) => list.map((e) => Object.assign({}, e))));
    const frames = [];
    for (let i = 0; i < o.yawSteps; i++) {
      frames.push([]);
      for (let b = 0; b < o.bankDeg.length; b++) frames[i].push(Object.freeze(idx.frameOf(i, b)));
    }
    return {
      key, pxPerUnit: o.pxPerUnit, pitchDeg: o.pitchDeg, yawSteps: o.yawSteps, banks: o.bankDeg.length,
      bankDeg: o.bankDeg.slice(),
      frameW: idx.frameW, frameH: idx.frameH, width: idx.width, height: idx.height,
      pixels,
      // yaw wraps (rounded to the nearest step; non-finite -> 0), bank rounds + clamps
      // (non-finite/omitted -> the middle bank); returns a shared frozen {sx, sy}
      frame: (yawIdx, bankIdx) => {
        const n = o.yawSteps, nb = o.bankDeg.length;
        const yi = Number.isFinite(yawIdx) ? Math.round(yawIdx) : 0;
        const i = ((yi % n) + n) % n;
        const b = Number.isFinite(bankIdx) ? Math.max(0, Math.min(nb - 1, Math.round(bankIdx))) : nb >> 1;
        return frames[i][b];
      },
      anchorX: idx.anchorX, anchorY: idx.anchorY,
      exhaust,
    };
  }

  // Browser helper (lazy, only when called): sheet -> canvas.
  function sheetToCanvas(sheet) {
    const cv = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined'
      ? new OffscreenCanvas(sheet.width, sheet.height)
      : Object.assign(document.createElement('canvas'), { width: sheet.width, height: sheet.height });
    const g = cv.getContext('2d');
    g.putImageData(new ImageData(sheet.pixels, sheet.width, sheet.height), 0, 0);
    return cv;
  }

  // Debug/test helper: project a model-space point for a given frame of a sheet built with opts.
  function project(key, opts, yawIdx, bankIdx, point) {
    const design = DESIGNS[key];
    const o = normOpts(opts);
    const idx = buildIndexSheet(design.shape, o);
    const mesh = getMesh(design.shape);
    const ctx = { s: o.pxPerUnit, cp: Math.cos(o.pitchDeg * DEG), sp: Math.sin(o.pitchDeg * DEG) };
    return projectPoint(ctx, mesh.pivotZ, (yawIdx * 2 * Math.PI) / o.yawSteps, o.bankDeg[bankIdx] * DEG, idx.anchorX, idx.anchorY, point[0], point[1], point[2]);
  }

  return {
    DESIGNS,
    keys: Object.keys(DESIGNS),
    DEFAULT_OPTS,
    buildSheet,
    sheetToCanvas,
    clearCache: () => indexCache.clear(),
    _project: project,
    _meshStats: (shape) => { const m = getMesh(shape); return { triangles: m.nt, vertices: m.nv, nozzles: m.nozzles.length }; },
  };
})();
