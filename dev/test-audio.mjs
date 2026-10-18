// Headless test for parts/audio.js with a recording mock of the Web Audio API.
// usage: node dev/test-audio.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = process.env.AUDIO_SRC || path.join(here, '../parts/audio.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let passes = 0, fails = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { fails++; console.log('  FAIL:', msg); }
}
const section = (n) => console.log('-- ' + n);
const close = (a, b, eps) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------------------------------
// Web Audio mock
// ------------------------------------------------------------------------------------------
const fin = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('non-finite ' + what + ': ' + v); };

class MockParam {
  constructor(ctx, name, v) { this.ctx = ctx; this.name = name; this._v = v; this.events = []; this.inputs = 0; this.curves = []; }
  get value() { return this._v; }
  set value(v) { fin(v, this.name + '.value'); this._v = v; }
  _ev(type, v, t) {
    fin(v, this.name + ' ' + type + ' value'); fin(t, this.name + ' ' + type + ' time');
    if (t < 0) throw new RangeError('negative time');
    for (const c of this.curves) if (t > c.t0 + 1e-9 && t < c.t1 - 1e-9) throw new Error('NotSupportedError: event inside curve on ' + this.name);
    const C = this.ctx.calls;
    C[type] = (C[type] || 0) + 1; C.total++;
    this.events.push({ type, v, t });
    if (this.events.length > 2000) this.events.splice(0, 1000);
    this.last = { type, v, t };
    return this;
  }
  setValueAtTime(v, t) { return this._ev('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this._ev('linearRampToValueAtTime', v, t); }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponentialRamp to non-positive ' + v);
    return this._ev('exponentialRampToValueAtTime', v, t);
  }
  setTargetAtTime(v, t, tc) {
    fin(tc, 'timeConstant'); if (!(tc > 0)) throw new RangeError('timeConstant <= 0');
    return this._ev('setTargetAtTime', v, t);
  }
  setValueCurveAtTime(curve, t, d) {
    fin(t, 'curve time'); fin(d, 'curve duration');
    if (!(d > 0) || !(curve.length >= 2)) throw new RangeError('bad curve');
    for (const x of curve) fin(x, 'curve value');
    for (const e of this.events) if (e.t > t + 1e-9 && e.t < t + d - 1e-9) throw new Error('NotSupportedError: curve overlaps events');
    for (const c of this.curves) if (t < c.t1 && t + d > c.t0) throw new Error('NotSupportedError: curves overlap');
    this.curves.push({ t0: t, t1: t + d });
    const C = this.ctx.calls; C.setValueCurveAtTime = (C.setValueCurveAtTime || 0) + 1; C.total++;
    return this;
  }
  cancelScheduledValues(t) { fin(t, 'cancel time'); this.ctx.calls.cancel = (this.ctx.calls.cancel || 0) + 1; return this; }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.outputs = new Set(); this.disconnected = false;
    this.everConnected = false;
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!dest || !(dest instanceof MockNode || dest instanceof MockParam)) throw new TypeError('connect: bad destination');
    if (dest === this) throw new Error('self connect');
    if (dest instanceof MockNode && dest.ctx !== this.ctx) throw new Error('cross-context connect');
    this.outputs.add(dest); this.everConnected = true;
    if (dest instanceof MockParam) dest.inputs++;
    this.ctx.connects++;
    return dest instanceof MockNode ? dest : undefined;
  }
  disconnect() { this.outputs.clear(); this.disconnected = true; this.ctx.disconnects++; }
}
class MockSource extends MockNode {
  constructor(ctx, kind) { super(ctx, kind); this.started = false; this.ended = false; this.stopTime = null; this.stopCalls = 0; this.onended = null; }
  start(t = 0, off = 0) {
    if (this.started) throw new Error('InvalidStateError: start() twice');
    fin(t, 'start'); fin(off, 'offset');
    this.started = true; this.startTime = t; this.offset = off;
    if (t < this.ctx.currentTime - 1e-9 && t !== 0) this.ctx.lateStarts++;
    this.ctx.live.add(this);
    this.ctx.startLog.push(this);
  }
  stop(t = 0) {
    if (!this.started) throw new Error('InvalidStateError: stop() before start()');
    fin(t, 'stop');
    this.stopCalls++; this.stopTime = t;
  }
  _endTime() {
    let e = this.stopTime == null ? Infinity : Math.max(this.stopTime, this.startTime);
    if (this.kind === 'buffer' && !this.loop && this.buffer) e = Math.min(e, this.startTime + this.buffer.duration - this.offset);
    return e;
  }
}
class MockContext {
  constructor(opts) {
    MockContext.created++; MockContext.last = this;
    this.opts = opts; this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended';
    this.nodes = []; this.live = new Set(); this.startLog = [];
    this.calls = { total: 0 }; this.connects = 0; this.disconnects = 0; this.lateStarts = 0; this.resumes = 0;
    this.destination = new MockNode(this, 'destination');
  }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  _gainLike(kind, params) { const n = new MockNode(this, kind); for (const [k, v] of Object.entries(params)) n[k] = new MockParam(this, kind + '.' + k, v); return n; }
  createGain() { return this._gainLike('gain', { gain: 1 }); }
  createBiquadFilter() { const n = this._gainLike('biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 }); n.type = 'lowpass'; return n; }
  createStereoPanner() { return this._gainLike('panner', { pan: 0 }); }
  createDelay(max = 1) { const n = this._gainLike('delay', { delayTime: 0 }); n.maxDelay = max; return n; }
  createDynamicsCompressor() { return this._gainLike('compressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }); }
  createOscillator() {
    const o = new MockSource(this, 'osc');
    o.frequency = new MockParam(this, 'osc.frequency', 440); o.detune = new MockParam(this, 'osc.detune', 0);
    let type = 'sine';
    Object.defineProperty(o, 'type', {
      get: () => type,
      set: (v) => { if (!['sine', 'square', 'sawtooth', 'triangle'].includes(v)) throw new TypeError('bad osc type ' + v); type = v; },
    });
    o.setPeriodicWave = (w) => { if (!w || !w.__wave) throw new TypeError('bad wave'); type = 'custom'; };
    return o;
  }
  createBufferSource() {
    const s = new MockSource(this, 'buffer');
    s.buffer = null; s.loop = false; s.playbackRate = new MockParam(this, 'buffer.playbackRate', 1);
    return s;
  }
  createBuffer(ch, len, sr) {
    if (!(ch >= 1 && len >= 1 && sr > 0)) throw new RangeError('bad buffer');
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => data[i] };
  }
  createPeriodicWave(re, im) {
    if (re.length !== im.length || re.length < 2) throw new Error('bad periodic wave');
    for (let i = 0; i < re.length; i++) { fin(re[i], 'wave re'); fin(im[i], 'wave im'); }
    return { __wave: true, n: re.length };
  }
  // advance mock time: fire ended sources (and nothing else)
  _advanceTo(t) {
    this.currentTime = t;
    for (const s of [...this.live]) {
      if (s._endTime() <= t + 1e-9) {
        s.ended = true; this.live.delete(s);
        if (typeof s.onended === 'function') s.onended({ target: s });
      }
    }
  }
}
MockContext.created = 0;

// fake timers (driven by mock audio time)
let intervals = [];
const fakeSetInterval = (fn, ms) => { const h = { fn, ms, next: null }; intervals.push(h); return h; };
const fakeClearInterval = (h) => { intervals = intervals.filter((x) => x !== h); };

function run(ctx, sec, opts = {}) {      // advance in 5 ms slices; interval callbacks every ms
  const end = ctx.currentTime + sec;
  while (ctx.currentTime < end - 1e-9) {
    const t = Math.min(end, ctx.currentTime + 0.005);
    ctx._advanceTo(t);
    if (!opts.noTimers) {
      for (const h of intervals) {
        if (h.next == null) h.next = t;
        if (t >= h.next - 1e-9) { h.fn(); h.next += h.ms / 1000; }
      }
    }
  }
}

function load() { return new Function(SRC + '\nreturn AUDIO;')(); }
function installMock() {
  globalThis.AudioContext = MockContext;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearInterval;
}
function fresh() {
  intervals = [];
  installMock();
  const A = load();
  A._dev.opts.strict = true;
  return A;
}
function installTracked() { globalThis.AudioContext = MockContext; }

// ------------------------------------------------------------------------------------------
section('static source checks');
ok(!/^\s*(import|export)\s/m.test(SRC), 'no import/export');
ok((SRC.match(/^const [A-Z_]+ = /gm) || []).length === 1 && /^const AUDIO = \(\(\) => \{/m.test(SRC), 'exactly one top-level const AUDIO IIFE');
ok(!/\bwindow\b|\bdocument\b/.test(SRC.replace(/\/\/.*$/gm, '')), 'no window/document references in code');

// ------------------------------------------------------------------------------------------
section('load time: no AudioContext / window / timers touched');
{
  const touched = [];
  const keys = ['AudioContext', 'webkitAudioContext', 'window', 'document', 'navigator', 'addEventListener'];
  const saved = {};
  for (const k of keys) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { configurable: true, get() { touched.push(k); return undefined; } });
  }
  let timersSet = 0;
  const si = globalThis.setInterval, st = globalThis.setTimeout;
  globalThis.setInterval = () => { timersSet++; };
  globalThis.setTimeout = () => { timersSet++; };
  let A = null, err = null;
  try { A = load(); } catch (e) { err = e; }
  globalThis.setInterval = si; globalThis.setTimeout = st;
  for (const k of keys) {
    delete globalThis[k];
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
  }
  ok(!err, 'module evaluates without error: ' + err);
  ok(touched.length === 0, 'no global audio/DOM access at load: ' + touched.join(','));
  ok(timersSet === 0, 'no timers at load');
  const api = ['init', 'setVolume', 'setMuted', 'isMuted', 'engine', 'scrape', 'pit', 'alarm', 'wind', 'sfx', 'bgm', 'bgmTempo'];
  for (const f of api) ok(A && typeof A[f] === 'function', 'API has ' + f);
}

section('load time in a completely empty global scope (node:vm)');
{
  const vm = await import('node:vm');
  const sandbox = vm.createContext(Object.create(null));
  let A = null, err = null;
  try { A = vm.runInContext(SRC + '\n;AUDIO', sandbox, { timeout: 2000 }); } catch (e) { err = e; }
  ok(!err && A, 'evaluates with no window/document/AudioContext/timers/console: ' + err);
  const keys = Object.keys(sandbox);
  ok(keys.length === 0, 'creates no globals besides the lexical const AUDIO (' + keys.join(',') + ')');
  let e2 = null, r = null;
  try {
    r = A.init();
    A.setVolume({ master: 0.5 }); A.setMuted(true); A.engine({ speed: 1, machine: 'comet' }); A.scrape(1);
    A.pit(true); A.alarm(true); A.wind(1); A.sfx('go'); A.bgm('title'); A.bgmTempo(1.1);
  } catch (e) { e2 = e; }
  ok(!e2 && r === false && A.isMuted() === true, 'full API is a safe no-op with no Web Audio at all: ' + e2);
}

// ------------------------------------------------------------------------------------------
function callEverything(A) {
  A.setVolume({ master: 0.7, bgm: 0.4, sfx: 0.9 });
  A.setMuted(true); A.setMuted(false);
  A.engine({ speed: 0.8, throttle: 1, boost: true, air: false, machine: 'lynx' });
  A.engine(null);
  A.scrape(0.5); A.scrape(0);
  A.pit(true); A.pit(false);
  A.alarm(true); A.alarm(false);
  A.wind(0.6); A.wind(0);
  for (const n of A._dev.sfxNames) A.sfx(n, { power: 0.5, pan: 0.2 });
  A.sfx('nope');
  for (const n of A._dev.bgmNames) A.bgm(n);
  A.bgm(null);
  A.bgmTempo(1.1);
}

section('no-op before init / without Web Audio');
{
  // (a) Web Audio unavailable entirely
  delete globalThis.AudioContext;
  const A = load();
  A._dev.opts.strict = true;
  let err = null;
  try { callEverything(A); } catch (e) { err = e; }
  ok(!err, 'all calls safe before init (no Web Audio): ' + (err && err.stack));
  ok(A.init() === false, 'init() returns false without Web Audio');
  try { callEverything(A); } catch (e) { err = e; }
  ok(!err, 'all calls safe after failed init: ' + err);
  ok(A._dev.stats().ctx === false, 'no context');
  ok(A.isMuted() === false, 'isMuted works');

  // (b) Web Audio present but init() not called yet
  intervals = [];
  installMock();
  const before = MockContext.created;
  const B = load();
  B._dev.opts.strict = true;
  err = null;
  try { callEverything(B); } catch (e) { err = e; }
  ok(!err, 'all calls safe before init: ' + err);
  ok(MockContext.created === before, 'no AudioContext constructed before init');
  ok(intervals.length === 0, 'no scheduler interval before init');
}

// ------------------------------------------------------------------------------------------
section('init idempotent');
let A = fresh();
installTracked();
{
  const before = MockContext.created;
  ok(A.init() === true, 'init() returns true');
  const ctx = MockContext.last;
  ok(MockContext.created === before + 1, 'one context created');
  ok(ctx.state === 'running' && ctx.resumes === 1, 'context resumed');
  const nodes = ctx.nodes.length;
  ctx.state = 'suspended';
  ok(A.init() === true, 'second init() returns true');
  ok(A.init() === true, 'third init() returns true');
  ok(MockContext.created === before + 1, 'still one context after repeated init');
  ok(ctx.nodes.length === nodes, 'repeated init creates no nodes');
  ok(ctx.resumes >= 2 && ctx.state === 'running', 'repeated init resumes a suspended context');
  ok(intervals.length === 1 && close(intervals[0].ms, 25, 10), 'single ~25 ms scheduler interval');
}

// ------------------------------------------------------------------------------------------
section('continuous controls every frame (600 frames)');
{
  const ctx = MockContext.last;
  const frame = (p, s, pit, al, w) => { A.engine(p); A.scrape(s); A.pit(pit); A.alarm(al); A.wind(w); run(ctx, 1 / 60); };
  const P = { speed: 0.9, throttle: 1, boost: false, air: false, machine: 'comet' };
  frame(P, 0.6, true, true, 0.5);
  const n1 = ctx.nodes.length, tgt1 = ctx.calls.setTargetAtTime || 0;
  const st = A._dev.stats();
  ok(st.loops.engine && st.loops.scrape && st.loops.pit && st.loops.alarm && st.loops.wind, 'all loop graphs built');
  const callsAt1 = ctx.calls.total;
  for (let i = 1; i < 600; i++) frame(P, 0.6, true, true, 0.5);
  ok(ctx.nodes.length === n1, `no new nodes with constant values (${n1} -> ${ctx.nodes.length})`);
  ok((ctx.calls.setTargetAtTime || 0) === tgt1, 'no redundant setTargetAtTime with constant values');
  const perSec = (ctx.calls.total - callsAt1) / 10;
  ok(perSec < 250, 'automation call rate bounded (' + perSec.toFixed(0) + '/s from pit arp + alarm)');
  // varying values, machine switching, toggles
  const machines = ['comet', 'lynx', 'bison', 'hornet', 'unknown'];
  for (let i = 0; i < 600; i++) {
    const p = { speed: (i % 200) / 130, throttle: i % 50 < 40 ? 1 : 0, boost: i % 90 < 20, air: i % 70 < 10, machine: machines[(i / 120) | 0] };
    frame(i % 300 === 299 ? null : p, (i % 60) / 60, i % 100 < 50, i % 80 < 40, i % 7 / 7);
  }
  ok(ctx.nodes.length === n1, 'no new nodes with varying values / toggles');
  ok(ctx.lateStarts === 0, 'no sources started in the past');
  // throttle as boolean (core passes input booleans) and garbage values
  frame({ speed: NaN, throttle: true, boost: 1, air: 0, machine: null }, NaN, 'yes', 0, -3);
  ok(ctx.nodes.length === n1, 'garbage values tolerated without new nodes');
  // turning everything off drives every loop output to 0
  frame(null, 0, false, false, 0);
  run(ctx, 1);
  const I = A._dev.internals();
  for (const k of ['eng', 'scr', 'pitL', 'alm', 'wnd']) {
    const last = I[k].out.gain.last;
    ok(last && last.type === 'setTargetAtTime' && last.v === 0, k + ' output targets 0 when off');
  }
  // persistent loop sources are running, never stopped
  const loopSrcs = ['eng', 'scr', 'pitL', 'alm', 'wnd'].flatMap((k) => I[k].nodes.filter((n) => n instanceof MockSource));
  ok(loopSrcs.length > 0 && loopSrcs.every((s) => s.started && !s.ended && s.stopCalls === 0), 'loop sources started once and kept alive');
  ok(loopSrcs.every((s) => s.kind !== 'buffer' || s.loop), 'noise loop sources loop');
}

// ------------------------------------------------------------------------------------------
section('sfx one-shots');
{
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  run(ctx, 0.1);
  for (const name of A._dev.sfxNames) {
    const before = ctx.nodes.length;
    A.sfx(name, { power: 0.8, pan: -0.5 });
    const made = ctx.nodes.slice(before);
    const srcs = made.filter((n) => n instanceof MockSource);
    ok(made.length >= 2 && srcs.length >= 1, name + ': creates nodes + sources');
    ok(srcs.every((s) => s.started && s.stopCalls >= 1 && Number.isFinite(s.stopTime)), name + ': every source started and stop() scheduled');
    const dur = Math.max(...srcs.map((s) => s.stopTime)) - ctx.currentTime;
    ok(dur > 0.03 && dur < 3, name + ': sane duration ' + dur.toFixed(2) + 's');
    ok(made.every((n) => n.everConnected), name + ': every node connected');
    run(ctx, 3);
    ok(srcs.every((s) => s.ended), name + ': sources ended');
    ok(made.every((n) => n.disconnected), name + ': all nodes disconnected after onended');
    ok(A._dev.stats().voices === 0, name + ': voice released');
  }
  // option handling
  let err = null;
  try {
    A.sfx('wallHit'); A.sfx('carHit', { power: 'x', pan: 9 }); A.sfx('land', null); A.sfx('nope', {}); A.sfx();
  } catch (e) { err = e; }
  ok(!err, 'sfx tolerates missing/garbage opts: ' + err);
  run(ctx, 3);
  // same-name spam is rate limited; voice cap holds under a flood
  const before = ctx.nodes.length;
  for (let i = 0; i < 50; i++) A.sfx('carHit', { power: 1 });
  const once = ctx.nodes.length - before;
  A.sfx('carHit', { power: 1 });
  ok(ctx.nodes.length - before === once, 'same-frame repeats are rate-limited');
  let maxVoices = 0;
  const flood = ctx.nodes.length;
  for (let k = 0; k < 6; k++) {
    for (const name of A._dev.sfxNames) { A.sfx(name, { power: 1 }); maxVoices = Math.max(maxVoices, A._dev.stats().voices); }
    run(ctx, 0.1);
  }
  ok(maxVoices <= 24, 'voice cap respected (max ' + maxVoices + ')');
  run(ctx, 4);
  const floodNodes = ctx.nodes.slice(flood);
  ok(floodNodes.every((n) => n.disconnected), 'flood (incl. stolen voices) fully cleaned up');
  ok(A._dev.stats().voices === 0, 'no voices left');
  // muted: no sfx nodes
  A.setMuted(true);
  const m0 = ctx.nodes.length;
  A.sfx('explode');
  ok(ctx.nodes.length === m0, 'muted sfx create no nodes');
  A.setMuted(false);
  ok(ctx.lateStarts === 0, 'no sources started in the past');
}

// ------------------------------------------------------------------------------------------
section('bgm: every track parses, schedules, loops, stops');
const expectedSources = (comp) => {
  let n = 0;
  for (const b of comp.buckets) for (const e of b) n += e.ch === 's' ? 2 : 1;
  return n;
};
{
  for (const name of A._dev.bgmNames) {
    A = fresh(); installTracked(); A.init();
    const ctx = MockContext.last;
    const def = A._dev.SONGS[name], comp = A._dev.compile(name);
    const loopDur = (comp.length * 60) / def.bpm / 4;
    run(ctx, 0.05);
    const nodes0 = ctx.nodes.length;
    A.bgm(name);
    const songObj = A._dev.internals().song;
    const t0 = songObj.nextTime;
    const log0 = ctx.startLog.length;
    run(ctx, loopDur + 0.5);
    const started = ctx.startLog.slice(log0);
    const firstPass = started.filter((s) => s.startTime >= t0 - 1e-6 && s.startTime < t0 + loopDur - 1e-6);
    ok(firstPass.length === expectedSources(comp), `${name}: one pass schedules every event (${firstPass.length}/${expectedSources(comp)})`);
    ok(started.every((s) => s.stopCalls >= 1), name + ': music sources have stop()');
    ok(ctx.lateStarts === 0, name + ': no late starts');
    const st = A._dev.stats().song;
    if (def.loop === false) {
      ok(st.done === true, name + ': non-looping track finished');
      const n = ctx.startLog.length;
      run(ctx, 6);
      ok(ctx.startLog.length === n, name + ': no notes after the end');
      ok(songObj.nodes.every((x) => x.disconnected), name + ': graph released after the jingle');
      ok(ctx.nodes.slice(nodes0).every((x) => x.disconnected), name + ': every note node disconnected after the jingle');
      A.bgm(name);
      ok(A._dev.internals().song === songObj, name + ': same-name bgm call is idempotent');
    } else {
      ok(st.loops >= 1 && !st.done, name + ': looped');
      const second = started.filter((s) => s.startTime >= t0 + loopDur - 1e-6);
      ok(second.length > 0, name + ': keeps scheduling after loop point');
      // seamless loop: first event of pass 2 starts exactly one loop length after pass 1
      const firstT = Math.min(...firstPass.map((s) => s.startTime));
      const secT = Math.min(...second.map((s) => s.startTime));
      ok(close(secT - firstT, loopDur, 1e-6), `${name}: seamless loop period (${(secT - firstT).toFixed(4)} vs ${loopDur.toFixed(4)})`);
      ok(st.sources <= 192, name + ': music source cap');
      A.bgm(name);
      ok(A._dev.internals().song === songObj, name + ': same-name bgm call is idempotent');
      A.bgm(null);
      const n = ctx.startLog.length;
      run(ctx, 0.3);
      const after = ctx.startLog.length;
      run(ctx, 0.8);
      ok(ctx.startLog.slice(log0).every((s) => s.ended), name + ': every music source silenced within ~1 s of bgm(null)');
      run(ctx, 2.2);
      ok(ctx.startLog.length === after, name + ': nothing scheduled after bgm(null)');
      ok(after - n < 40, name + ': only a short tail after stop');
      ok(songObj.nodes.every((x) => x.disconnected), name + ': song graph disconnected after stop');
      ok(ctx.nodes.slice(nodes0).every((x) => x.disconnected), name + ': every note/drum node disconnected after stop');
      ok(started.every((s) => s.ended), name + ': all music sources ended');
      ok(A._dev.stats().song === null, name + ': no current song');
    }
  }
}

section('bgm switching / pending / unknown');
{
  A = fresh(); installTracked();
  const c0 = MockContext.created;
  A.bgm('title');                      // before init: remembered, no audio
  ok(MockContext.created === c0 && intervals.length === 0, 'pending bgm does nothing before init');
  A.init();
  const ctx = MockContext.last;
  ok(A._dev.stats().song && A._dev.stats().song.name === 'title', 'pending bgm starts on init()');
  run(ctx, 1);
  const s1 = A._dev.internals().song;
  A.bgm('neon');
  const s2 = A._dev.internals().song;
  ok(s2 !== s1 && s2.name === 'neon', 'switched to neon');
  run(ctx, 1);
  A.bgm('coast');
  const s3 = A._dev.internals().song;
  run(ctx, 2);
  ok(s1.nodes.every((n) => n.disconnected) && s2.nodes.every((n) => n.disconnected), 'old song graphs released');
  ok([...s1.sources, ...s2.sources].length === 0, 'old song sources all ended');
  ok(A._dev.stats().song.name === 'coast' && s3.notes > 0, 'new song playing');
  A.bgm('doesNotExist');
  ok(A._dev.internals().song === s3, 'unknown bgm name ignored');
  // rapid switching stress
  let err = null;
  try { for (let i = 0; i < 40; i++) { A.bgm(A._dev.bgmNames[i % 11]); run(ctx, 0.02); } A.bgm(null); A.bgm(null); } catch (e) { err = e; }
  ok(!err, 'rapid switching without exceptions: ' + err);
  run(ctx, 3);
  ok(ctx.live.size === 0 || [...ctx.live].every((s) => s.stopCalls === 0), 'only persistent sources remain alive');
  ok(A._dev.stats().disposals === 0, 'disposal queue drained');
}

section('bgmTempo');
{
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  A.bgm('neon');
  run(ctx, 1);
  const sd0 = A._dev.stats().song.stepDur;
  ok(close(sd0, 60 / 160 / 4, 1e-9), 'base step duration');
  A.bgmTempo(1.1);
  run(ctx, 0.3);
  const mid = A._dev.stats().song.mult;
  ok(mid > 1.0 && mid < 1.1, 'tempo glides smoothly (mult ' + mid.toFixed(3) + ')');
  run(ctx, 4);
  ok(close(A._dev.stats().song.mult, 1.1, 1e-3), 'tempo reaches 1.1');
  ok(close(A._dev.stats().song.stepDur, sd0 / 1.1, 1e-4), 'step duration shortened');
  ok(ctx.lateStarts === 0, 'no late starts while changing tempo');
  A.bgmTempo(1);
  run(ctx, 4);
  ok(close(A._dev.stats().song.mult, 1, 1e-3), 'tempo back to 1');
  A.bgmTempo(1.2);
  A.bgm('frost');
  ok(A._dev.stats().song.mult === 1, 'new track starts at normal tempo');
  A.bgmTempo(NaN); A.bgmTempo(99);
  ok(A._dev.stats().tempoTarget <= 2, 'tempo clamped');
}

section('throttled timer (background tab) does not burst');
{
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  A.bgm('gale');
  run(ctx, 1);
  const n0 = ctx.startLog.length;
  run(ctx, 3, { noTimers: true });            // timer starved for 3 s
  const tResume = ctx.currentTime;
  run(ctx, 0.03);
  const fresh1 = ctx.startLog.slice(n0);
  ok(fresh1.every((s) => s.startTime >= tResume - 1e-6), 'no notes scheduled in the past after a stall');
  const horizon = Math.max(...fresh1.map((s) => s.startTime)) - tResume;
  ok(horizon <= 1.45, 'stall resync bounded by max look-ahead (' + horizon.toFixed(2) + ' s)');
  ok(A._dev.stats().song.sources <= 192, 'source cap after stall');
  // throttled 1 Hz timer (background tab): music stays continuous (no gap > 0.4 s between notes)
  const H = intervals[0], msSaved = H.ms;
  H.ms = 1000; H.next = ctx.currentTime + 1;
  const n1 = ctx.startLog.length;
  run(ctx, 8);
  const starts = ctx.startLog.slice(n1).map((s) => s.startTime).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < starts.length; i++) maxGap = Math.max(maxGap, starts[i] - starts[i - 1]);
  ok(starts.length > 100 && maxGap < 0.4, `continuous under 1 Hz timer (${starts.length} notes, max gap ${maxGap.toFixed(2)} s)`);
  ok(A._dev.stats().lookahead > 1, 'look-ahead stretched while throttled');
  H.ms = msSaved; H.next = ctx.currentTime + 0.025;
  run(ctx, 1);
  ok(close(A._dev.stats().lookahead, 0.15, 1e-9), 'look-ahead back to 0.15 s with a normal timer');
  ok(ctx.lateStarts === 0, 'no late starts while throttled');
}

section('late first tick (scene-change hitch right after bgm) still starts at bar 1');
{
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  run(ctx, 0.5);
  const name = 'neon', comp = A._dev.compile(name), def = A._dev.SONGS[name];
  const loopDur = (comp.length * 60) / def.bpm / 4;
  A.bgm(name);
  const log0 = ctx.startLog.length;
  run(ctx, 0.4, { noTimers: true });          // main thread blocked for 400 ms
  const tResume = ctx.currentTime;
  run(ctx, loopDur + 0.3);
  const started = ctx.startLog.slice(log0);
  const firstT = Math.min(...started.map((s) => s.startTime));
  ok(firstT >= tResume - 1e-9 && firstT < tResume + 0.1, 'song starts right after the hitch (' + (firstT - tResume).toFixed(3) + ' s)');
  const firstPass = started.filter((s) => s.startTime >= firstT - 1e-6 && s.startTime < firstT + loopDur - 1e-6);
  ok(firstPass.length === expectedSources(comp), `full first pass (${firstPass.length}/${expectedSources(comp)})`);
  // the very first notes must be bar 1 step 0 (lead g4 + every other step-0 event), not a later step
  const leadMidi = A._dev.parseVoice(def.lead).events[0].midi, f0 = 440 * Math.pow(2, (leadMidi - 69) / 12);
  const atFirst = started.filter((s) => Math.abs(s.startTime - firstT) < 1e-6);
  const step0 = comp.buckets[0].filter((e) => e.off === 0).reduce((n, e) => n + (e.ch === 's' ? 2 : 1), 0);
  ok(atFirst.some((s) => s.kind === 'osc' && s.frequency.events.some((e) => Math.abs(e.v - f0) < 0.01)) && atFirst.length === step0,
    `opening not skipped: first onset is bar 1 step 0 (${atFirst.length}/${step0} events)`);
  ok(ctx.lateStarts === 0, 'no late starts');
}

section('browser lifecycle: gesture resume, suspended-context sfx guard');
{
  const listeners = [];
  globalThis.addEventListener = (type, fn, opts) => listeners.push({ type, fn, opts });
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  const types = listeners.map((l) => l.type);
  ok(['pointerdown', 'touchend', 'keydown'].every((t) => types.includes(t)), 'gesture listeners installed on init (' + types.join(',') + ')');
  ok(listeners.every((l) => l.opts && l.opts.capture && l.opts.passive), 'listeners are capture + passive');
  A.init(); A.init();
  ok(listeners.length === types.length, 'listeners installed only once');
  run(ctx, 1);
  // browser suspends / interrupts the context later (iOS call, Safari tab switch)
  const realNow = Date.now;
  Date.now = () => realNow() + 10000;
  ctx.state = 'interrupted';
  const n0 = ctx.nodes.length;
  A.sfx('menuSelect'); A.sfx('explode');
  ok(ctx.nodes.length === n0, 'sfx dropped while the context is suspended (no burst on resume)');
  const r0 = ctx.resumes;
  for (const l of listeners.filter((x) => x.type === 'touchend')) l.fn({});
  ok(ctx.resumes === r0 + 1 && ctx.state === 'running', 'next user gesture resumes the context');
  for (const l of listeners) l.fn({});
  ok(ctx.resumes === r0 + 1, 'gestures do nothing while running');
  A.sfx('menuSelect');
  ok(ctx.nodes.length > n0, 'sfx play again after resume');
  Date.now = realNow;
  delete globalThis.addEventListener;
  // a brand-new context is still 'suspended' for a moment: sfx in the unlocking gesture must play
  A = fresh(); installTracked();
  const SavedResume = MockContext.prototype.resume;
  MockContext.prototype.resume = function () { this.resumes++; return Promise.resolve(); };   // async start
  A.init();
  const c2 = MockContext.last, m0 = c2.nodes.length;
  A.sfx('menuSelect');
  ok(c2.state === 'suspended' && c2.nodes.length > m0, 'sfx right after init() plays even before the context reports running');
  MockContext.prototype.resume = SavedResume;
}

section('silent loops are unplugged (no idle CPU) and replugged without rebuilding');
{
  A = fresh(); installTracked(); A.init();
  const ctx = MockContext.last;
  const P = { speed: 0.9, throttle: 1, boost: false, air: false, machine: 'comet' };
  A.engine(P); A.scrape(0.5); A.pit(true); A.alarm(true); A.wind(0.5);
  run(ctx, 0.5);
  const I = A._dev.internals(), K = ['eng', 'scr', 'pitL', 'alm', 'wnd'];
  ok(K.every((k) => I[k].tail.outputs.has(I.loopBus)), 'loops wired to the loop bus while sounding');
  const frame = () => { A.engine(null); A.scrape(0); A.pit(false); A.alarm(false); A.wind(0); run(ctx, 1 / 60); };
  for (let i = 0; i < 60; i++) frame();
  ok(K.every((k) => I[k].tail.outputs.has(I.loopBus)), 'still wired during the 1 s fade-out');
  for (let i = 0; i < 90; i++) frame();
  ok(K.every((k) => I[k].tail.outputs.size === 0 && !I[k].awake), 'unplugged after ~2 s of silence');
  const n0 = ctx.nodes.length, d0 = ctx.disconnects;
  for (let i = 0; i < 120; i++) frame();
  ok(ctx.disconnects === d0, 'unplugging happens once, not every tick');
  A.engine(P); A.scrape(0.5); A.pit(true); A.alarm(true); A.wind(0.5);
  ok(K.every((k) => I[k].tail.outputs.has(I.loopBus) && I[k].awake), 'replugged as soon as a loop is needed');
  ok(K.every((k) => I[k].out.gain.last.v > 0), 'loop levels ramp back up');
  run(ctx, 1);
  ok(ctx.nodes.length === n0, 'no nodes rebuilt on wake');
  const srcs = K.flatMap((k) => I[k].nodes.filter((n) => n instanceof MockSource));
  ok(srcs.every((s) => s.started && !s.ended && s.stopCalls === 0), 'loop sources never stopped by sleeping');
}

section('volume / mute');
{
  A = fresh(); installTracked(); A.init();
  const I = A._dev.internals();
  A.setVolume({ master: 0.3, bgm: 0.2, sfx: 0.6 });
  ok(I.masterGain.gain.last.v === 0.3 && close(I.musicBus.gain.last.v, 0.2 * 1.3, 1e-9) && I.sfxBus.gain.last.v === 0.6, 'setVolume targets');
  A.setMuted(true);
  ok(A.isMuted() && I.masterGain.gain.last.v === 0, 'mute -> master 0');
  A.setVolume({ bgm: 0.9 });
  ok(I.masterGain.gain.last.v === 0, 'volume change keeps mute');
  A.setMuted(false);
  ok(!A.isMuted() && I.masterGain.gain.last.v === 0.3, 'unmute restores master');
  A.setVolume({ master: 5, sfx: -1 });
  ok(I.masterGain.gain.last.v === 1 && I.sfxBus.gain.last.v === 0, 'volumes clamped');
  A.setVolume(null); A.setVolume('x');
  // defaults of a fresh module
  const B = fresh(); installTracked(); B.init();
  const J = B._dev.internals();
  ok(J.masterGain.gain.value === 0.8 && close(J.musicBus.gain.value, 0.5 * 1.3, 1e-9) && J.sfxBus.gain.value === 0.8, 'default mix 0.8 / 0.5 / 0.8');
  // graph: buses -> compressor -> master -> destination
  ok(J.musicBus.outputs.has(J.comp) && J.sfxBus.outputs.has(J.comp) && J.comp.outputs.has(J.masterGain) && J.masterGain.outputs.has(MockContext.last.destination), 'master limiter chain');
}

// ------------------------------------------------------------------------------------------
section('music data validation');
const D = A._dev;
const keyOf = {};
for (const name of D.bgmNames) {
  const def = D.SONGS[name];
  const bars = {}, totals = {};
  let minMidi = 999, maxMidi = -1;
  for (const v of D.PITCHED) {
    ok(typeof def[v] === 'string', `${name}.${v} present`);
    const p = D.parseVoice(def[v]);
    bars[v] = p.barLens; totals[v] = p.total;
    ok(p.barLens.every((l) => l === 16), `${name}.${v}: every bar is 16 steps [${p.barLens.map((l, i) => (l !== 16 ? `bar${i + 1}=${l}` : '')).filter(Boolean).join(' ')}]`);
    const [lo, hi] = D.RANGE[v];
    for (const e of p.events) {
      const offs = e.arp || [0];
      for (const o of offs) {
        const m = e.midi + o;
        ok(m >= lo && m <= hi, `${name}.${v}: note ${D.midiToNote(m)} (${m}) within ${lo}..${hi}`);
        if (v === 'lead') { minMidi = Math.min(minMidi, m); maxMidi = Math.max(maxMidi, m); }
      }
      ok(e.len > 0, `${name}.${v}: positive length`);
    }
  }
  for (const r of D.DRUM_ROWS) {
    const p = D.parseDrums(def[r]);
    bars[r] = p.barLens; totals[r] = p.total;
    ok(p.barLens.every((l) => l === 16), `${name}.${r}: every drum bar is 16 steps`);
  }
  const nb = Object.values(bars).map((b) => b.length);
  ok(nb.every((x) => x === nb[0]), `${name}: all voices have the same bar count (${nb.join(',')})`);
  ok(Object.values(totals).every((x) => x === totals.lead), `${name}: all voices same total length`);
  const barsN = nb[0];
  if (def.race) {
    ok(def.bpm >= 140 && def.bpm <= 175, `${name}: race tempo ${def.bpm} in 140..175`);
    ok(barsN >= 16 && barsN <= 32, `${name}: race loop ${barsN} bars in 16..32`);
  }
  ok(def.loop !== false || name === 'gameover', `${name}: loops`);
  // harmony sanity: a lead note held for half a bar or more that is not a tone of the harmony
  // chord must not sit a semitone (m2 / M7) away from the bass (classic sour sustained clash).
  {
    const lead = D.parseVoice(def.lead).events, bass = D.parseVoice(def.bass).events;
    const harm = D.parseVoice(def.harm).events;
    const at = (evs, s) => evs.filter((x) => x.s <= s + 1e-9 && x.s + x.len > s + 1e-9);
    const sour = [];
    for (const e of lead) {
      if (e.len < 8) continue;
      const chord = new Set(at(harm, e.s).flatMap((h) => (h.arp || [0]).map((o) => (h.midi + o) % 12)));
      if (chord.has(e.midi % 12)) continue;
      const b = at(bass, e.s)[0];
      if (!b) continue;
      const d = (((e.midi - b.midi) % 12) + 12) % 12;
      if (d === 1 || d === 11) sour.push(`bar ${Math.floor(e.s / 16) + 1}: ${D.midiToNote(e.midi)} over ${D.midiToNote(b.midi)}`);
    }
    ok(sour.length === 0, `${name}: no sustained lead note a semitone from the bass [${sour.join('; ')}]`);
  }
  keyOf[name] = def.lead;
  // lead should not be static: at least 8 distinct pitches
  const distinct = new Set(D.parseVoice(def.lead).events.map((e) => e.midi)).size;
  ok(distinct >= (name === 'gameover' ? 5 : 8), `${name}: melodic lead (${distinct} distinct pitches)`);
}
ok(D.SONGS.gameover.loop === false, 'gameover does not loop');
ok(new Set(Object.values(keyOf)).size === D.bgmNames.length, 'all leads distinct');
const races = D.bgmNames.filter((n) => D.SONGS[n].race);
ok(races.length === 6 && races.join() === 'neon,coast,desert,gale,frost,inferno', 'six race tracks');
ok(new Set(races.map((n) => D.SONGS[n].bpm)).size === 6, 'race tracks have distinct tempos');
ok(D.bgmNames.join() === 'title,select,neon,coast,desert,gale,frost,inferno,results,champion,gameover', 'all 11 bgm names');
ok(D.sfxNames.join() === 'menuMove,menuSelect,menuBack,menuError,pause,count,go,lap,finalLap,goal,record,boostReady,wallHit,carHit,boost,dash,jump,land,mine,explode,rankOut,retire', 'all 22 sfx names');

// ------------------------------------------------------------------------------------------
// piano-roll preview of every track (lead red, harm blue, bass green, drums grey)
{
  const PX = 2, ROWH = 2, LO = 26, HI = 98, H1 = (HI - LO) * ROWH + 14;
  const W = 32 * 16 * PX + 8, Hh = H1 * D.bgmNames.length;
  const img = new Uint8ClampedArray(W * Hh * 4);
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= Hh) return; const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255; };
  for (let i = 0; i < W * Hh; i++) { img[i * 4] = 16; img[i * 4 + 1] = 16; img[i * 4 + 2] = 24; img[i * 4 + 3] = 255; }
  D.bgmNames.forEach((name, si) => {
    const y0 = si * H1, comp = D.compile(name);
    for (let x = 0; x < W; x++) put(x, y0, 70, 70, 90);
    for (let b = 0; b <= comp.length / 16; b++) for (let y = y0 + 1; y < y0 + H1 - 12; y++) put(4 + b * 16 * PX, y, 40, 40, 55);
    const col = { lead: [255, 90, 90], harm: [90, 150, 255], bass: [90, 230, 120] };
    comp.buckets.forEach((bk, step) => bk.forEach((e) => {
      const x0 = 4 + Math.round((step + e.off) * PX);
      if (e.ch) { const y = y0 + H1 - 10 + 'kstmlhoc'.indexOf(e.ch); put(x0, y, 200, 200, 200); return; }
      const y = y0 + 1 + (HI - e.midi) * ROWH, c = col[e.v];
      for (let x = x0; x < x0 + Math.max(1, Math.round(e.len * PX) - 1); x++) for (let k = 0; k < ROWH; k++) put(x, y + k, c[0], c[1], c[2]);
    }));
  });
  const out = path.join(here, 'preview', 'audio-rolls.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writePNG(out, W, Hh, img);
  console.log('   wrote', path.relative(process.cwd(), out));
}

// browser lab page (live listening + OfflineAudioContext render checks) with the module inlined
const LAB_TPL = path.join(here, 'preview', 'audio-lab.template.html');
if (fs.existsSync(LAB_TPL)) {
  const tpl = fs.readFileSync(LAB_TPL, 'utf8');
  const html = tpl.replace('/*__AUDIO_SRC__*/""', JSON.stringify(SRC).replace(/<\//g, '<\\/'));
  ok(html !== tpl, 'lab page generated');
  fs.writeFileSync(path.join(here, 'preview', 'audio-lab.html'), html);
  console.log('   wrote dev/preview/audio-lab.html');
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
