# ZERO-G GP — module contracts

ZERO-G GP is an ORIGINAL retro hover-racing game in the spirit of the 1990 SNES "F-Zero"
(Mode-7 pseudo-3D floor, sprite machines, energy meter, pit zone, boost, guard rails).
Do NOT copy F-Zero names, logos, melodies or sprites — everything must be original.

The final deliverable is ONE self-contained `index.html` (no build step, no libraries, no network).
During development each module lives in `zero-g-gp/parts/<module>.js`; `dev/build.mjs` concatenates
them, in this order, into a single classic `<script>`:

    font.js, themes.js, cars.js, audio.js, core-sim.js, core-render.js, core-app.js

## Global rules for every module

- Plain modern JavaScript (ES2020), no `import`/`export`, no dependencies.
- Each file declares exactly ONE top-level `const NAME = (() => { ...; return {...}; })();`
  (`FONT`, `THEMES`, `CARS`, `AUDIO`). No other globals.
- **Must not touch the DOM / window / AudioContext at load time.** The whole script is also
  evaluated headlessly in Node for tests (`globalThis.window` undefined). Create canvases /
  audio lazily inside functions that are only called in the browser.
- Game internal resolution: **384 × 216**, scaled up with nearest-neighbour (`image-rendering: pixelated`).
  Horizon row y = 72. Camera horizontal focal length f = 192 px (90° horizontal FOV, so the
  full 360° = 1536 px).
- Packed pixel format (`Uint32Array` view of ImageData, little-endian):
  `((255 << 24) | (b << 16) | (g << 8) | r) >>> 0`.
- World units: 1 unit = 1 floor texel. A machine is ≈22 long × 13 wide × 4–5 tall.
  Road ≈ 110–130 units wide. Top speed ≈ 300 units/s.
- World axes (top view): x right, y DOWN. Heading θ: forward = (cos θ, sin θ);
  right = (−sin θ, cos θ). Increasing θ = turning right (clockwise on the map).
- Node ≥ 20 is available (`node`). For visual self-checks write PNGs with
  `dev/png.mjs` (`writePNG(path, w, h, rgba)`, `upscale(w,h,rgba,k)`, `u32ToRGBA(u32)`) into
  `dev/preview/` and LOOK at them with the Read tool. Put any test scripts in `dev/`.

---

## FONT — `parts/font.js`

Crisp bitmap pixel font for HUD/menus (all in-canvas text is English/ASCII).

```
FONT.CELL_W = 8, FONT.CELL_H = 8          // fixed cell; glyph body ≤ 7×7, 1px gap
FONT.draw(ctx, text, x, y, opts?) -> width   // x,y = top-left of first cell (after alignment)
   opts: color (CSS, default '#fff'), scale (integer ≥1, default 1),
         align: 'left'|'center'|'right', shadow (CSS color|null; offset 1*scale down-right),
         outline (CSS color|null; 1*scale px outline, 8-neighbour), italic (bool: rows shear right
         toward the top, ~1px per 3 rows at scale 1), alpha (0..1), lineHeight (default 10)
   '\n' starts a new line (lineHeight*scale).
FONT.measure(text, scale=1) -> width in px of the widest line
FONT.glyphBits(ch) -> Array(8) of row bitmasks (bit 7 = leftmost px) — used by tests
```
- Glyphs: ASCII 32–126 (upper AND lower case, digits, punctuation) plus `← → ↑ ↓ × ° ★ ■ ▶ ◀ ♪ ' "`
  (straight quotes already in ASCII; `'` and `"` are used for lap times like 1'23"45).
  Unknown chars render as a small box.
- Style: chunky, bold, high-contrast arcade font (2-px vertical stems where possible), clearly
  readable at scale 1 on a 384×216 canvas. Digits must be very legible (they show speed/times).
- Browser drawing: build a glyph atlas canvas lazily (per colour × scale, cached in a Map,
  white-glyph atlas tinted via `globalCompositeOperation='source-in'`), then `drawImage` each glyph.
  Shadow/outline drawn by stamping the shadow-coloured atlas at offsets first. Must stay fast:
  ~300 glyphs per frame at 60 fps.
- No DOM at load time (create atlas on first `draw`).

---

## THEMES — `parts/themes.js`

Six course environments. `THEMES.ids = ['neon','coast','desert','gale','frost','inferno']`,
`THEMES.get(id) -> theme`:

```
{
  id, name,                    // name: uppercase display name
  fog: [r,g,b],                // horizon haze; floor rows near the horizon blend into it.
                               // Must match the bottom rows of the panorama.
  palette: {                   // every entry [r,g,b] unless noted
    road, roadAlt,             // road panels (alternating tiles, SUBTLE difference)
    roadSeam,                  // thin seams between road panels
    roadLine,                  // bright edge line near the rails
    railA, railB, railLight, railDark,   // guard-rail bumper blocks alternate A/B, lamp dots, base
    shoulder,                  // narrow strip outside the rail (usually dark)
    startA, startB,            // checkered start/finish line
    pit, pitStripe,            // energy-recharge pit zone (classically pink/magenta)
    dash, dashDark,            // dash plate (speed arrows, yellow/orange)
    jump, jumpDark,            // jump plate
    rough, roughDark,          // rough/gravel slow zone
    ice, iceLight,             // slippery zone
    minimapRoad: 'css', minimapBg: 'css', hudAccent: 'css'
  },
  buildGroundTile(size) -> Uint32Array(size*size)   // packed ABGR, see global rules
  buildPanorama(w, h)   -> Uint8ClampedArray(w*h*4) // RGBA, opaque
  weather: null|'snow'|'sand'|'embers'|'rain'|'sparkle'   // core draws screen-space particles
  weatherColor: 'css'
}
```
- **Ground tile** = off-track terrain seen from directly above (the track itself is drawn by the
  core on top). Must tile seamlessly (periodic in x and y). `size` is a power of two (512).
  Viewed via Mode-7 at a low angle with nearest sampling + box-filter mips: avoid 1-texel
  random noise (shimmers); prefer bold structure with features ≥ 4–8 texels (city blocks with
  rooftops and glowing streets, ocean swell, dune ripples, metal plates, snow & pines, lava
  rivers...). Retro 16-bit palette, limited colours, ordered dither OK. Deterministic (seeded RNG).
- **Panorama** = 360° backdrop strip drawn above the horizon. `w = 1536` corresponds to 360°,
  `h = 72` (row h−1 sits on the horizon). Must wrap horizontally seamlessly (col w−1 → col 0).
  Sky gradient (banded/dithered 16-bit style) + distant silhouettes (skyline with lit windows,
  mountains, dunes, volcano, clouds...). Bottom 4–6 rows fade to `fog`. Pixel-art, hard edges.
- Theme concepts:
  - `neon` NEON CITY — night megacity: dark blocks, lit rooftops, cyan/magenta street glow;
    road dark blue-grey panels; rails yellow/black-orange; skyline with windows under a purple sky.
  - `coast` BLUE COAST — sunny ocean highway: deep blue sea with white wave crests; road light
    grey; rails blue/white; bright sky, clouds, distant islands.
  - `desert` DUNE SEA — sunset desert: orange/tan dune ripples; road sandy beige-grey; rails
    red/white; orange-pink sky, sun disc, mesas/pyramids.
  - `gale` STORM VALLEY — stormy wasteland: grey-green rock + metal grates; road dark grey;
    rails green/white; brooding storm clouds, distant towers/turbines; weather 'rain'.
  - `frost` FROST LINE — snow world: snow fields, blue ice cracks, pine trees; road pale
    blue-grey; rails cyan/navy; pale sky, snowy mountains; weather 'snow'.
  - `inferno` MAGMA FIELD — volcanic: black basalt + glowing lava rivers; road dark red-brown;
    rails orange/black; red sky, volcanoes with smoke plumes; weather 'embers'.
- Road palettes must keep the road clearly distinguishable from the ground, the rails very
  visible, and dash/jump/pit/rough/ice colours distinct from the road and from each other.

---

## CARS — `parts/cars.js`

Pre-rendered pixel-art sprite sheets of the hover machines, rendered by an own software
rasterizer (triangles + z-buffer) — no DOM.

```
CARS.DESIGNS = { comet, lynx, bison, hornet, drone0, drone1, drone2, drone3, drone4, drone5 }
   each: { name, shape, colors: {...} }        // visual only (stats live in the core)
CARS.buildSheet(key, opts) -> sheet
   opts: { pxPerUnit: 4, pitchDeg: 28, yawSteps: 32, bankDeg: [-18, 0, 18] }
   sheet: {
     key, pxPerUnit, pitchDeg, yawSteps, banks,   // banks = bankDeg.length
     frameW, frameH,                     // all frames same size
     width, height,                      // sheet size in px
     pixels: Uint8ClampedArray(width*height*4),  // RGBA, alpha only 0 or 255
     frame(yawIdx, bankIdx) -> {sx, sy}, // top-left of that frame within the sheet
     anchorX, anchorY,                   // px inside every frame where the ground point under the
                                         // car centre projects (same for all frames)
     exhaust: [yawIdx][bankIdx] -> [{x, y, visible}]   // nozzle centres, frame-relative px;
                                         // visible=false when hidden behind the hull
   }
```
- Designs (all ORIGINAL — evoke the archetype, don't copy any existing machine):
  - `comet` BLUE COMET — blue/white with yellow trim. Sleek arrowhead hull, single tall tail
    fin, twin engines. Balanced all-rounder.
  - `lynx` GOLD LYNX — gold/yellow + black. Light & slim: narrow needle nose, twin outrigger
    pods on short arms.
  - `bison` IRON BISON — dark green + gunmetal. Wide, low, heavily armoured, big side pods,
    blunt nose, four nozzles.
  - `hornet` RED HORNET — red/pink + white. Long body, two forward mandible prongs, large rear
    wing, single big nozzle.
  - `drone0..5` — generic opponent drones: one shared simpler shape, colour schemes purple,
    orange, teal, grey, pink, lime.
- Geometry: model space +X forward (nose), +Y right, +Z up. Origin = ground point under the
  car centre. Length ≈ 22, width ≈ 13, height 4–5; hull bottom hovers 1.5 above ground.
- View: orthographic, camera looking along its forward axis, pitched DOWN by `pitchDeg`.
  Yaw index i: car heading relative to camera = i·360/yawSteps degrees, CLOCKWISE seen from
  above. i=0 → car faces away (we see the tail); i=yawSteps/4 → nose points screen-RIGHT (we
  see its LEFT flank); i=yawSteps/2 → nose toward camera; i=3·yawSteps/4 → nose screen-LEFT.
- Bank b: roll bankDeg[b]; positive = right side dips (used when steering right).
- Scale: `pxPerUnit` sprite pixels per world unit. Frames tight but large enough for every
  yaw/bank. The core requests four sheets per design and picks the one whose pitch best matches
  the real view: near `{pxPerUnit:4, pitchDeg:28}`, mid `{3, 19}`, far `{2, 12}`, farHi `{2, 26}`.
- Look: SNES-era pre-rendered pixel art — fixed light from upper-left-front (relative to the
  camera, identical for all frames), 3–4 quantised shades per material, glossy canopy
  highlight, 1-px dark outline around the silhouette, dark engine nozzles at the tail (core adds
  flame glow), coloured accent stripes. Hard alpha (0/255).
- Performance: building all 10 designs × 2 sheets should take < 1.5 s total in V8.

---

## AUDIO — `parts/audio.js`

Web Audio synthesis only (no samples, no network).

```
AUDIO.init()                 // create/resume AudioContext; call from a user gesture; idempotent
AUDIO.setVolume({master, bgm, sfx})   // each 0..1, optional
AUDIO.setMuted(bool), AUDIO.isMuted()
AUDIO.engine(p|null)         // per frame in races: p = {speed: 0..1.5 (1 = machine top speed,
                             //   >1 boosting), throttle: 0|1, boost: bool, air: bool,
                             //   machine: 'comet'|'lynx'|'bison'|'hornet'}; null → fade out
AUDIO.scrape(intensity 0..1) // electric guard-rail grinding buzz; 0 = off (continuous loop)
AUDIO.pit(on)                // energy recharge hum/arpeggio loop while in the pit zone
AUDIO.alarm(on)              // low-energy warning: classic two-tone beep loop
AUDIO.wind(intensity 0..1)   // gusty wind noise loop
AUDIO.sfx(name, opts?)       // one-shots:
   'menuMove','menuSelect','menuBack','menuError','pause',
   'count' (3-2-1 beep), 'go',
   'lap','finalLap','goal','record','boostReady',
   'wallHit' {power 0..1}, 'carHit' {power 0..1, pan -1..1},
   'boost' (super-jet ignition), 'dash' (dash plate), 'jump', 'land',
   'mine' (small explosion), 'explode' (machine destroyed), 'rankOut', 'retire'
AUDIO.bgm(name|null)         // loop: 'title','select','neon','coast','desert','gale','frost',
                             //       'inferno','results','champion','gameover'; null stops
AUDIO.bgmTempo(mult)         // e.g. 1.1 on the final lap (applies smoothly to current track)
```
- Every function is a safe no-op before `init()` or when Web Audio is unavailable.
  Continuous controls (`engine/scrape/pit/alarm/wind`) are called EVERY FRAME with the same
  value — they must be cheap and idempotent (use setTargetAtTime, don't rebuild nodes).
- Music: ALL ORIGINAL compositions — do not reproduce melodies from F-Zero or any other existing
  song. 16-bit/chiptune style: 2 pulse/square voices (lead + harmony/arpeggio), bass
  (triangle/filtered saw), noise drums. Race tracks 140–175 BPM energetic fusion/rock, each in
  a distinct key and mood matching its theme; loops of 16–32 bars with intro-less seamless loop.
  'title' heroic, 'select' cool mid-tempo, 'results' relaxed, 'champion' triumphant fanfare
  (can loop), 'gameover' short sad jingle (no loop).
- Scheduler: look-ahead (setInterval ≈25 ms, schedule ≈0.15 s ahead on AudioContext time).
- Quality: no clicks (attack/release envelopes), one-shot nodes disconnected after use, voice
  cap, master compressor/limiter, sensible default mix (music ≈0.5, sfx ≈0.8, engine audible
  but not dominating).
