// =====================================================================
// APP — scenes (title, menus, race, results, GP), input, audio glue, save
// =====================================================================
const APP = (() => {
  'use strict';
  const W = RENDER.W, H = RENDER.H;
  const { clamp, lerp, wrapA } = SIM;
  const FD = (ctx, text, x, y, o) => FONT.draw(ctx, text, x, y, o);
  const HERO_COL = RENDER.HERO_DOT;
  const DESIGNS = ['comet', 'lynx', 'bison', 'hornet', 'drone0', 'drone1', 'drone2', 'drone3', 'drone4', 'drone5'];
  const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'ST' : n % 10 === 2 && n % 100 !== 12 ? 'ND' : n % 10 === 3 && n % 100 !== 13 ? 'RD' : 'TH');

  // ------------------------------------------------------------------
  // Save data
  // ------------------------------------------------------------------
  const SAVE_KEY = 'zerogp.v1';
  function defaults() {
    return {
      v: 1,
      settings: { bgm: 0.6, sfx: 0.8, minimap: true, shake: true, difficulty: 'standard', machine: 'comet', course: 'neon', touchAuto: true },
      rec: {}, trophies: {},
    };
  }
  function loadSave() {
    const d = defaults();
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (s && s.v === 1) {
        Object.assign(d.settings, s.settings || {});
        d.rec = s.rec || {};
        d.trophies = s.trophies || {};
      }
    } catch (e) { /* storage unavailable */ }
    return d;
  }
  let save = null;
  let saveWarned = false;
  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); return true; } catch (e) {
      if (!saveWarned) { saveWarned = true; toast('SAVE UNAVAILABLE'); }
      return false;
    }
  }
  function saveGhost(id, machine, time, arr) {
    try {
      const u8 = new Uint8Array(Int16Array.from(arr).buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      localStorage.setItem('zerogp.ghost.' + id, JSON.stringify({ m: machine, t: time, d: btoa(s) }));
      return true;
    } catch (e) { return false; }
  }
  function loadGhost(id) {
    try {
      const g = JSON.parse(localStorage.getItem('zerogp.ghost.' + id) || 'null');
      if (!g) return null;
      const bin = atob(g.d);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { m: g.m, t: g.t, data: new Int16Array(u8.buffer) };
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------
  // Input: keyboard, gamepad, touch
  // ------------------------------------------------------------------
  const KEYMAP = {
    left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
    accel: ['KeyX', 'ArrowUp'], brake: ['KeyZ', 'ArrowDown'], boost: ['KeyC', 'Space'],
    leanL: ['KeyA'], leanR: ['KeyS'],
    ok: ['Enter', 'KeyX', 'Space'], back: ['Escape', 'KeyZ', 'Backspace'], pause: ['Escape', 'KeyP', 'Enter'],
  };
  const ACTIONS = Object.keys(KEYMAP);
  const keys = new Set(), pressed = new Set();
  let heldAtEnter = new Set(); // keys already down when the current scene started (their OS repeats are ignored)
  const pad = { held: {}, hit: {}, prev: {}, rep: {}, steer: 0, dl: false, dr: false, ok: true };
  const touch = { held: {}, hit: {}, enabled: false, ptr: new Map() };
  let lastInput = 'key'; // 'key' | 'pad' | 'touch' — touch-only behaviour follows actual use
  let unlocked = false;

  function held(a) { return KEYMAP[a].some((k) => keys.has(k)) || !!pad.held[a] || !!touch.held[a]; }
  function hit(a) { return KEYMAP[a].some((k) => pressed.has(k)) || !!pad.hit[a] || !!touch.hit[a]; }
  function helpOpen() { const h = document.getElementById('help'); return !!h && !h.hidden; }
  function touchMode() { return touch.enabled && lastInput === 'touch'; }

  function pollPad(dt) {
    let gps = [];
    if (pad.ok) {
      try { gps = (navigator.getGamepads && navigator.getGamepads()) || []; } catch (e) { pad.ok = false; }
    }
    let gp = null;
    for (const g of gps) if (g && g.connected) { gp = g; break; }
    const now = {};
    pad.steer = 0; pad.dl = pad.dr = false;
    if (gp) {
      const b = (i) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      pad.dl = b(14); pad.dr = b(15);
      now.left = pad.dl || ax < -0.5; now.right = pad.dr || ax > 0.5;
      now.up = b(12) || ay < -0.5; now.down = b(13) || ay > 0.5;
      now.accel = b(0) || b(7); now.brake = b(2) || b(6); now.boost = b(1) || b(3);
      now.leanL = b(4); now.leanR = b(5);
      now.ok = b(0) || b(9); now.back = b(1); now.pause = b(9);
      if (Math.abs(ax) > 0.18) pad.steer = clamp((Math.abs(ax) - 0.18) / 0.72, 0, 1) * Math.sign(ax);
    }
    for (const a of ACTIONS) {
      const v = !!now[a];
      pad.hit[a] = v && !pad.prev[a];
      // auto-repeat for menu directions
      if (v && (a === 'left' || a === 'right' || a === 'up' || a === 'down')) {
        pad.rep[a] = (pad.rep[a] || 0) + dt;
        if (pad.rep[a] > 0.4) { pad.hit[a] = true; pad.rep[a] = 0.28; }
      } else pad.rep[a] = 0;
      pad.held[a] = v;
      pad.prev[a] = v;
    }
    if (ACTIONS.some((a) => pad.hit[a])) { lastInput = 'pad'; setTouchVisible(false); unlock(); }
  }

  function onKey(e, down) {
    const c = e.code;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // browser / OS shortcuts are not game input (macOS also swallows keyups while Cmd is held)
      if (!down) keys.delete(c);
      else if (/^(Meta|Control|Alt)/.test(c)) keys.clear();
      return;
    }
    if (helpOpen()) {
      if (down && !e.repeat && (c === 'KeyH' || c === 'Escape' || c === 'Enter')) { toggleHelp(false); e.preventDefault(); }
      if (!down) { keys.delete(c); heldAtEnter.delete(c); }
      return;
    }
    if (down) {
      if (!e.repeat || (c.startsWith('Arrow') && !heldAtEnter.has(c))) pressed.add(c);
      keys.add(c);
      if (lastInput !== 'key') { lastInput = 'key'; setTouchVisible(false); }
      unlock();
      if (!e.repeat) {
        if (c === 'KeyM') toggleMute();
        if (c === 'KeyF') toggleFullscreen();
        if (c === 'KeyH') toggleHelp();
      }
    } else { keys.delete(c); heldAtEnter.delete(c); }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace'].includes(c)) e.preventDefault();
    if (c === 'Enter' && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    AUDIO.init();
    applyVolume();
    if (scene && scene.onUnlock) scene.onUnlock();
  }
  function applyVolume() {
    AUDIO.setVolume({ master: 1, bgm: save.settings.bgm, sfx: save.settings.sfx });
  }
  function toggleMute() {
    AUDIO.setMuted(!AUDIO.isMuted());
    toast(AUDIO.isMuted() ? 'SOUND OFF' : 'SOUND ON');
  }
  function toggleFullscreen() {
    const el = document.documentElement;
    try {
      const cur = document.fullscreenElement || document.webkitFullscreenElement;
      const fn = cur ? document.exitFullscreen || document.webkitExitFullscreen : el.requestFullscreen || el.webkitRequestFullscreen;
      if (!fn) return;
      const pr = fn.call(cur ? document : el);
      if (pr && pr.catch) pr.catch(() => {});
    } catch (e) { /* not allowed */ }
  }
  function toggleHelp(force) {
    const h = document.getElementById('help');
    if (!h) return;
    const show = force !== undefined ? force : h.hidden;
    h.hidden = !show;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (show) {
      pressed.clear();
      if (scene && scene.onHide) scene.onHide();
    }
  }

  function setTouchVisible(on) {
    const root = document.getElementById('touch');
    if (root && touch.enabled) root.hidden = !on;
  }
  function clearTouch() {
    touch.ptr.clear();
    touch.held = {};
    const root = document.getElementById('touch');
    if (root) for (const b of root.children) b.classList.remove('on');
  }
  // On-screen pad. Pointers are tracked globally so a thumb can slide from one button to another.
  function setupTouch() {
    const root = document.getElementById('touch');
    if (!root) return;
    if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) return;
    touch.enabled = true;
    root.hidden = true; // shown on the first real touch
    const map = [
      ['tl', 'left', '◀'], ['tr', 'right', '▶'], ['tu', 'up', '▲'], ['td', 'down', '▼'],
      ['ta', 'ok accel', 'A'], ['tb', 'back brake', 'B'], ['tc', 'boost', 'BOOST'],
      ['tll', 'leanL', 'L'], ['tlr', 'leanR', 'R'], ['tp', 'pause', 'II'],
    ];
    for (const [id, acts, label] of map) {
      const b = document.createElement('button');
      b.id = id; b.textContent = label; b.className = 'tbtn'; b.tabIndex = -1;
      b.dataset.acts = acts;
      root.appendChild(b);
    }
    const buttonAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el && el.closest ? el.closest('.tbtn') : null;
    };
    const sync = () => {
      const next = {};
      const down = new Set(touch.ptr.values());
      for (const b of down) if (b) for (const a of b.dataset.acts.split(' ')) next[a] = true;
      for (const a in next) if (!touch.held[a]) touch.hit[a] = true;
      touch.held = next;
      for (const b of root.children) b.classList.toggle('on', down.has(b));
    };
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      lastInput = 'touch';
      unlock();
      setTouchVisible(true);
      const b = buttonAt(e.clientX, e.clientY);
      if (b) {
        e.preventDefault();
        try { if (e.target.releasePointerCapture) e.target.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      touch.ptr.set(e.pointerId, b);
      sync();
    }, { passive: false });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !touch.ptr.has(e.pointerId)) return;
      const b = buttonAt(e.clientX, e.clientY);
      if (b !== touch.ptr.get(e.pointerId)) { touch.ptr.set(e.pointerId, b); sync(); }
    });
    const end = (e) => {
      if (e.pointerType !== 'touch' || !touch.ptr.has(e.pointerId)) return;
      touch.ptr.delete(e.pointerId);
      sync();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------
  // Shared resources
  // ------------------------------------------------------------------
  let canvas, ctx, img, view;
  let sheets = null;
  const sheetCanvas = {};
  const worlds = new Map();
  const minimaps = new Map();
  let time = 0;
  let frameDt = 1 / 60;
  let toastMsg = null;

  function getWorld(id) {
    if (worlds.has(id)) {
      const w = worlds.get(id);
      worlds.delete(id); worlds.set(id, w); // LRU touch
      return w;
    }
    // free old worlds first so two 23 MB worlds and the build temporaries never coexist
    while (worlds.size >= 2) {
      let victim = null;
      for (const [k, v] of worlds) if (v !== bg.world) { victim = k; break; }
      if (victim === null) break;
      worlds.delete(victim);
    }
    const def = SIM.courseById(id);
    const T = SIM.buildTrack(def);
    const w = RENDER.buildWorld(T, THEMES.get(def.theme));
    worlds.set(id, w);
    return w;
  }
  const trackCache = new Map();
  function getTrack(id) {
    if (worlds.has(id)) return worlds.get(id).T;
    if (!trackCache.has(id)) trackCache.set(id, SIM.buildTrack(SIM.courseById(id)));
    return trackCache.get(id);
  }
  function getMinimap(id, size) {
    const k = id + ':' + size;
    if (!minimaps.has(k)) {
      const def = SIM.courseById(id);
      minimaps.set(k, RENDER.buildMinimap(getTrack(id), THEMES.get(def.theme), size));
    }
    return minimaps.get(k);
  }
  function getSheetCanvas(design) {
    if (sheetCanvas[design]) return sheetCanvas[design];
    const sh = sheets[design].near.sheet;
    const cv = document.createElement('canvas');
    cv.width = sh.width; cv.height = sh.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sh.pixels.buffer, sh.pixels.byteOffset, sh.width * sh.height * 4), sh.width, sh.height), 0, 0);
    sheetCanvas[design] = { cv, sh };
    return sheetCanvas[design];
  }
  function drawMachine(design, yaw, x, y, sc) {
    const { cv, sh } = getSheetCanvas(design);
    const f = sh.frame(((yaw % 32) + 32) % 32, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, f.sx, f.sy, sh.frameW, sh.frameH, Math.round(x - sh.anchorX * sc), Math.round(y - sh.anchorY * sc), sh.frameW * sc, sh.frameH * sc);
  }

  function present() { ctx.putImageData(img, 0, 0); }
  function dim(a) { ctx.fillStyle = `rgba(4,6,20,${a})`; ctx.fillRect(0, 0, W, H); }
  function panel(x, y, w, h, a) {
    ctx.fillStyle = `rgba(6,10,30,${a !== undefined ? a : 0.82})`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffd23a';
    ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillStyle = '#3a4a8a';
    ctx.fillRect(x, y + 1, 1, h - 2); ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
  }
  function title(text, sub) {
    ctx.fillStyle = 'rgba(6,10,30,0.85)';
    ctx.fillRect(0, 6, W, 20);
    ctx.fillStyle = '#ffd23a'; ctx.fillRect(0, 26, W, 1);
    FD(ctx, text, 10, 9, { scale: 2, color: '#fff', italic: true, shadow: '#203080' });
    if (sub) FD(ctx, sub, W - 10, 14, { color: '#9fb4d8', align: 'right' });
  }
  function hint(text) {
    if (touchMode()) {
      text = text.replace('X/ENTER:OK', 'A:OK').replace('Z/ESC:BACK', 'B:BACK').replace(/X:/g, 'A:').replace(/Z:/g, 'B:')
        .replace(/ +H:HELP.*$/, '  ?:HELP');
    }
    ctx.fillStyle = 'rgba(6,10,30,0.8)';
    ctx.fillRect(0, H - 13, W, 13);
    FD(ctx, text, W / 2, H - 10, { color: '#9fb4d8', align: 'center' });
  }
  function toast(text) { toastMsg = { text, t: 1.6 }; }
  function drawToast(dt) {
    if (!toastMsg) return;
    toastMsg.t -= dt;
    if (toastMsg.t <= 0) { toastMsg = null; return; }
    const tw = FONT.measure(toastMsg.text);
    ctx.fillStyle = 'rgba(6,10,30,0.92)';
    ctx.fillRect(W / 2 - tw / 2 - 5, 31, tw + 10, 14);
    ctx.fillStyle = '#ffd23a';
    ctx.fillRect(W / 2 - tw / 2 - 5, 44, tw + 10, 1);
    FD(ctx, toastMsg.text, W / 2, 34, { color: '#fff', outline: '#000', align: 'center' });
  }
  function logo(x, y, sc) {
    // banded 16-bit style logo
    const text = 'ZERO-G';
    const bands = [['#fff6c0', 0, 0.35], ['#ffd23a', 0.35, 0.65], ['#ff8a20', 0.65, 1]];
    const w = FONT.measure(text, sc);
    FD(ctx, text, x - w / 2 + 2, y + 2, { scale: sc, color: '#101850', italic: true });
    FD(ctx, text, x - w / 2, y, { scale: sc, color: '#000', italic: true, outline: '#000' });
    for (const [c, a, b] of bands) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y + 8 * sc * a, W, 8 * sc * (b - a));
      ctx.clip();
      FD(ctx, text, x - w / 2, y, { scale: sc, color: c, italic: true });
      ctx.restore();
    }
    ctx.fillStyle = '#ff3a6a';
    ctx.fillRect(x - w / 2 - 6, y + 8 * sc + 3, w + 12, 2);
    ctx.fillStyle = '#4aa3ff';
    ctx.fillRect(x - w / 2 + 8, y + 8 * sc + 6, w - 4, 1);
  }
  function bars(x, y, n, max, col) {
    for (let i = 0; i < max; i++) {
      ctx.fillStyle = i < n ? col : '#232a48';
      ctx.fillRect(x + i * 11, y, 9, 6);
    }
  }

  // ------------------------------------------------------------------
  // Race runtime shared by the race, results and attract views
  // ------------------------------------------------------------------
  function makeRun(world, raceOpts, cfg) {
    const race = SIM.createRace(world.T, raceOpts);
    const cam = RENDER.createCamera();
    const fx = RENDER.createFx();
    const run = { world, race, cam, fx, cfg: cfg || {}, acc: 0, follow: race.player, msgs: [], audible: false, ghost: null, lastLapAt: -9, focusT: 0 };
    if (!run.follow) run.follow = race.cars.find((c) => c.isHero) || race.cars[0];
    RENDER.followCamera(cam, run.follow, 0, true);
    return run;
  }

  function shake(run, p) { if (save.settings.shake && run.audible) run.cam.shake = Math.max(run.cam.shake, p); }
  function msg(run, text, opts) {
    run.msgs.push(Object.assign({ text, t: 0, dur: 2, scale: 3, color: '#ffd23a', y: 70 }, opts || {}));
  }

  function handleEvents(run) {
    const race = run.race, fx = run.fx, cam = run.cam;
    const playerOn = run.audible && race.player && race.opts.mode !== 'attract';
    for (const e of race.events) {
      const c = e.car >= 0 ? race.cars[e.car] : null;
      const isP = playerOn && c && c.isPlayer;
      const dx = e.x - cam.x, dy = e.y - cam.y;
      const near = dx * dx + dy * dy < 900 * 900;
      switch (e.type) {
        case 'spark':
          if (near) RENDER.burst(fx, 'spark', e.x, e.y, 3, 3, { speed: 70, vz: 45, life: 0.35, size: 0.7, g: 220 });
          break;
        case 'wallHit':
          if (near) RENDER.burst(fx, 'spark', e.x, e.y, 3, 12, { speed: 110, vz: 70, life: 0.45, size: 0.8, g: 260 });
          if (isP) { AUDIO.sfx('wallHit', { power: e.power }); shake(run, 0.4 + e.power); }
          break;
        case 'carHit': {
          const o = race.cars[e.other];
          if (near) RENDER.burst(fx, 'spark', e.x, e.y, 3, 10, { speed: 100, vz: 60, life: 0.4, size: 0.8, g: 240 });
          if (playerOn && (c.isPlayer || (o && o.isPlayer))) {
            const other = c.isPlayer ? o : c;
            const rel = Math.atan2(other.y - cam.y, other.x - cam.x) - cam.th;
            AUDIO.sfx('carHit', { power: e.power, pan: clamp(Math.sin(rel) * 2, -1, 1) });
            shake(run, 0.3 + e.power);
          }
          break;
        }
        case 'boost':
          if (isP) { AUDIO.sfx('boost'); shake(run, 0.5); msg(run, 'BOOST!!', { dur: 1.1, scale: 2, color: '#ff8a20', y: 96 }); }
          break;
        case 'rocket':
          if (isP) { AUDIO.sfx('dash'); msg(run, 'ROCKET START!', { dur: 1.4, scale: 2, color: '#3cf0c0', y: 96 }); }
          break;
        case 'dash':
          if (isP) AUDIO.sfx('dash');
          if (near) RENDER.burst(fx, 'trail', c.x, c.y, 2, 6, { speed: 30, vz: 20, life: 0.4, size: 1.2, g: 0 });
          break;
        case 'jump':
          if (isP) AUDIO.sfx('jump');
          break;
        case 'land':
          if (isP) { AUDIO.sfx('land'); shake(run, 0.3 + e.power); }
          if (near) RENDER.burst(fx, 'dust', c.x, c.y, 1, 8, { speed: 50, vz: 30, life: 0.5, size: 1.5, g: 80 });
          break;
        case 'mine':
          if (near) {
            RENDER.burst(fx, 'fire', e.x, e.y, 3, 14, { speed: 50, vz: 50, life: 0.6, size: 3, grow: 6, g: -10 });
            RENDER.burst(fx, 'smoke', e.x, e.y, 5, 8, { speed: 25, vz: 25, life: 1.2, size: 3, grow: 5, g: -8 });
          }
          if (run.audible && near && dx * dx + dy * dy < 500 * 500) AUDIO.sfx('mine');
          if (isP) shake(run, 1.2);
          break;
        case 'explode':
          if (near) {
            RENDER.burst(fx, 'fire', e.x, e.y, 4, 34, { speed: 90, vz: 70, life: 0.8, size: 3.5, grow: 8, g: -20 });
            RENDER.burst(fx, 'smoke', e.x, e.y, 6, 18, { speed: 40, vz: 40, life: 1.8, size: 4, grow: 7, g: -10 });
            RENDER.burst(fx, 'debris', e.x, e.y, 4, 16, { speed: 140, vz: 120, life: 1.2, size: 1.4, g: 260 });
            RENDER.burst(fx, 'spark', e.x, e.y, 4, 24, { speed: 160, vz: 120, life: 0.6, size: 0.8, g: 260 });
          }
          if (run.audible && near) AUDIO.sfx('explode');
          if (isP) { fx.flash = 0.9; fx.flashCol = 0xffffffff; shake(run, 2); }
          break;
        case 'fall':
          if (isP) AUDIO.sfx('retire');
          break;
        case 'go':
          if (run.audible) AUDIO.sfx('go');
          if (playerOn) msg(run, 'GO!!', { dur: 1.1, scale: 6, color: '#3cf0c0', y: 66, big: true });
          break;
        case 'lap':
          if (isP) {
            run.lastLapAt = time;
            const final = c.lapsDone === race.laps - 1;
            if (final) { AUDIO.sfx('finalLap'); AUDIO.bgmTempo(1.1); msg(run, 'FINAL LAP', { dur: 2.4, scale: 3, color: '#ff5a5a' }); }
            else { AUDIO.sfx('lap'); msg(run, `LAP ${c.lapsDone + 1}`, { dur: 1.8, scale: 3 }); }
            msg(run, SIM.fmtTime(e.time), { dur: 2.2, scale: 2, color: '#fff', y: 98 });
          }
          break;
        case 'boostReady':
          if (isP) { AUDIO.sfx('boostReady'); if (c.lapsDone === 1) msg(run, 'BOOST READY', { dur: 1.8, scale: 1, color: '#ff8a20', y: 118 }); }
          break;
        case 'rankOut':
          if (isP) AUDIO.sfx('rankOut');
          break;
        case 'finish':
          if (isP) { AUDIO.sfx('goal'); AUDIO.bgmTempo(1); }
          break;
        default:
          break;
      }
    }
    race.events.length = 0;
  }

  // per-frame spawn probability p at 60 fps, scaled to the real frame time
  const chance = (p, dt) => Math.random() < 1 - Math.pow(1 - p, dt * 60);

  function ambientFx(run, dt) {
    const race = run.race, fx = run.fx, cam = run.cam;
    for (const c of race.cars) {
      const dx = c.x - cam.x, dy = c.y - cam.y;
      if (dx * dx + dy * dy > 700 * 700) continue;
      if (c.retired) {
        if (c.boomT >= 0 && c.boomT < 2 && chance(0.4, dt)) RENDER.spawn(fx, 'smoke', c.x, c.y, 3, { speed: 10, vz: 30, life: 1.4, size: 3, grow: 5, g: -5 });
        continue;
      }
      const fxv = Math.cos(c.th), fyv = Math.sin(c.th);
      if ((c.boostT > 0 || c.dashT > 0) && chance(0.8, dt)) {
        RENDER.spawn(fx, 'trail', c.x - fxv * 11, c.y - fyv * 11, c.z + 2.5, { speed: 12, vz: 4, life: 0.25, size: 0.6, g: 0, vx: c.vx * 0.3, vy: c.vy * 0.3 });
      }
      if (c.onRough && c.speed > 70 && chance(0.7, dt)) {
        RENDER.spawn(fx, 'dust', c.x - fxv * 8, c.y - fyv * 8, 1, { speed: 25, vz: 25, life: 0.6, size: 1.6, grow: 2, g: 60 });
      }
      if (c.onIce && c.speed > 120 && chance(0.25, dt)) {
        RENDER.spawn(fx, 'ice', c.x - fxv * 8, c.y - fyv * 8, 1, { speed: 20, vz: 20, life: 0.4, size: 0.8, g: 100 });
      }
      if (c.onPit && c.energy < SIM.ENERGY_MAX && chance(0.8, dt)) {
        RENDER.spawn(fx, 'pit', c.x + (Math.random() - 0.5) * 16, c.y + (Math.random() - 0.5) * 16, 2, { speed: 6, vz: 40, life: 0.6, size: 0.8, g: -10, vx: c.vx * 0.9, vy: c.vy * 0.9 });
      }
      if (c.energy < 15 && chance(0.25, dt)) {
        RENDER.spawn(fx, 'smoke', c.x - fxv * 6, c.y - fyv * 6, 3, { speed: 6, vz: 18, life: 0.9, size: 1.6, grow: 4, g: -5, vx: c.vx * 0.5, vy: c.vy * 0.5 });
      }
    }
    RENDER.updateFx(fx, dt);
    RENDER.updateWeather(fx, run.world.theme.weather, cam, dt, run.follow ? run.follow.speed : 0);
  }

  // advance the simulation with a fixed step; inputFn sets the player input
  // Render state is interpolated between the last two 120 Hz sim ticks so motion
  // stays smooth on 75/90/144/165 Hz displays.
  const PROXY = { x: 0, y: 0, z: 0, th: 0, vx: 0, vy: 0, speed: 0, retired: null };
  function lerpCar(c, a, out) {
    const has = c.ix !== undefined;
    out.x = has ? c.ix + (c.x - c.ix) * a : c.x;
    out.y = has ? c.iy + (c.y - c.iy) * a : c.y;
    out.z = has ? c.iz + (c.z - c.iz) * a : c.z;
    out.th = has ? c.ith + wrapA(c.th - c.ith) * a : c.th;
    return out;
  }
  function tickRun(run, dt, inputFn) {
    run.acc += Math.min(dt, 0.1);
    let n = 0;
    while (run.acc >= SIM.DT && n < 14) {
      for (const c of run.race.cars) { c.ix = c.x; c.iy = c.y; c.iz = c.z; c.ith = c.th; }
      if (inputFn) inputFn(run);
      SIM.step(run.race);
      run.acc -= SIM.DT;
      n++;
    }
    if (n >= 14) run.acc = 0;
    run.alpha = clamp(run.acc / SIM.DT, 0, 1);
    handleEvents(run);
    if (run.follow) {
      const f = run.follow;
      lerpCar(f, run.alpha, PROXY);
      PROXY.vx = f.vx; PROXY.vy = f.vy; PROXY.speed = f.speed; PROXY.retired = f.retired;
      RENDER.followCamera(run.cam, PROXY, dt, false);
    }
    ambientFx(run, dt);
  }

  const SAVED = [];
  function drawRun(run, extra, dtOverride) {
    const p = run.follow;
    const dt = dtOverride !== undefined ? dtOverride : frameDt;
    const opts = { dt };
    if (p && (p.boostT > 0 || p.dashT > 0) && !p.retired) opts.streaks = p.boostT > 0 ? 0.8 : 0.45;
    const a = run.alpha !== undefined ? run.alpha : 1;
    if (run.ghost && run.race.phase === 'run') {
      const g = SIM.ghostAt(run.ghost.data, Math.max(0, run.race.t - (1 - a) * SIM.DT));
      if (g) { opts.ghost = g; opts.ghostDesign = run.ghost.m; }
    }
    if (extra) Object.assign(opts, extra);
    const cars = run.race.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const sv = SAVED[i] || (SAVED[i] = {});
      sv.x = c.x; sv.y = c.y; sv.z = c.z; sv.th = c.th;
      lerpCar(c, a, c);
    }
    RENDER.renderWorld(view, run.world, run.cam, run.race, sheets, run.fx, opts);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], sv = SAVED[i];
      c.x = sv.x; c.y = sv.y; c.z = sv.z; c.th = sv.th;
    }
    present();
  }

  function drawMsgs(run, dt) {
    let w = 0;
    for (const m of run.msgs) {
      m.t += dt;
      if (m.t > m.dur) continue;
      const k = Math.min(1, m.t * 8);
      const blink = m.blink && ((time * 6) | 0) & 1;
      if (!blink) {
        ctx.save();
        const tw = FONT.measure(m.text, m.scale);
        ctx.beginPath();
        ctx.rect(W / 2 - (tw / 2 + 8) * k, 0, (tw + 16) * k, H);
        ctx.clip();
        FD(ctx, m.text, W / 2, m.y, { scale: m.scale, color: m.color, outline: '#000', shadow: '#101850', italic: true, align: 'center' });
        ctx.restore();
      }
      run.msgs[w++] = m;
    }
    run.msgs.length = w;
  }

  // ------------------------------------------------------------------
  // Background attract race (behind every menu)
  // ------------------------------------------------------------------
  const bg = { run: null, world: null, switchT: 0 };
  function startAttract(id) {
    const world = getWorld(id);
    bg.world = world;
    bg.run = makeRun(world, { mode: 'attract', playerMachine: null, difficulty: 'standard', seed: (Math.random() * 1e6) | 0, countdown: 0.05 });
    const heroes = bg.run.race.cars.filter((c) => c.isHero);
    bg.run.follow = heroes[(Math.random() * heroes.length) | 0];
    RENDER.followCamera(bg.run.cam, bg.run.follow, 0, true);
    bg.switchT = 10;
  }
  function updateAttract(dt) {
    if (!bg.run) return;
    const r = bg.run.race;
    tickRun(bg.run, dt, null);
    bg.switchT -= dt;
    if (bg.switchT <= 0 || bg.run.follow.retired) {
      const pool = r.cars.filter((c) => !c.retired && c !== bg.run.follow);
      const leaders = pool.filter((c) => c.rank <= 8);
      const pickFrom = leaders.length ? leaders : pool;
      if (pickFrom.length) {
        bg.run.follow = pickFrom[(Math.random() * pickFrom.length) | 0];
        RENDER.followCamera(bg.run.cam, bg.run.follow, 0, true);
      }
      bg.switchT = 9;
    }
    if (r.doneT >= 0 || r.t > 100) startAttract(bg.world.T.id);
  }
  function drawAttract(d) {
    if (!bg.run) { ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, W, H); return; }
    drawRun(bg.run);
    if (d) dim(d);
  }

  // ------------------------------------------------------------------
  // Scenes
  // ------------------------------------------------------------------
  let scene = null;
  function go(s) {
    heldAtEnter = new Set(keys);
    if (scene && scene.leave) scene.leave();
    scene = s;
    if (s.enter) s.enter();
  }
  function stopRaceAudio() {
    AUDIO.engine(null); AUDIO.scrape(0); AUDIO.pit(false); AUDIO.alarm(false); AUDIO.wind(0);
  }

  // generic vertical menu
  function menu(items, sel, x, y, opts) {
    const o = opts || {};
    const gap = o.gap || 13;
    items.forEach((it, i) => {
      const yy = y + i * gap;
      const on = i === sel;
      const label = typeof it === 'string' ? it : it.label;
      const dis = typeof it === 'object' && it.disabled;
      if (on) {
        ctx.fillStyle = 'rgba(255,210,58,0.18)';
        ctx.fillRect(x - (o.w || 120) / 2, yy - 2, o.w || 120, 11);
        FD(ctx, '▶', x - (o.w || 120) / 2 + 3, yy, { color: ((time * 4) | 0) & 1 ? '#ffd23a' : '#ff8a20' });
      }
      FD(ctx, label, x, yy, { color: dis ? '#4a5070' : on ? '#fff' : '#9fb4d8', align: 'center', shadow: '#000', italic: on });
    });
  }
  function moveSel(sel, n) {
    if (hit('up')) { AUDIO.sfx('menuMove'); return (sel + n - 1) % n; }
    if (hit('down')) { AUDIO.sfx('menuMove'); return (sel + 1) % n; }
    return sel;
  }

  // ---- title -------------------------------------------------------
  function TitleScene() {
    const items = ['GRAND PRIX', 'FREE RACE', 'TIME ATTACK', 'RECORDS', 'OPTIONS'];
    let sel = 0, t = 0, armed = unlocked;
    return {
      enter() {
        if (unlocked) AUDIO.bgm('title');
        stopRaceAudio();
        if (lastRaceCourse && worlds.has(lastRaceCourse) && bg.world && bg.world.T.id !== lastRaceCourse) startAttract(lastRaceCourse);
      },
      onUnlock() { AUDIO.bgm('title'); },
      update(dt) {
        t += dt;
        updateAttract(dt);
        if (!unlocked) return;
        if (!armed) { armed = true; return; } // the unlocking key press is not a menu choice
        sel = moveSel(sel, items.length);
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          if (sel === 0) go(CupScene());
          else if (sel === 1) go(MachineScene({ mode: 'free' }));
          else if (sel === 2) go(MachineScene({ mode: 'ta' }));
          else if (sel === 3) go(RecordsScene());
          else go(OptionsScene());
        }
      },
      draw(dt) {
        drawAttract(0.35);
        logo(W / 2, 22, 6);
        FD(ctx, 'GRAND PRIX', W / 2, 78, { scale: 2, color: '#fff', align: 'center', italic: true, outline: '#101850' });
        if (!unlocked) {
          if (((t * 2) | 0) & 1) FD(ctx, 'PRESS ANY KEY', W / 2, 140, { scale: 2, color: '#ffd23a', align: 'center', outline: '#000' });
          FD(ctx, 'OR CLICK / TAP / GAMEPAD', W / 2, 162, { color: '#9fb4d8', align: 'center', shadow: '#000' });
        } else {
          panel(W / 2 - 80, 104, 160, 74, 0.72);
          menu(items, sel, W / 2, 112, { w: 150 });
        }
        hint('X/ENTER:OK  Z/ESC:BACK  H:HELP  M:MUTE  F:FULL');
      },
    };
  }

  // ---- GP cup & class ---------------------------------------------
  const DIFFS = ['beginner', 'standard', 'master'];
  function trophyIcon(x, y, place) {
    const col = place === 1 ? '#ffd23a' : place === 2 ? '#d0d8e8' : place === 3 ? '#d08040' : '#2a3050';
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 7, 4); ctx.fillRect(x + 2, y + 4, 3, 2); ctx.fillRect(x + 1, y + 6, 5, 2);
    ctx.fillRect(x - 1, y, 1, 3); ctx.fillRect(x + 7, y, 1, 3);
  }
  function CupScene() {
    let sel = 0;
    let diff = Math.max(0, DIFFS.indexOf(save.settings.difficulty));
    return {
      enter() { AUDIO.bgm('select'); },
      update(dt) {
        updateAttract(dt);
        sel = moveSel(sel, SIM.CUPS.length);
        if (hit('left')) { diff = (diff + 2) % 3; AUDIO.sfx('menuMove'); }
        if (hit('right')) { diff = (diff + 1) % 3; AUDIO.sfx('menuMove'); }
        if (hit('back')) { AUDIO.sfx('menuBack'); go(TitleScene()); return; }
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          save.settings.difficulty = DIFFS[diff];
          persist();
          go(MachineScene({ mode: 'gp', cup: SIM.CUPS[sel], difficulty: DIFFS[diff] }));
        }
      },
      draw() {
        drawAttract(0.55);
        title('GRAND PRIX', 'SELECT CUP');
        SIM.CUPS.forEach((cup, i) => {
          const y = 38 + i * 46;
          const on = i === sel;
          panel(24, y, W - 48, 40, on ? 0.9 : 0.6);
          if (on) { ctx.fillStyle = '#ffd23a'; ctx.fillRect(24, y, 3, 40); }
          FD(ctx, cup.name, 36, y + 6, { scale: 2, color: on ? '#fff' : '#9fb4d8', italic: true, shadow: '#000' });
          const list = cup.courses.length > 3 ? `ALL ${cup.courses.length} COURSES IN A ROW` : cup.courses.map((id) => SIM.courseById(id).name).join(' / ');
          FD(ctx, list, 36, y + 27, { color: on ? '#ffd23a' : '#6a7090' });
          const tr = save.trophies[cup.id] || {};
          DIFFS.forEach((d, j) => {
            trophyIcon(W - 82 + j * 18, y + 4, tr[d] || 0);
            FD(ctx, d[0].toUpperCase(), W - 82 + j * 18, y + 14, { color: '#6a7090' });
          });
        });
        const dl = SIM.DIFFICULTY[DIFFS[diff]].label;
        panel(W / 2 - 90, H - 34, 180, 18, 0.9);
        FD(ctx, `◀ CLASS: ${dl} ▶`, W / 2, H - 29, { color: '#3cf0c0', align: 'center' });
        hint('↑↓ CUP  ←→ CLASS  X:OK  Z:BACK');
      },
    };
  }

  // ---- machine select -------------------------------------------------
  function MachineScene(cfg) {
    let sel = Math.max(0, SIM.HERO_KEYS.indexOf(save.settings.machine));
    let t = 0;
    return {
      enter() { AUDIO.bgm('select'); },
      update(dt) {
        t += dt;
        updateAttract(dt);
        if (hit('left')) { sel = (sel + 3) % 4; AUDIO.sfx('menuMove'); t = 0; }
        if (hit('right')) { sel = (sel + 1) % 4; AUDIO.sfx('menuMove'); t = 0; }
        if (hit('back')) { AUDIO.sfx('menuBack'); go(cfg.mode === 'gp' ? CupScene() : TitleScene()); return; }
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          const key = SIM.HERO_KEYS[sel];
          save.settings.machine = key;
          persist();
          const next = Object.assign({}, cfg, { machine: key });
          if (cfg.mode === 'gp') startGP(next);
          else go(CourseScene(next));
        }
      },
      draw() {
        drawAttract(0.6);
        title('SELECT MACHINE', cfg.mode === 'gp' ? cfg.cup.name : cfg.mode === 'ta' ? 'TIME ATTACK' : 'FREE RACE');
        const key = SIM.HERO_KEYS[sel];
        const m = SIM.MACHINES[key];
        // tabs
        SIM.HERO_KEYS.forEach((k, i) => {
          const x = 26 + i * 88, on = i === sel;
          panel(x, 32, 80, 14, on ? 0.95 : 0.5);
          if (on) { ctx.fillStyle = HERO_COL[k]; ctx.fillRect(x + 1, 44, 78, 2); }
          FD(ctx, SIM.MACHINES[k].name.split(' ')[1], x + 40, 35, { color: on ? '#fff' : '#6a7090', align: 'center' });
        });
        // showcase
        panel(14, 52, 180, 132, 0.55);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(104, 150, 62, 14, 0, 0, Math.PI * 2); ctx.fill();
        drawMachine(key, Math.floor(t * 7) + 4, 104, 138, 1);
        FD(ctx, '◀', 20, 112, { color: '#ffd23a', scale: 2 });
        FD(ctx, '▶', 172, 112, { color: '#ffd23a', scale: 2 });
        // stats
        panel(196, 52, 182, 132, 0.85);
        FD(ctx, m.name, 204, 60, { scale: 2, color: HERO_COL[key], italic: true, shadow: '#000' });
        FD(ctx, 'PILOT ' + m.pilot, 204, 80, { color: '#9fb4d8' });
        const rows = [['SPEED', m.bars.speed], ['ACCEL', m.bars.accel], ['GRIP', m.bars.grip], ['BODY', m.bars.body]];
        rows.forEach(([lbl, v], i) => {
          FD(ctx, lbl, 204, 98 + i * 14, { color: '#fff' });
          bars(256, 99 + i * 14, v, 5, HERO_COL[key]);
        });
        FD(ctx, `${Math.round(m.vmax * SIM.KMH)} km/h`, 204, 156, { color: '#ffd23a' });
        FD(ctx, m.desc, 204, 168, { color: '#3cf0c0' });
        hint('←→ MACHINE  X:OK  Z:BACK');
      },
    };
  }

  // ---- course select (free / time attack) -----------------------------
  function CourseScene(cfg) {
    let sel = Math.max(0, SIM.COURSES.findIndex((c) => c.id === save.settings.course));
    let diff = Math.max(0, DIFFS.indexOf(save.settings.difficulty));
    const ghostKnown = {};
    const hasGhost = (id) => {
      if (!(id in ghostKnown)) {
        try { ghostKnown[id] = localStorage.getItem('zerogp.ghost.' + id) !== null; } catch (e) { ghostKnown[id] = false; }
      }
      return ghostKnown[id];
    };
    return {
      enter() { AUDIO.bgm('select'); },
      update(dt) {
        updateAttract(dt);
        const n = SIM.COURSES.length;
        if (hit('left')) { sel = (sel + n - 1) % n; AUDIO.sfx('menuMove'); }
        if (hit('right')) { sel = (sel + 1) % n; AUDIO.sfx('menuMove'); }
        if (cfg.mode === 'free') {
          if (hit('up')) { diff = (diff + 2) % 3; AUDIO.sfx('menuMove'); }
          if (hit('down')) { diff = (diff + 1) % 3; AUDIO.sfx('menuMove'); }
        }
        if (hit('back')) { AUDIO.sfx('menuBack'); go(MachineScene({ mode: cfg.mode })); return; }
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          const id = SIM.COURSES[sel].id;
          save.settings.course = id;
          save.settings.difficulty = DIFFS[diff];
          persist();
          go(LoadingScene(Object.assign({}, cfg, { courseId: id, difficulty: DIFFS[diff] })));
        }
      },
      draw() {
        drawAttract(0.6);
        title(cfg.mode === 'ta' ? 'TIME ATTACK' : 'FREE RACE', 'SELECT COURSE');
        const def = SIM.COURSES[sel];
        const theme = THEMES.get(def.theme);
        const T = getTrack(def.id);
        panel(14, 34, 150, 150, 0.85);
        const mm = getMinimap(def.id, 140);
        ctx.drawImage(mm.canvas, 19, 39);
        panel(172, 34, 208, 150, 0.85);
        FD(ctx, `COURSE ${sel + 1}`, 180, 42, { color: '#9fb4d8' });
        FD(ctx, def.name, 180, 54, { scale: 2, color: '#fff', italic: true, shadow: '#000' });
        FD(ctx, theme.name, 180, 74, { color: theme.palette.hudAccent || '#ffd23a' });
        FD(ctx, `LENGTH ${(T.L * SIM.KMH / 3600).toFixed(2)} km`, 180, 88, { color: '#fff' });
        const feats = [];
        if (T.dash.length) feats.push('DASH');
        if (T.jump.length) feats.push('JUMP');
        if (T.zones.some((z) => z.type === 'rough')) feats.push('ROUGH');
        if (T.zones.some((z) => z.type === 'ice')) feats.push('ICE');
        if (T.zones.some((z) => z.type === 'wind')) feats.push('WIND');
        if (T.mines.length) feats.push('MINES');
        FD(ctx, feats.join(' '), 180, 100, { color: '#3cf0c0' });
        const rec = save.rec[def.id] || {};
        FD(ctx, 'BEST LAP', 180, 118, { color: '#ffd23a' });
        FD(ctx, rec.lap ? `${SIM.fmtTime(rec.lap)} ${SIM.MACHINES[rec.lapM] ? SIM.MACHINES[rec.lapM].name : ''}` : "-'--\"--", 180, 128, { color: '#fff' });
        FD(ctx, 'BEST TIME', 180, 142, { color: '#ffd23a' });
        FD(ctx, rec.total ? `${SIM.fmtTime(rec.total)} ${SIM.MACHINES[rec.totalM] ? SIM.MACHINES[rec.totalM].name : ''}` : "-'--\"--", 180, 152, { color: '#fff' });
        if (cfg.mode === 'free') FD(ctx, `CLASS ↑↓ ${SIM.DIFFICULTY[DIFFS[diff]].label}`, 180, 168, { color: '#3cf0c0' });
        else FD(ctx, hasGhost(def.id) ? 'GHOST: ON' : 'GHOST: NONE', 180, 168, { color: '#3cf0c0' });
        FD(ctx, '◀', 4, 104, { color: '#ffd23a' });
        FD(ctx, '▶', W - 7, 104, { color: '#ffd23a' });
        hint(cfg.mode === 'free' ? '←→ COURSE  ↑↓ CLASS  X:OK  Z:BACK' : '←→ COURSE  X:OK  Z:BACK');
      },
    };
  }

  // ---- loading ----------------------------------------------------------
  function LoadingScene(cfg) {
    let frames = 0;
    return {
      enter() { stopRaceAudio(); },
      update() {
        frames++;
        if (frames === 3) {
          getWorld(cfg.courseId);
          go(RaceScene(cfg));
        }
      },
      draw() {
        ctx.fillStyle = '#05061a';
        ctx.fillRect(0, 0, W, H);
        const def = SIM.courseById(cfg.courseId);
        FD(ctx, def.name, W / 2, 86, { scale: 2, color: '#fff', align: 'center', italic: true });
        FD(ctx, 'LOADING...', W / 2, 112, { color: '#ffd23a', align: 'center' });
      },
    };
  }

  // ---- GP state ----------------------------------------------------------
  let gp = null;
  let lastRaceCourse = null;
  function startGP(cfg) {
    gp = { cup: cfg.cup, difficulty: cfg.difficulty, machine: cfg.machine, idx: 0, points: {}, spares: 3, lastPos: null };
    go(LoadingScene({ mode: 'gp', courseId: gp.cup.courses[0], machine: gp.machine, difficulty: gp.difficulty }));
  }
  function gpNextRaceCfg() {
    return { mode: 'gp', courseId: gp.cup.courses[gp.idx], machine: gp.machine, difficulty: gp.difficulty };
  }

  // ---- race ------------------------------------------------------------------
  function playerInput(run) {
    const p = run.race.player;
    if (!p || p.finished || p.retired) return;
    const inp = p.input;
    // digital steering from keys / d-pad / touch; the analog stick stays proportional
    const L = KEYMAP.left.some((k) => keys.has(k)) || pad.dl || !!touch.held.left;
    const R = KEYMAP.right.some((k) => keys.has(k)) || pad.dr || !!touch.held.right;
    let steer = (R ? 1 : 0) - (L ? 1 : 0);
    if (!L && !R && pad.steer) steer = pad.steer;
    inp.steer = steer;
    // touch auto-accel only once racing, so A during the countdown still times a rocket start
    const auto = touchMode() && save.settings.touchAuto && run.race.phase === 'run';
    inp.throttle = held('accel') || (auto && !held('brake')) ? 1 : 0;
    inp.brake = held('brake') ? 1 : 0;
    inp.lean = (held('leanR') ? 1 : 0) - (held('leanL') ? 1 : 0);
    inp.boost = held('boost') ? 1 : 0;
  }

  function RaceScene(cfg) {
    const def = SIM.courseById(cfg.courseId);
    let run, state = 'intro', st = 0, lastCount = 99, pauseSel = 0, outReason = null;
    const mm = getMinimap(cfg.courseId, 58);
    const mmT = getMinimap(cfg.courseId, 44); // touch layout: small map under the clock
    const raceNo = cfg.mode === 'gp' ? gp.idx + 1 : 0;
    const pauseItems = () => (cfg.mode === 'gp' ? ['CONTINUE', 'GIVE UP'] : ['CONTINUE', 'RETRY', 'QUIT']);
    function setupRun() {
      const world = getWorld(cfg.courseId);
      run = makeRun(world, {
        mode: cfg.mode, playerMachine: cfg.machine, difficulty: cfg.difficulty || 'standard',
        seed: ((cfg.courseId.length * 7919 + (gp ? gp.idx * 131 : 0) + Math.floor(Math.random() * 1000)) | 0),
        playerSlot: cfg.mode === 'gp' ? (gp.lastPos ? clamp(gp.lastPos + 3, 3, 12) : 11) : cfg.mode === 'ta' ? 0 : 9,
      }, cfg);
      run.audible = true;
      if (cfg.mode === 'ta') run.ghost = loadGhost(cfg.courseId);
      run.follow = run.race.player;
    }
    function introCam() {
      const p = run.race.player;
      const k = clamp(st / 3.2, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const th = p.th + (1 - e) * 2.6;
      const dist = lerp(300, RENDER.CAM_D, e);
      run.cam.th = th;
      run.cam.x = p.x - Math.cos(th) * dist;
      run.cam.y = p.y - Math.sin(th) * dist;
      run.cam.h = lerp(150, RENDER.CAM_H, e);
    }
    function endRace() {
      stopRaceAudio();
      const res = recordRace(cfg, run.race);
      go(ResultsScene(cfg, run, res));
    }
    return {
      get run() { return run; },
      enter() {
        lastRaceCourse = cfg.courseId;
        setupRun();
        AUDIO.bgm(def.bgm);
        AUDIO.bgmTempo(1);
        introCam();
      },
      leave() { stopRaceAudio(); },
      onHide() { stopRaceAudio(); if (state === 'run') { state = 'pause'; pauseSel = 0; } },
      update(dt) {
        const race = run.race, p = race.player;
        if (state === 'intro') {
          st += dt;
          introCam();
          RENDER.updateFx(run.fx, dt);
          RENDER.updateWeather(run.fx, run.world.theme.weather, run.cam, dt, 0);
          if (st > 3.4 || hit('ok') || hit('pause')) {
            state = 'run';
            RENDER.followCamera(run.cam, p, 0, true);
          }
          return;
        }
        if (state === 'pause') {
          const items = pauseItems();
          pauseSel = moveSel(pauseSel, items.length);
          if (!hit('ok') && (hit('back') || hit('pause'))) { state = 'run'; return; }
          if (hit('ok')) {
            const it = items[pauseSel];
            AUDIO.sfx('menuSelect');
            if (it === 'CONTINUE') state = 'run';
            else if (it === 'RETRY') go(LoadingScene(cfg));
            else if (it === 'QUIT') { go(TitleScene()); }
            else if (it === 'GIVE UP') { recordRace(cfg, run.race); go(RetryScene('GIVE UP')); }
          }
          return;
        }
        if (hit('pause') && !p.finished && !p.retired) {
          state = 'pause'; pauseSel = 0;
          AUDIO.sfx('pause');
          stopRaceAudio();
          return;
        }
        tickRun(run, dt, playerInput);
        // countdown beeps
        if (race.phase === 'countdown') {
          const n = Math.ceil(race.count);
          if (n <= 3 && n >= 1 && n !== lastCount) { AUDIO.sfx('count'); lastCount = n; }
        }
        // audio
        if (!p.retired && !p.finished) {
          const sp = Math.max(0, p.vf) / p.m.vmax;
          AUDIO.engine({ speed: race.phase === 'run' ? sp : (p.input.throttle ? 0.35 : 0.05), throttle: p.input.throttle, boost: p.boostT > 0 || p.dashT > 0, air: p.z > 0.5, machine: p.key });
          AUDIO.scrape(p.scrapeT > 0 ? clamp(p.speed / 260, 0.2, 1) : 0);
          AUDIO.pit(p.onPit && p.energy < SIM.ENERGY_MAX && race.phase === 'run');
          AUDIO.alarm(p.energy <= 25 && race.phase === 'run');
          AUDIO.wind(p.wind ? 0.7 : 0);
        } else if (p.finished) {
          AUDIO.engine({ speed: Math.max(0, p.vf) / p.m.vmax, throttle: 1, boost: false, air: false, machine: p.key });
          AUDIO.scrape(0); AUDIO.pit(false); AUDIO.alarm(false); AUDIO.wind(0);
        } else stopRaceAudio();
        // end conditions
        if (state === 'run' && p.finished) {
          state = 'after'; st = 0;
          run.msgs.length = 0;
          msg(run, 'GOAL!!', { dur: 3.5, scale: 5, color: '#ffd23a', y: 58 });
          msg(run, ORD(p.place), { dur: 3.5, scale: 3, color: p.place <= 3 ? '#3cf0c0' : '#fff', y: 104 });
        } else if (state === 'run' && p.retired) {
          state = 'after'; st = 0;
          run.msgs.length = 0;
          outReason = p.retired;
          const txt = p.retired === 'rankout' ? 'RANK OUT' : p.retired === 'courseout' ? 'COURSE OUT' : 'CRASHED!';
          msg(run, txt, { dur: 3.5, scale: 4, color: '#ff5a5a', y: 70, blink: false });
        }
        if (state === 'after') {
          st += dt;
          if (st > 3.8 || (st > 1.2 && hit('ok'))) {
            if (p.retired && !p.finished && cfg.mode === 'gp') { stopRaceAudio(); recordRace(cfg, run.race); go(RetryScene(outReason)); }
            else endRace();
          }
        }
        // wrong way
        if (p.wrongT > 1.2 && !p.finished && !p.retired && ((time * 3) | 0) % 2 === 0 && !run.msgs.some((m) => m.text === 'WRONG WAY')) {
          msg(run, 'WRONG WAY', { dur: 0.33, scale: 3, color: '#ff5a5a', y: 84 });
        }
      },
      draw(dt) {
        drawRun(run, null, state === 'pause' || state === 'intro' ? 0 : dt);
        const race = run.race, p = race.player;
        if (state === 'intro') {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(0, 150, W, 44);
          ctx.fillStyle = '#ffd23a'; ctx.fillRect(0, 150, W, 1); ctx.fillRect(0, 193, W, 1);
          const sub = cfg.mode === 'gp' ? `${gp.cup.name}  RACE ${raceNo}/${gp.cup.courses.length}` : cfg.mode === 'ta' ? 'TIME ATTACK' : 'FREE RACE';
          FD(ctx, sub, W / 2, 156, { color: '#9fb4d8', align: 'center' });
          FD(ctx, def.name, W / 2, 168, { scale: 2, color: '#fff', align: 'center', italic: true, outline: '#000' });
          if (cfg.mode === 'gp') FD(ctx, `SPARE MACHINES x${gp.spares}`, W / 2, 186 - 2, { color: '#3cf0c0', align: 'center' });
          logo(W / 2, 14, 3);
          return;
        }
        RENDER.drawHUD(ctx, race, p, touchMode() ? mmT : mm, { time, minimap: save.settings.minimap, lastLapAt: run.lastLapAt, touch: touchMode() });
        if (race.phase === 'countdown') {
          const n = Math.ceil(race.count);
          if (n <= 3 && n >= 1) {
            FD(ctx, String(n), W / 2, 60, { scale: 6, color: '#ffd23a', outline: '#000', shadow: '#101850', italic: true, align: 'center' });
          }
          // start lights
          for (let i = 0; i < 3; i++) {
            const on = race.count <= 3 - i;
            ctx.fillStyle = '#000'; ctx.fillRect(W / 2 - 34 + i * 24, 40, 20, 12);
            ctx.fillStyle = on ? '#ff3a3a' : '#401010'; ctx.fillRect(W / 2 - 32 + i * 24, 42, 16, 8);
          }
        }
        drawMsgs(run, dt);
        if (cfg.mode === 'ta' && run.ghost) FD(ctx, 'GHOST', W - 6, touchMode() ? 62 : 50, { color: '#9fb4d8', align: 'right', shadow: '#000' });
        if (state === 'pause') {
          dim(0.55);
          panel(W / 2 - 70, 70, 140, 30 + pauseItems().length * 13, 0.92);
          FD(ctx, 'PAUSE', W / 2, 78, { scale: 2, color: '#ffd23a', align: 'center', italic: true });
          menu(pauseItems(), pauseSel, W / 2, 98, { w: 120 });
        }
      },
    };
  }

  function recordRace(cfg, race) {
    const p = race.player;
    const out = {};
    if (!p) return out;
    const rec = save.rec[cfg.courseId] || (save.rec[cfg.courseId] = {});
    if (p.lapTimes.length) {
      const bl = Math.min(...p.lapTimes);
      if (!rec.lap || bl < rec.lap) { rec.lap = bl; rec.lapM = p.key; out.lap = true; }
    }
    if (p.finished) {
      if (!rec.total || p.finishT < rec.total) { rec.total = p.finishT; rec.totalM = p.key; out.total = true; }
      if (cfg.mode === 'ta') {
        const g = loadGhost(cfg.courseId);
        if (!g || p.finishT < g.t) out.ghost = saveGhost(cfg.courseId, p.key, p.finishT, race.ghostRec);
      }
    }
    persist();
    return out;
  }

  // ---- results ---------------------------------------------------------------
  function ResultsScene(cfg, run, rec) {
    const race = run.race, p = race.player;
    const cls = SIM.classify(race);
    const myPos = cls.findIndex((r) => r.isPlayer) + 1;
    let sel = 0, t = 0;
    let pointsGiven = null;
    let qualified = true;
    if (cfg.mode === 'gp') {
      qualified = p.finished && p.place <= 3;
      if (qualified) {
        pointsGiven = {};
        cls.forEach((r) => {
          const k = r.isHero ? r.key : r.name;
          const pts = SIM.POINTS[r.pos - 1] || 0;
          gp.points[k] = (gp.points[k] || 0) + pts;
          pointsGiven[r.id] = pts;
        });
        gp.lastPos = myPos;
      }
    }
    const items = cfg.mode === 'gp' ? [qualified ? 'NEXT' : 'CONTINUE'] : ['RETRY', 'CHANGE COURSE', 'TITLE'];
    return {
      enter() {
        run.audible = false; // the post-goal autopilot keeps driving silently behind the table
        run.cam.shake = 0;
        AUDIO.bgm('results');
        if (rec.lap || rec.total) AUDIO.sfx('record');
      },
      update(dt) {
        t += dt;
        tickRun(run, dt, null);
        sel = moveSel(sel, items.length);
        if (hit('ok') && t > 0.6) {
          AUDIO.sfx('menuSelect');
          const it = items[sel];
          if (cfg.mode === 'gp') {
            if (!qualified) { go(RetryScene('qualify')); return; }
            go(StandingsScene());
          } else if (it === 'RETRY') go(LoadingScene(cfg));
          else if (it === 'CHANGE COURSE') go(CourseScene({ mode: cfg.mode, machine: cfg.machine }));
          else go(TitleScene());
        }
      },
      draw(dt) {
        drawRun(run);
        dim(0.55);
        title('RESULTS', SIM.courseById(cfg.courseId).name);
        if (cfg.mode === 'ta') {
          panel(20, 34, W - 40, 134, 0.88);
          FD(ctx, p.finished ? 'TOTAL ' + SIM.fmtTime(p.finishT) : 'RETIRED', 34, 44, { scale: 2, color: p.finished ? '#fff' : '#ff5a5a', italic: true });
          if (rec.total && ((t * 3) | 0) & 1) FD(ctx, 'NEW RECORD!', W - 34, 48, { color: '#ffd23a', align: 'right' });
          const best = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
          p.lapTimes.forEach((lt, i) => {
            FD(ctx, `LAP ${i + 1}  ${SIM.fmtTime(lt)}`, 40, 70 + i * 13, { color: lt === best ? '#3cf0c0' : '#9fb4d8' });
          });
          if (rec.lap) FD(ctx, 'BEST LAP RECORD!', W - 34, 70, { color: '#3cf0c0', align: 'right' });
          if (rec.ghost) FD(ctx, 'GHOST SAVED', W - 34, 84, { color: '#9fb4d8', align: 'right' });
          const r = save.rec[cfg.courseId] || {};
          FD(ctx, `RECORD ${SIM.fmtTime(r.total)}`, W - 34, 136, { color: '#ffd23a', align: 'right' });
          FD(ctx, `BEST LAP ${SIM.fmtTime(r.lap)}`, W - 34, 148, { color: '#ffd23a', align: 'right' });
        } else {
          panel(10, 32, 236, 160, 0.88);
          const show = cls.slice(0, 11);
          if (myPos > 11) show[10] = cls[myPos - 1];
          show.forEach((r, i) => {
            const y = 38 + i * 13;
            const mine = r.isPlayer;
            if (mine) { ctx.fillStyle = 'rgba(255,210,58,0.22)'; ctx.fillRect(12, y - 2, 232, 11); }
            const col = mine ? '#fff' : r.isHero ? HERO_COL[r.key] : '#9fb4d8';
            FD(ctx, String(r.pos).padStart(2, ' '), 16, y, { color: r.pos <= 3 ? '#ffd23a' : '#fff' });
            FD(ctx, r.name, 38, y, { color: col });
            const car = race.cars[r.id];
            const tm = car.finished ? car.finishT : null;
            const rt = car.retired || r.retired;
            FD(ctx, tm !== null ? SIM.fmtTime(tm) : rt ? (rt === 'rankout' ? 'RANK OUT' : 'RETIRED') : '--', 128, y, { color: tm !== null ? '#fff' : '#6a7090' });
            if (pointsGiven) FD(ctx, `+${pointsGiven[r.id] || 0}`, 240, y, { color: '#3cf0c0', align: 'right' });
          });
          panel(252, 32, 122, 160, 0.88);
          FD(ctx, 'YOUR RANK', 262, 40, { color: '#9fb4d8' });
          FD(ctx, p.finished ? ORD(myPos) : '--', 262, 52, { scale: 3, color: '#fff', italic: true, outline: '#000' });
          const best = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
          FD(ctx, 'BEST LAP', 262, 86, { color: '#9fb4d8' });
          FD(ctx, SIM.fmtTime(best), 262, 96, { color: rec.lap ? '#3cf0c0' : '#fff' });
          if (rec.lap && ((t * 3) | 0) & 1) FD(ctx, 'NEW RECORD!', 262, 108, { color: '#ffd23a' });
          if (cfg.mode === 'gp') {
            if (!qualified) {
              FD(ctx, 'NOT QUALIFIED', 262, 128, { color: '#ff5a5a' });
              FD(ctx, 'TOP 3 NEEDED', 262, 140, { color: '#9fb4d8' });
            } else {
              FD(ctx, 'QUALIFIED!', 262, 128, { color: '#3cf0c0' });
              FD(ctx, `POINTS ${gp.points[p.key] || 0}`, 262, 140, { color: '#fff' });
            }
          }
        }
        if (cfg.mode === 'ta') {
          panel(W / 2 - 80, H - 44, 160, 8 + items.length * 11, 0.92);
          menu(items, sel, W / 2, H - 40, { w: 150, gap: 11 });
        } else menu(items, sel, 313, 192 - 6 - items.length * 11, { w: 118, gap: 11 });
      },
    };
  }

  // ---- GP standings ------------------------------------------------------------
  function standingsList() {
    const arr = Object.entries(gp.points).map(([k, v]) => ({ k, v, name: SIM.MACHINES[k] ? SIM.MACHINES[k].name : k, isPlayer: k === gp.machine, hero: !!SIM.MACHINES[k] }));
    arr.sort((a, b) => b.v - a.v || (a.isPlayer ? -1 : b.isPlayer ? 1 : 0));
    return arr;
  }
  function StandingsScene() {
    let t = 0;
    const list = standingsList();
    const last = gp.idx >= gp.cup.courses.length - 1;
    return {
      enter() { AUDIO.bgm('results'); },
      update(dt) {
        t += dt;
        updateAttract(dt);
        if (hit('ok') && t > 0.6) {
          AUDIO.sfx('menuSelect');
          if (last) go(ChampionScene());
          else { gp.idx++; go(LoadingScene(gpNextRaceCfg())); }
        }
      },
      draw() {
        drawAttract(0.65);
        title('STANDINGS', `${gp.cup.name} ${gp.idx + 1}/${gp.cup.courses.length}`);
        panel(60, 34, W - 120, 150, 0.9);
        const show = list.slice(0, 10);
        const myI = list.findIndex((r) => r.isPlayer);
        if (myI >= 10) show[9] = list[myI];
        show.forEach((r, i) => {
          const y = 42 + i * 13;
          const pos = list.indexOf(r) + 1;
          if (r.isPlayer) { ctx.fillStyle = 'rgba(255,210,58,0.22)'; ctx.fillRect(62, y - 2, W - 124, 11); }
          FD(ctx, String(pos).padStart(2, ' '), 72, y, { color: pos <= 3 ? '#ffd23a' : '#fff' });
          FD(ctx, r.name, 96, y, { color: r.isPlayer ? '#fff' : r.hero ? HERO_COL[r.k] : '#9fb4d8' });
          FD(ctx, `${r.v} PTS`, W - 72, y, { color: '#3cf0c0', align: 'right' });
        });
        hint(last ? 'X: AWARD CEREMONY' : `X: NEXT RACE - ${SIM.courseById(gp.cup.courses[gp.idx + 1]).name}`);
      },
    };
  }

  // ---- GP retry / game over ----------------------------------------------------
  function RetryScene(reason) {
    gp.spares--;
    const over = gp.spares < 0;
    let sel = 0, t = 0;
    const items = ['TRY AGAIN', 'QUIT'];
    return {
      enter() {
        stopRaceAudio();
        if (over) AUDIO.bgm('gameover');
        else AUDIO.bgm('select');
      },
      update(dt) {
        t += dt;
        updateAttract(dt);
        if (over) {
          if (hit('ok') && t > 1) { go(TitleScene()); gp = null; }
          return;
        }
        sel = moveSel(sel, 2);
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          if (sel === 0) go(LoadingScene(gpNextRaceCfg()));
          else { gp = null; go(TitleScene()); }
        }
      },
      draw() {
        drawAttract(0.7);
        if (over) {
          FD(ctx, 'GAME OVER', W / 2, 80, { scale: 4, color: '#ff5a5a', align: 'center', italic: true, outline: '#000' });
          if (((t * 2) | 0) & 1) FD(ctx, touchMode() ? 'PRESS A' : 'PRESS X', W / 2, 140, { color: '#fff', align: 'center' });
          return;
        }
        const why = reason === 'rankout' ? 'RANK OUT' : reason === 'courseout' ? 'COURSE OUT' : reason === 'qualify' ? 'NOT IN TOP 3' : reason === 'GIVE UP' ? 'GAVE UP' : 'MACHINE DESTROYED';
        FD(ctx, why, W / 2, 50, { scale: 2, color: '#ff5a5a', align: 'center', italic: true, outline: '#000' });
        FD(ctx, 'SPARE MACHINES', W / 2, 82, { color: '#9fb4d8', align: 'center' });
        for (let i = 0; i < Math.max(gp.spares, 0); i++) drawMachine(gp.machine, 4, W / 2 - (gp.spares - 1) * 30 + i * 60, 118, 0.5);
        if (gp.spares === 0) FD(ctx, 'LAST CHANCE!', W / 2, 108, { color: '#ffd23a', align: 'center' });
        panel(W / 2 - 70, 142, 140, 34, 0.9);
        menu(items, sel, W / 2, 148, { w: 120 });
      },
    };
  }

  // ---- champion ---------------------------------------------------------------
  function ChampionScene() {
    let t = 0;
    const list = standingsList();
    const myI = list.findIndex((r) => r.isPlayer);
    const place = myI + 1;
    if (place <= 3) {
      const tr = save.trophies[gp.cup.id] || (save.trophies[gp.cup.id] = {});
      if (!tr[gp.difficulty] || place < tr[gp.difficulty]) tr[gp.difficulty] = place;
      persist();
    }
    const podium = list.slice(0, 3).map((r) => ({ r, design: SIM.MACHINES[r.k] ? r.k : 'drone0' }));
    return {
      enter() { AUDIO.bgm(place <= 3 ? 'champion' : 'results'); },
      update(dt) {
        t += dt;
        updateAttract(dt);
        if (hit('ok') && t > 1.5) { AUDIO.sfx('menuSelect'); gp = null; go(TitleScene()); }
      },
      draw() {
        drawAttract(0.7);
        FD(ctx, place === 1 ? 'CHAMPION!' : place <= 3 ? 'CONGRATULATIONS!' : 'GRAND PRIX OVER', W / 2, 14, { scale: 3, color: '#ffd23a', align: 'center', italic: true, outline: '#000' });
        FD(ctx, `${gp.cup.name} - ${SIM.DIFFICULTY[gp.difficulty].label}`, W / 2, 42, { color: '#9fb4d8', align: 'center' });
        const spots = [[W / 2, 150, 1], [W / 2 - 110, 166, 2], [W / 2 + 110, 176, 3]];
        podium.forEach((p, i) => {
          const [x, y, n] = spots[i];
          ctx.fillStyle = n === 1 ? '#ffd23a' : n === 2 ? '#c8d0e0' : '#d08040';
          ctx.fillRect(x - 40, y, 80, H - y);
          ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x - 40, y + 4, 80, 2);
          FD(ctx, String(n), x, y + 10, { scale: 2, color: '#101850', align: 'center' });
          drawMachine(p.design, Math.floor(t * 6) + i * 10, x, y - 4, 0.75);
          FD(ctx, p.r.name, x, y - 62, { color: p.r.isPlayer ? '#fff' : '#9fb4d8', align: 'center', outline: '#000' });
          FD(ctx, `${p.r.v} PTS`, x, y - 51, { color: '#3cf0c0', align: 'center', outline: '#000' });
        });
        if (place <= 3) {
          const x = W / 2 - 10, y = 56;
          ctx.save(); ctx.translate(x, y); ctx.scale(3, 3); trophyIcon(0, 0, place); ctx.restore();
        } else FD(ctx, `YOUR RANK ${ORD(place)}`, W / 2, 60, { color: '#fff', align: 'center' });
        if (t > 1.5 && ((t * 2) | 0) & 1) hint('X: TITLE');
      },
    };
  }

  // ---- records ------------------------------------------------------------------
  function RecordsScene() {
    return {
      update(dt) {
        updateAttract(dt);
        if (hit('back') || hit('ok')) { AUDIO.sfx('menuBack'); go(TitleScene()); }
      },
      draw() {
        drawAttract(0.65);
        title('RECORDS');
        panel(10, 32, W - 20, 118, 0.9);
        FD(ctx, 'COURSE', 20, 38, { color: '#9fb4d8' });
        FD(ctx, 'BEST LAP', 150, 38, { color: '#9fb4d8' });
        FD(ctx, 'BEST TIME', 262, 38, { color: '#9fb4d8' });
        SIM.COURSES.forEach((c, i) => {
          const r = save.rec[c.id] || {};
          const y = 52 + i * 15;
          FD(ctx, c.name, 20, y, { color: '#fff' });
          FD(ctx, SIM.fmtTime(r.lap), 150, y, { color: r.lap ? '#3cf0c0' : '#4a5070' });
          if (r.lapM) ctx.fillStyle = HERO_COL[r.lapM], ctx.fillRect(140, y + 1, 5, 5);
          FD(ctx, SIM.fmtTime(r.total), 262, y, { color: r.total ? '#3cf0c0' : '#4a5070' });
          if (r.totalM) ctx.fillStyle = HERO_COL[r.totalM], ctx.fillRect(252, y + 1, 5, 5);
        });
        panel(10, 154, W - 20, 44, 0.9);
        FD(ctx, 'TROPHIES', 20, 160, { color: '#9fb4d8' });
        SIM.CUPS.forEach((cup, i) => {
          const x = 20 + i * 120;
          FD(ctx, cup.name, x, 174, { color: '#fff' });
          const tr = save.trophies[cup.id] || {};
          DIFFS.forEach((d, j) => trophyIcon(x + j * 14 + 2, 186, tr[d] || 0));
        });
        hint('Z: BACK');
      },
    };
  }

  // ---- options ------------------------------------------------------------------
  function OptionsScene() {
    let sel = 0, confirm = false;
    const s = () => save.settings;
    const items = () => [
      `MUSIC VOLUME  ${'■'.repeat(Math.round(s().bgm * 10))}${'·'.repeat(10 - Math.round(s().bgm * 10))}`,
      `SFX VOLUME    ${'■'.repeat(Math.round(s().sfx * 10))}${'·'.repeat(10 - Math.round(s().sfx * 10))}`,
      `MINIMAP       ${s().minimap ? 'ON' : 'OFF'}`,
      `SCREEN SHAKE  ${s().shake ? 'ON' : 'OFF'}`,
      `TOUCH AUTO-ACCEL ${s().touchAuto ? 'ON' : 'OFF'}`,
      'CONTROLS',
      confirm ? 'REALLY RESET? (X)' : 'RESET RECORDS',
      'BACK',
    ];
    return {
      update(dt) {
        updateAttract(dt);
        const n = items().length;
        const prev = sel;
        sel = moveSel(sel, n);
        if (sel !== prev) confirm = false;
        const d = hit('left') ? -1 : hit('right') ? 1 : 0;
        if (d) {
          if (sel === 0) { s().bgm = clamp(Math.round((s().bgm + d * 0.1) * 10) / 10, 0, 1); applyVolume(); AUDIO.sfx('menuMove'); }
          if (sel === 1) { s().sfx = clamp(Math.round((s().sfx + d * 0.1) * 10) / 10, 0, 1); applyVolume(); AUDIO.sfx('menuMove'); }
          if (sel === 2) s().minimap = !s().minimap;
          if (sel === 3) s().shake = !s().shake;
          if (sel === 4) s().touchAuto = !s().touchAuto;
          persist();
        }
        if (hit('back')) { AUDIO.sfx('menuBack'); go(TitleScene()); return; }
        if (hit('ok')) {
          AUDIO.sfx('menuSelect');
          if (sel === 2) s().minimap = !s().minimap;
          else if (sel === 3) s().shake = !s().shake;
          else if (sel === 4) s().touchAuto = !s().touchAuto;
          else if (sel === 5) { go(ControlsScene()); return; }
          else if (sel === 6) {
            if (!confirm) confirm = true;
            else {
              save.rec = {}; save.trophies = {};
              for (const c of SIM.COURSES) try { localStorage.removeItem('zerogp.ghost.' + c.id); } catch (e) { /* ignore */ }
              confirm = false; toast('RECORDS CLEARED');
            }
          } else if (sel === 7) { go(TitleScene()); return; }
          persist();
        }
      },
      draw(dt) {
        drawAttract(0.65);
        title('OPTIONS');
        panel(W / 2 - 120, 40, 240, 120, 0.9);
        const it = items();
        it.forEach((label, i) => {
          const y = 50 + i * 13, on = i === sel;
          if (on) { ctx.fillStyle = 'rgba(255,210,58,0.18)'; ctx.fillRect(W / 2 - 116, y - 2, 232, 11); }
          FD(ctx, label, W / 2 - 104, y, { color: on ? '#fff' : '#9fb4d8' });
        });
        hint('↑↓ SELECT  ←→ CHANGE  X:OK  Z:BACK');
      },
    };
  }

  function ControlsScene() {
    const rows = [
      ['STEER', '← →  / STICK'],
      ['ACCELERATE', 'X  or  ↑  / PAD A'],
      ['BRAKE', 'Z  or  ↓  / PAD X'],
      ['BOOST', 'C  or  SPACE / PAD B'],
      ['LEAN L / R', 'A / S  / PAD LB RB'],
      ['PAUSE', 'ESC  or  P / START'],
      ['MUTE / FULL', 'M  /  F'],
      ['HELP (JP)', 'H'],
    ];
    return {
      update(dt) {
        updateAttract(dt);
        if (hit('back') || hit('ok')) { AUDIO.sfx('menuBack'); go(OptionsScene()); }
      },
      draw() {
        drawAttract(0.7);
        title('CONTROLS');
        panel(20, 34, W - 40, 150, 0.9);
        rows.forEach(([a, b], i) => {
          FD(ctx, a, 32, 44 + i * 14, { color: '#ffd23a' });
          FD(ctx, b, 150, 44 + i * 14, { color: '#fff' });
        });
        FD(ctx, 'BOOST: +1 PER LAP AFTER LAP 1 (MAX 3)', 32, 164, { color: '#3cf0c0' });
        hint('Z: BACK');
      },
    };
  }

  // ------------------------------------------------------------------
  // Boot & main loop
  // ------------------------------------------------------------------
  function resize() {
    const wrap = document.getElementById('wrap');
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(vw / W, vh / H);
    // whole device pixels per game pixel keeps the floor from crawling; fall back to a
    // fractional fit only when the integer size would waste too much of the screen
    const d = Math.floor(fit * dpr);
    const s = d >= 2 && d / dpr >= 0.85 * fit ? d / dpr : fit;
    canvas.style.width = W * s + 'px';
    canvas.style.height = H * s + 'px';
    if (wrap) wrap.style.setProperty('--scale', s);
  }

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame); // re-arm first so an exception can never stop the loop
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    runFrame(dt);
  }
  function runFrame(dt) {
    time += dt;
    frameDt = dt;
    try {
      pollPad(dt);
      if (helpOpen()) {
        // help overlay owns the input: B / START on a pad closes it
        if (pad.hit.back || pad.hit.pause) toggleHelp(false);
        pressed.clear();
        for (const a of ACTIONS) pad.hit[a] = false;
        touch.hit = {};
      } else if (scene.update) scene.update(dt);
      if (scene.draw) scene.draw(dt);
      drawToast(dt);
    } catch (err) {
      console.error(err);
      ctx.fillStyle = '#300'; ctx.fillRect(0, H - 12, W, 12);
      FD(ctx, 'ERROR: ' + String(err.message || err).slice(0, 44), 4, H - 10, { color: '#fff' });
    }
    pressed.clear();
    touch.hit = {};
  }

  function boot() {
    save = loadSave();
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    img = ctx.createImageData(W, H);
    view = RENDER.createView();
    view.buf = new Uint32Array(img.data.buffer);
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 250));
    const lose = () => { keys.clear(); clearTouch(); if (scene && scene.onHide) scene.onHide(); };
    window.addEventListener('blur', lose);
    document.addEventListener('visibilitychange', () => { if (document.hidden) lose(); });
    canvas.addEventListener('pointerdown', () => { unlock(); });
    // browsers only start/resume audio inside a real user activation (and iOS can interrupt it
    // at any time), so every activation re-tries; AUDIO.init() is idempotent
    const wake = () => { if (unlocked) AUDIO.init(); };
    for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(ev, wake, { capture: true, passive: true });
    for (const id of ['helpBtn', 'helpClose']) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off the button
      b.addEventListener('click', () => { unlock(); toggleHelp(id === 'helpBtn' ? undefined : false); b.blur(); });
    }
    setupTouch();
    // loading splash, then heavy init on the next frames
    ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, W, H);
    FD(ctx, 'ZERO-G GP', W / 2, 90, { scale: 3, color: '#ffd23a', align: 'center', italic: true });
    FD(ctx, 'LOADING...', W / 2, 124, { color: '#9fb4d8', align: 'center' });
    setTimeout(() => {
      sheets = RENDER.prepSheets(CARS, DESIGNS);
      startAttract('neon');
      go(TitleScene());
      requestAnimationFrame((t) => { last = t; frame(t); });
    }, 30);
  }

  // test hook: advance n frames manually (the preview pane pauses rAF while hidden)
  function debugFrames(n, dt) { for (let i = 0; i < (n || 1); i++) runFrame(dt || 1 / 60); }
  return { boot, _debug: () => ({ scene, bg, save, gp, frames: debugFrames }) };
})();

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__ZG_HEADLESS) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', APP.boot);
  else APP.boot();
}
