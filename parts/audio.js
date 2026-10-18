// ZERO-G GP — AUDIO module
// Web Audio synthesis only: chiptune music sequencer (2 pulse voices + bass + noise drums),
// continuous machine loops (engine / rail scrape / pit recharge / energy alarm / wind) and
// one-shot sound effects. Nothing here touches window / document / AudioContext until init().
// All music below is ORIGINAL (composed for this game).
const AUDIO = (() => {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // constants
  // ---------------------------------------------------------------------------------------
  const LOOKAHEAD = 0.15;          // seconds scheduled ahead of ctx.currentTime
  const MAX_LOOKAHEAD = 1.4;       // stretched only while timers are throttled (background tab)
  const TICK_MS = 25;              // scheduler interval
  const MAX_SFX_VOICES = 24;       // one-shot voice cap (oldest voice is stolen)
  const MAX_MUSIC_SOURCES = 192;   // safety cap of simultaneously alive music sources
  const MUSIC_GAIN = 1.3;          // music bus scale for vol.bgm (keeps 0.5 a comfortable default)
  const PITCHED = ['lead', 'harm', 'bass'];
  const DRUM_ROWS = ['dr', 'hh'];
  const DRUM_CHARS = 'kstmlhoc';   // kick snare tom-hi tom-mid tom-low hat open-hat crash
  const RANGE = { lead: [55, 96], harm: [45, 90], bass: [28, 60] };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---------------------------------------------------------------------------------------
  // compact note notation
  //   voice  = bars separated by '|'; tokens separated by whitespace
  //   token  = NOTE[+ARP][:LEN] | r[:LEN] | -[:LEN]
  //   NOTE   = c d e f g a b, optional # or b, octave digit (c4 = midi 60)
  //   LEN    = length in 16th steps (decimals allowed); it persists until changed (MML style)
  //   r      = rest, '-' = tie (extends the previous note)
  //   +ARP   = chord arpeggio: base-36 semitone offsets cycled at song.arp notes per step,
  //            e.g. a3+037c:16 = A minor arpeggio (A C E A') over one bar
  //   drums  = one char per 16th step, bars separated by '|', spaces ignored;
  //            k kick, s snare, t/m/l toms, h hat, o open hat, c crash, '.' rest,
  //            UPPER CASE = accent
  // ---------------------------------------------------------------------------------------
  const NOTE_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  function noteToMidi(s) {
    const m = /^([a-g])(#|b)?(\d)$/.exec(s);
    if (!m) return null;
    return (+m[3] + 1) * 12 + NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  const midiToNote = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  const TOKEN_RE = /^([a-g](?:#|b)?\d|r|-)(?:\+([0-9a-z]+))?(?::(\d+(?:\.\d+)?))?$/;
  function parseVoice(src) {
    const events = [], barLens = [];
    let pos = 0, len = 4, last = null;
    for (const bar of String(src).split('|')) {
      if (!bar.trim()) continue;
      const start = pos;
      for (const tok of bar.trim().split(/\s+/)) {
        const m = TOKEN_RE.exec(tok);
        if (!m) throw new Error('AUDIO: bad note token "' + tok + '"');
        if (m[3]) len = parseFloat(m[3]);
        if (m[1] === 'r') last = null;
        else if (m[1] === '-') { if (last) last.len += len; }
        else {
          last = {
            s: pos, len, midi: noteToMidi(m[1]),
            arp: m[2] ? Array.from(m[2], (c) => parseInt(c, 36)) : null,
          };
          events.push(last);
        }
        pos += len;
      }
      barLens.push(pos - start);
    }
    return { events, barLens, total: pos };
  }
  function parseDrums(src) {
    const events = [], barLens = [];
    let pos = 0;
    for (const bar of String(src).split('|')) {
      const b = bar.replace(/\s+/g, '');
      if (!b) continue;
      for (const ch of b) {
        const lc = ch.toLowerCase();
        if (lc !== '.') {
          if (DRUM_CHARS.indexOf(lc) < 0) throw new Error('AUDIO: bad drum char "' + ch + '"');
          events.push({ s: pos, ch: lc, acc: ch !== lc });
        }
        pos++;
      }
      barLens.push(b.length);
    }
    return { events, barLens, total: pos };
  }

  // Composition helpers (pure string builders, evaluated once at load — no audio involved).
  // T(tpl, root): template with numeric semitone offsets -> note tokens ('0:2 12 7' + 'c2').
  function T(tpl, root) {
    const r = noteToMidi(root);
    return tpl.trim().split(/\s+/).map((tok) => {
      const m = /^(-?\d+)(:[\d.]+)?$/.exec(tok);
      return m ? midiToNote(r + +m[1]) + (m[2] || '') : tok;
    }).join(' ');
  }
  // B(tpls, spec): spec = 'a:c2 | a:ab1 | h:c#2 h:f#1 | ...' (template key : root), '|' kept.
  function B(tpls, spec) {
    return spec.trim().split(/\s+/).map((tok) => {
      if (tok === '|') return '|';
      const i = tok.indexOf(':');
      return T(tpls[tok.slice(0, i)], tok.slice(i + 1));
    }).join(' ');
  }
  // D(pats, spec): one pattern char per bar ('aaab aaaf'), spaces ignored.
  function D(pats, spec) {
    return Array.from(spec.replace(/\s+/g, ''), (k) => pats[k]).join('|');
  }

  // ---------------------------------------------------------------------------------------
  // MUSIC — all original. 16 steps (16th notes) per 4/4 bar.
  //   ins: lead/harm/bass waveform ('p12' 'p25' 'p50' pulse duty, 'tri', 'saw', 'sq')
  //   arp: arpeggio rate (notes per 16th step) for '+' chord tokens
  //   mix: per-voice levels; echo: lead echo send; bassCut: bass channel low-pass (Hz)
  // ---------------------------------------------------------------------------------------
  const SONGS = {
    // TITLE — heroic anthem, D major, galloping bass.
    title: {
      bpm: 138, arp: 1, ins: { lead: 'p25', harm: 'p50', bass: 'saw' }, bassCut: 1100,
      mix: { lead: 0.2, harm: 0.08, bass: 0.14, drums: 0.3 }, echo: 0.22,
      lead: `a4:4 d5 f#5:6 e5:2 | e5:6 d5:2 c#5:4 a4 | b4:2 c#5 d5:4 f#5 b5 | a5:6 g5:2 d5:8 |
             e5:4 g5 b5:6 a5:2 | g5:3 f#5 e5:2 c#5:4 a4 | d5:4 f#5:2 a5 d6:8 | c#6:4 b5:2 a5 e5:8 |
             d6:6 b5:2 g5:8 | c#6:6 a5:2 e5:8 | f#5:4 a5 c#6 a5 | b5:8 d6:4 f#6 |
             g6:6 f#6:2 e6:4 b5 | d6:4 b5 g5 d6 | e6:8 c#6:4 a5 | e5:2 f#5 g5 a5 b5 c#6 e6:4`,
      harm: `f#4:8 a4 | e4 a4 | f#4 d4 | g4 b4 | g4 b4 | c#5 a4 | a4 f#4 | e4 c#4 |
             b4 g4 | c#5 a4 | a4 c#5 | d5 b4 | e5 b4 | b4 d5 | c#5 e5 | e4:4 a4 c#5 e5`,
      bass: B({ g: '0:2 0:1 0 0:2 0:1 0 0:2 0:1 0 12:2 7', w: '0:2 0 0 0 2 4 7 4' },
        'g:d2 | g:c#2 | g:b1 | g:g1 | g:e2 | g:a1 | g:d2 | g:a1 | ' +
        'g:g1 | g:a1 | g:f#1 | g:b1 | g:e2 | g:g1 | g:a1 | w:a1'),
      dr: D({ a: 'k...s...k.k.s...', b: 'k...s...k.k.s.kk', f: 'k...s...s.ssttll' }, 'abababaf abababaf'),
      hh: D({ c: 'c.h.h.h.h.h.h.h.', h: 'h.h.h.h.h.h.h.h.' }, 'chhhhhhh chhhhhhh'),
    },

    // SELECT — cool mid-tempo, E dorian, syncopated funk with 7th-chord arps.
    select: {
      bpm: 116, arp: 1, ins: { lead: 'p12', harm: 'p25', bass: 'saw' }, bassCut: 750,
      mix: { lead: 0.2, harm: 0.08, bass: 0.15, drums: 0.27 }, echo: 0.3,
      lead: `r:2 b4 d5:1 e5:3 r:2 g5 f#5 d5 | e5:6 c#5:2 r:4 a4:2 b4 | r:2 b4 d5:1 e5:3 r:2 g5 a5 b5 |
             a5:3 g5 e5:2 c#5:8 | r:2 e5 g5 b5 a5:3 g5 e5:2 | f#5:6 d5:2 a4:4 b4 |
             c5:3 b4 a4:2 e5:4 g5 | f#5:8 d#5:4 b4 |
             e6:3 d6 b5:2 r g5 a5 b5 | c#6:6 b5:2 a5:4 g5:2 e5 | r:2 g5:1 a5 b5:4 d6 b5:2 a5 |
             g5:4 f#5:2 e5 c#5:4 e5 | b5:6 g5:2 e5:4 c5 | d5:6 f#5:2 a5:4 c#6 |
             c6:4 b5:2 a5 g5:4 e5 | d#5:4 f#5 a5 b5`,
      harm: `e4+037a:16 | a3+047a | e4+037a | a3+047a | c4+047b | b3+037a | a3+037a | b3+047a |
             e4+037a | a3+047a | e4+037a | a3+047a | c4+047b | b3+037a | a3+037a | b3+047a`,
      bass: B({ f: '0:3 0:1 r:2 12:2 r 10 7 12', m: '0:3 0:1 r:2 12:2 r 7 11 12' },
        'f:e2 | f:a1 | f:e2 | f:a1 | m:c2 | f:b1 | f:a1 | f:b1 | ' +
        'f:e2 | f:a1 | f:e2 | f:a1 | m:c2 | f:b1 | f:a1 | f:b1'),
      dr: D({ a: 'k..ks.....k.s..k', b: 'k..ks....kk.s.k.', f: 'k..ks.....k.s.ss' }, 'abababaf abababaf'),
      hh: D({ h: 'h.h.h.hoh.h.h.h.' }, 'hhhhhhhh hhhhhhhh'),
    },

    // NEON CITY — night-drive synth rock, C minor, 160 BPM.
    neon: {
      bpm: 160, race: true, arp: 1, ins: { lead: 'p25', harm: 'p12', bass: 'saw' }, bassCut: 900,
      mix: { lead: 0.2, harm: 0.1, bass: 0.14, drums: 0.3 }, echo: 0.24,
      lead: `g4:2 c5 d5 eb5:4 d5:2 c5 bb4 | c5:4 eb5:2 f5 g5:6 f5:2 | eb5:3 d5 bb4:2 f5:4 d5 |
             g5:8 f5:2 d5 bb4 d5 | g4:2 c5 d5 eb5:4 d5:2 c5 bb4 | c5:4 eb5:2 f5 ab5:6 g5:2 |
             f5:3 eb5 c5:2 ab5:4 g5:2 f5 | d5:4 b4 g5:8 |
             c6:4 bb5:2 ab5 g5:4 eb5 | f5:2 g5 ab5 bb5:4 ab5:2 g5 f5 | g5:6 d5:2 bb5:4 g5 |
             c6:8 r:2 c5 eb5 g5 | ab5:4 g5:2 f5 c6:4 ab5 | bb5:4 ab5:2 g5 f5:4 d5 |
             eb5:3 f5 g5:2 bb5:4 eb6 | d6:4 b5 g5:2 f5 d5 b4`,
      harm: `c4+037c:16 | ab3+047c | bb3+047c | g3+037c | c4+037c | ab3+047c | f3+037c | g3+047a |
             ab3+047c | bb3+047c | g3+037c | c4+037c | f3+037c | bb3+047c | eb4+047c | g3+047a:8 g3+047c`,
      bass: B({ n: '0:2 0 12 0 r:1 0 7:2 12 7', w: '0:2 12 0 12 0 12 2 4' },
        'n:c2 | n:ab1 | n:bb1 | n:g1 | n:c2 | n:ab1 | n:f1 | w:g1 | ' +
        'n:ab1 | n:bb1 | n:g1 | n:c2 | n:f1 | n:bb1 | n:eb2 | w:g1'),
      dr: D({ a: 'k...s..k..k.s...', b: 'k.k.s..k..k.s..k', f: 'k...s..k.ksstmml', g: 'k.s.k.s.ssssttll' },
        'aaaaaaaf abababag'),
      hh: D({ c: 'c.h.h.h.h.h.h.o.', h: 'h.h.h.h.h.h.h.o.', f: 'h.h.h.h.h.h.....' }, 'chhhhhhf chhhhhhf'),
    },

    // BLUE COAST — bright seaside fusion, A major, 168 BPM.
    coast: {
      bpm: 168, race: true, arp: 1, ins: { lead: 'p25', harm: 'p12', bass: 'saw' }, bassCut: 1300,
      mix: { lead: 0.2, harm: 0.09, bass: 0.14, drums: 0.28 }, echo: 0.26,
      lead: `c#5:2 e5 a5:4 g#5:2 e5 c#5 e5 | f#5:6 e5:2 d5 c#5 a4:4 | b4:2 c#5 d5 f#5 a5:4 f#5 |
             g#5:6 f#5:2 e5:8 | c#5:2 e5 a5:4 g#5:2 e5 c#6:4 | b5:3 a5 f#5:2 a5:8 |
             g#5:4 e5 f#5 c#5 | d5:4 f#5:2 a5 g#5:4 b5 |
             a5:6 f#5:2 c#6:8 | b5:6 g#5:2 e5:8 | e5:2 g#5 b5 c#6 e6:4 c#6 |
             a5:6 c#6:2 f#5:8 | d6:3 c#6 b5:2 a5:4 f#5 | e6:3 d6 c#6:2 b5:4 g#5 |
             f#5:2 a5 c#6 e6 f#6:8 | e6:4 d6:2 c#6 b5:4 g#5:2 e5`,
      harm: `a3+047b:16 | d4+047b | b3+037a | e3+047c | a3+047b | d4+047b | c#4+037a:8 f#3+037c |
             b3+037a e3+047a | d4+047b:16 | e4+047c | c#4+037a | f#3+037a | b3+037a | c#4+037a |
             d4+047b | e3+057c:8 e3+047a`,
      bass: B({ c: '0:2 12:1 0 r 0 7:2 12 0 7 12', h: '0:2 12:1 0 7:2 12' },
        'c:a1 | c:d2 | c:b1 | c:e2 | c:a1 | c:d2 | h:c#2 h:f#1 | h:b1 h:e2 | ' +
        'c:d2 | c:e2 | c:c#2 | c:f#1 | c:b1 | c:c#2 | c:d2 | c:e2'),
      dr: D({ a: 'k...s..k.k..s...', b: 'k...s..k.k..s.k.', f: 'k...s..k.kssttll' }, 'abababaf abababaf'),
      hh: D({ c: 'chohhhohhhohhhoh', h: 'hhohhhohhhohhhoh' }, 'chhhhhhh chhhhhhh'),
    },

    // DUNE SEA — exotic desert drive, D phrygian-dominant, 152 BPM, tom grooves.
    desert: {
      bpm: 152, race: true, arp: 1, ins: { lead: 'p25', harm: 'p50', bass: 'saw' }, bassCut: 850,
      mix: { lead: 0.2, harm: 0.06, bass: 0.14, drums: 0.3 }, echo: 0.28,
      lead: `d5:2 eb5 f#5:4 g5:2 a5 f#5:4 | a5:6 bb5:2 a5:4 g5:2 f#5 | g5:4 f#5:2 eb5 d5:4 eb5 |
             f#5:2 eb5 d5:12 | g5:2 a5 bb5:4 d6 c6:2 bb5 | a5:6 g5:2 f#5:4 g5 |
             bb5:3 a5 g5:2 f#5:4 eb5 | d5:8 r:4 a4:2 c5 |
             eb5:4 g5 c6:6 bb5:2 | d6:6 c6:2 bb5:4 f5 | g5:4 bb5:2 eb6 d6:4 bb5 |
             a5:6 f#5:2 d5:8 | g5:2 bb5 d6 g6 f#6:4 d6 | eb6:6 d6:2 c6:4 bb5 |
             c6:3 bb5 a5:2 g5:4 eb5 | f#5:4 eb5:2 d5 c#5 d5 a4:4`,
      harm: `d4+07c7:16 | d4+047c | eb4+047c | d4+047c | g3+037c | g3+037c | eb4+047c | d4+047c |
             c4+037c | bb3+047c | eb4+047c | d4+047c | g3+037c | eb4+047c | c4+037c | d4+0147:8 d4+047c`,
      bass: B({ d: '0:2 0:1 0 12:2 0 1 0 7 0', o: '0:2 0:1 0 12:2 0 7 0 12 7' },
        'd:d2 | d:d2 | o:eb2 | d:d2 | o:g1 | o:g1 | o:eb2 | d:d2 | ' +
        'o:c2 | o:bb1 | o:eb2 | d:d2 | o:g1 | o:eb2 | o:c2 | d:d2'),
      dr: D({ a: 'k..ks..tk.k.s...', b: 'k..ks..tk.k.s.tl', f: 'k..ks.ttk.mms.ll' }, 'abababaf abababaf'),
      hh: D({ c: 'c.hhh.hhh.hhh.hh', h: 'h.hhh.hhh.hhh.hh' }, 'chhhhhhh chhhhhhh'),
    },

    // STORM VALLEY — aggressive storm rock, B minor, 172 BPM, swirling 32nd arps.
    gale: {
      bpm: 172, race: true, arp: 2, ins: { lead: 'p25', harm: 'p12', bass: 'saw' }, bassCut: 1000,
      mix: { lead: 0.2, harm: 0.09, bass: 0.14, drums: 0.31 }, echo: 0.2,
      lead: `f#5:2 f#5 b5:4 a5:2 f#5 d5 e5 | d5:6 b4:2 g5:4 f#5 | e5:2 e5 a5:4 g5:2 e5 c#5 e5 |
             f#5:8 e5:2 c#5 a#4:4 | f#5:2 f#5 b5:4 a5:2 f#5 d6:4 | d6:3 c#6 b5:2 g5:8 |
             e5:2 g5 b5 e6 d6:4 b5 | c#6:8 a#5:4 f#5 |
             b5:4 a5:2 g5 d6:6 b5:2 | c#6:4 b5:2 a5 e6:6 c#6:2 | d6:3 c#6 b5:2 f#5:3 a5 b5:2 |
             d6:2 e6 f#6:8 e6:2 d6 | e6:6 d6:2 b5:4 g5 | g5:3 a5 b5:2 d6:4 b5 |
             a#5:4 c#6 f#6 e6 | f#6:2 e6 c#6 a#5 f#5 e5 c#5 a#4`,
      harm: `b3+037:16 | g3+047 | a3+047 | f#3+047 | b3+037 | g3+047 | e3+037 | f#3+047 |
             g3+047 | a3+047 | b3+037 | b3+037 | e3+037 | g3+047 | f#3+047a | f#3+047a`,
      bass: B({ a: '0:2 0 0 0 0 0 12 0', f: '0:2 12 0 12 4 7 10 12' },
        'a:b1 | a:g1 | a:a1 | a:f#1 | a:b1 | a:g1 | a:e2 | a:f#1 | ' +
        'a:g1 | a:a1 | a:b1 | a:b1 | a:e2 | a:g1 | a:f#1 | f:f#1'),
      dr: D({ a: 'k..ks..kk..ks..k', b: 'k.k.s..kk.k.s.kk', f: 'k.k.s.k.ssssttll' }, 'abababaf abababaf'),
      hh: D({ c: 'c.h.h.h.h.h.h.h.', h: 'h.h.h.h.h.h.h.h.' }, 'chhhchhh chhhchhh'),
    },

    // FROST LINE — crystalline and wistful, F# minor, 146 BPM, glittering 32nd arps.
    frost: {
      bpm: 146, race: true, arp: 2, ins: { lead: 'p12', harm: 'p12', bass: 'tri' }, bassCut: 2400,
      mix: { lead: 0.2, harm: 0.09, bass: 0.13, drums: 0.27 }, echo: 0.34,
      lead: `c#6:2 a5 f#5 c#6:4 b5:2 a5 g#5 | a5:6 f#5:2 d5:4 e5 | g#5:2 b5 e6:4 d6:2 b5 g#5:4 |
             c#6:6 b5:2 g#5:8 | c#6:2 a5 f#5 c#6:4 d6:2 e6:4 | f#6:6 e6:2 d6:4 b5 |
             a5:3 b5 c#6:2 d6:4 f#6 | e6:8 d6:2 c#6 b5:4 |
             a5:4 f#5 a5:2 b5 c#6:4 | b5:4 g#5 b5:2 c#6 d6:4 | e6:6 c#6:2 g#5:4 c#6 |
             a5:8 f#5:2 g#5 a5 b5 | d6:6 c#6:2 b5:4 f#5 | a5:6 b5:2 c#6:4 d6 |
             e6:3 f#6 g#6:2 e6:4 b5 | c#6:4 e#5 g#5 c#6`,
      harm: `f#4+037c:16 | d4+047c | e4+047c | c#4+037c | f#4+037c | b3+037c | d4+047c | e4+047c |
             d4+047c | e4+047c | c#4+037c | f#4+037c | b3+037c | d4+047c | e4+047c | c#4+047c`,
      bass: B({ a: '0:4 12:2 0 r 0 7:4' },
        'a:f#2 | a:d2 | a:e2 | a:c#2 | a:f#2 | a:b1 | a:d2 | a:e2 | ' +
        'a:d2 | a:e2 | a:c#2 | a:f#2 | a:b1 | a:d2 | a:e2 | a:c#2'),
      dr: D({ a: 'k...s.k...k.s...', f: 'k...s.k...k.s.ss' }, 'aaaaaaaf aaaaaaaf'),
      hh: D({ c: 'chh.hhh.hhh.hho.', h: 'hhh.hhh.hhh.hho.' }, 'chhhhhhh chhhhhhh'),
    },

    // MAGMA FIELD — heavy volcanic metal, E phrygian, 175 BPM, chugging riff + gallop.
    inferno: {
      bpm: 175, race: true, arp: 1, ins: { lead: 'p25', harm: 'p50', bass: 'saw' }, bassCut: 800,
      mix: { lead: 0.2, harm: 0.07, bass: 0.15, drums: 0.25 }, echo: 0.18,
      lead: `e5:2 f5 g5 e5 b5:4 a5:2 g5 | a5:6 g5:2 f5:4 c5 | e5:2 f5 g5 b5 e6:4 d6:2 b5 |
             d6:8 c6:2 a5 f#5:4 | e5:2 f5 g5 e5 b5:4 c6 | c6:6 a5:2 f5:4 a5 |
             b5:3 d6 g6:2 f6:4 d6 | e6:4 f6 e6:8 |
             a5:4 c6 e6:6 d6:2 | d6:6 b5:2 g5:8 | f5:2 a5 c6 f6 e6:4 c6 |
             b5:8 g5:2 a5 b5:4 | c6:3 b5 a5:2 e5:4 a5 | g5:3 a5 c6:2 e6:4 g6 |
             f#6:6 e6:2 d6:4 a5 | d#6:4 b5 f#5 d#5`,
      harm: B({ r: '0:2 0:1 0 12:2 0 r:1 0 7:2 0 12' },
        'r:e3 | r:f3 | r:e3 | r:d3 | r:e3 | r:f3 | r:g3 | r:e3 | ' +
        'r:a3 | r:g3 | r:f3 | r:e3 | r:a3 | r:c3 | r:d3 | r:b2'),
      bass: B({ g: '0:1 0 0:2 0:1 0 0:2 0:1 0 0:2 12 0' },
        'g:e2 | g:f2 | g:e2 | g:d2 | g:e2 | g:f2 | g:g2 | g:e2 | ' +
        'g:a1 | g:g1 | g:f1 | g:e2 | g:a1 | g:c2 | g:d2 | g:b1'),
      dr: D({ a: 'kk.ks.kkk.kks.k.', f: 'kkkks.kks.ssttll' }, 'aaaaaaaf aaaaaaaf'),
      hh: D({ c: 'c.h.h.h.h.h.h.h.', h: 'h.h.h.h.h.h.h.h.' }, 'chhhchhh chhhchhh'),
    },

    // RESULTS — relaxed lounge, F major, 100 BPM, 8-bar loop.
    results: {
      bpm: 100, arp: 1, ins: { lead: 'p25', harm: 'p25', bass: 'tri' }, bassCut: 2400,
      mix: { lead: 0.2, harm: 0.08, bass: 0.14, drums: 0.22 }, echo: 0.3,
      lead: `a4:3 c5 e5:2 f5:4 e5:2 c5 | d5:6 e5:2 c#5:4 a4 | f5:3 a5 c6:2 a5:4 f5 |
             g5:6 eb5:2 a5:4 f5 | d5:3 f5 a5:2 bb5:4 a5:2 f5 | e5:6 c5:2 g5:4 e5 |
             f5:3 d5 bb4:2 a4:4 g4 | e4:4 g4 bb4 c5`,
      harm: `f3+047b:16 | e3+037a:8 a3+047a | d4+037a:16 | c4+037a:8 f3+047a | bb3+047b:16 |
             a3+037a | g3+037a | c4+047a`,
      bass: B({ w: '0:6 7:2 12:4 7', h: '0:6 7:2' },
        'w:f2 | h:e2 h:a1 | w:d2 | h:c2 h:f2 | w:bb1 | w:a1 | w:g1 | w:c2'),
      dr: D({ a: 'k.....k.s.......', b: 'k.....k.s.....k.' }, 'abababab'),
      hh: D({ h: 'h.h.h.h.h.h.h.h.' }, 'hhhhhhhh'),
    },

    // CHAMPION — triumphant fanfare, Bb major, 120 BPM, 8-bar loop.
    champion: {
      bpm: 120, arp: 1, ins: { lead: 'p25', harm: 'p50', bass: 'saw' }, bassCut: 1200,
      mix: { lead: 0.2, harm: 0.09, bass: 0.14, drums: 0.3 }, echo: 0.2,
      lead: `f4:2 bb4 d5 f5:6 d5:2 f5 | c6:8 a5:4 f5 | bb5:6 a5:2 g5:4 d5 | eb5:4 g5 bb5 eb6 |
             d6:6 c6:2 bb5:4 f5 | g5:3 a5 bb5:2 c6:4 eb6 | f6:8 eb6:2 d6 c6:4 | c6:2 d6 eb6 c6 a5:4 f5`,
      harm: `bb4:8 d5 | a5:8 f5:4 c5 | g5:6 f5:2 d5:4 bb4 | bb4:4 eb5 g5 bb5 |
             bb5:6 a5:2 f5:4 d5 | eb5:3 f5 g5:2 a5:4 c6 | c6:8 bb5:4 a5 | a5:2 bb5 c6 a5 f5:4 c5`,
      bass: B({ m: '0:4 7 0 7', w: '0:2 0 0 0 0 2 4 5' },
        'm:bb1 | m:f1 | m:g1 | m:eb2 | m:bb1 | m:eb2 | m:f1 | w:f1'),
      dr: D({ a: 'k...s...k...s.s.', b: 'k...s...k.k.s.ss', f: 'k.s.k.s.s.s.ssss' }, 'abababaf'),
      hh: D({ c: 'c.h.h.h.h.h.h.h.', h: 'h.h.h.h.h.h.h.h.' }, 'chhhchhh'),
    },

    // GAME OVER — short sad jingle, A minor, no loop.
    gameover: {
      bpm: 84, loop: false, arp: 1, ins: { lead: 'p50', harm: 'p25', bass: 'tri' }, bassCut: 2000,
      mix: { lead: 0.2, harm: 0.09, bass: 0.15, drums: 0.22 }, echo: 0.3,
      lead: `e5:4 c5 a4 g#4 | f4:6 e4:2 d4:4 b3 | a3:16`,
      harm: `a4:8 e4 | d4:6 c4:2 b3:4 g#3 | c4:16`,
      bass: `a2:8 e2 | d2:8 e2 | a1:16`,
      dr: `k.......s....... | k.......s....... | k...............`,
      hh: `h...h...h...h... | h...h...h...h... | c...............`,
    },
  };

  // ---------------------------------------------------------------------------------------
  // runtime state (all lazily created in init())
  // ---------------------------------------------------------------------------------------
  let ctx = null, available = null, timer = null, initWall = 0, gestureHooked = false;
  let lookahead = LOOKAHEAD, lastTick = -1;
  let comp = null, masterGain = null, musicBus = null, sfxBus = null, loopBus = null;
  let noiseBuf = null;
  const NOISE_LEN = 3;                         // seconds of white noise
  const waves = {};
  const vol = { master: 0.8, bgm: 0.5, sfx: 0.8 };
  let muted = false;
  let song = null, pendingBgm = null, tempoTarget = 1;
  const compiled = {};
  const disposals = [];                        // [{t, nodes}] disconnected by the scheduler tick
  const lastT = new WeakMap();                 // AudioParam -> last setTargetAtTime target
  const dev = { strict: false };

  const getAC = () => {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    return (g && (g.AudioContext || g.webkitAudioContext)) || null;
  };
  function safeDisconnect(n) { try { n.disconnect(); } catch (e) { /* already gone */ } }
  // Cheap idempotent parameter smoothing: skips the automation call when the target is unchanged.
  function setT(param, v, tc) {
    if (!param || !isFinite(v)) return;
    const last = lastT.get(param);
    if (last !== undefined && Math.abs(last - v) <= 1e-4 + Math.abs(v) * 0.003) return;
    lastT.set(param, v);
    param.setTargetAtTime(v, ctx.currentTime, tc);
  }
  function resume() {
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    }
  }
  // The core calls init() only once. Resume on every later user gesture as well, so a context
  // created outside a real activation (gamepad press) or suspended/'interrupted' by the browser
  // (iOS calls/Siri/backgrounding, Safari tab switches) comes back on the next tap or key.
  function hookGestures() {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (gestureHooked || !g || typeof g.addEventListener !== 'function') return;
    gestureHooked = true;
    const h = () => { if (ctx && ctx.state !== 'running') resume(); };
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown']) {
      try { g.addEventListener(ev, h, { capture: true, passive: true }); } catch (e) { /* ignore */ }
    }
  }
  // Is it safe to schedule one-shots now? A context that ran and was then suspended keeps its
  // clock frozen: anything queued would burst out on resume, so drop sfx meanwhile. A freshly
  // created context reports 'suspended' for a moment before it starts — allow that window.
  const now0 = () => (typeof Date !== 'undefined' ? Date.now() : 0);
  const playable = () => !ctx.state || ctx.state === 'running' || now0() - initWall < 500;

  // Band-limited pulse waves (Fourier series of a duty-cycle pulse).
  const DUTY = { p12: 0.125, p25: 0.25, p50: 0.5 };
  // loudness compensation for music notes (thin pulses have far less energy than a square)
  const WAVE_GAIN = { p12: 1.7, p25: 1.25, p50: 0.8, sq: 0.8, tri: 1, saw: 1, sine: 1 };
  const BASIC = { tri: 'triangle', saw: 'sawtooth', sq: 'square', sine: 'sine' };
  function pulseWave(duty) {
    const key = 'p' + duty;
    if (key in waves) return waves[key];
    let w = null;
    if (ctx.createPeriodicWave) {
      const N = 64, re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) {
        const k = 1 / (Math.PI * n), a = 2 * Math.PI * n * duty;
        re[n] = k * Math.sin(a);
        im[n] = k * (1 - Math.cos(a));
      }
      try { w = ctx.createPeriodicWave(re, im); } catch (e) { w = null; }
    }
    return (waves[key] = w);
  }
  function setWave(o, name) {
    const d = DUTY[name];
    if (d) {
      const w = pulseWave(d);
      if (w && o.setPeriodicWave) { o.setPeriodicWave(w); return; }
      o.type = 'square';
      return;
    }
    o.type = BASIC[name] || name || 'square';
  }

  // ---------------------------------------------------------------------------------------
  // music: compile + look-ahead scheduler
  // ---------------------------------------------------------------------------------------
  function compile(name) {
    if (compiled[name]) return compiled[name];
    const def = SONGS[name], rate = def.arp || 1, all = [];
    let length = 0;
    for (const v of PITCHED) {
      if (!def[v]) continue;
      const p = parseVoice(def[v]);
      length = Math.max(length, p.total);
      for (const e of p.events) {
        if (e.arp) {
          const n = Math.max(1, Math.round(e.len * rate)), sl = e.len / n;
          for (let i = 0; i < n; i++) {
            all.push({ v, s: e.s + i * sl, len: sl, midi: e.midi + e.arp[i % e.arp.length], arp: true });
          }
        } else all.push({ v, s: e.s, len: e.len, midi: e.midi, arp: false });
      }
    }
    for (const r of DRUM_ROWS) {
      if (!def[r]) continue;
      const p = parseDrums(def[r]);
      length = Math.max(length, p.total);
      for (const e of p.events) all.push({ v: 'drums', s: e.s, ch: e.ch, acc: e.acc });
    }
    length = Math.max(1, Math.ceil(length - 1e-6));
    const buckets = Array.from({ length }, () => []);
    for (const e of all) {
      const b = Math.min(length - 1, Math.floor(e.s + 1e-6));
      e.off = Math.max(0, e.s - b);
      buckets[b].push(e);
    }
    return (compiled[name] = { length, buckets, count: all.length });
  }

  function connectPan(src, pan, dest, nodes) {
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      nodes.push(p);
      src.connect(p);
      p.connect(dest);
    } else src.connect(dest);
  }

  function startSong(name) {
    const def = SONGS[name], cmp = compile(name), mix = def.mix || {};
    const nodes = [];
    const mk = (n) => { nodes.push(n); return n; };
    const out = mk(ctx.createGain());
    out.gain.value = 1;
    out.connect(musicBus);
    const ch = {};
    ch.lead = mk(ctx.createGain());
    ch.lead.gain.value = num(mix.lead, 0.14);
    connectPan(ch.lead, -0.12, out, nodes);
    if (def.echo) {                                   // dotted-8th echo on the lead
      const send = mk(ctx.createGain()), dl = mk(ctx.createDelay(1));
      const lp = mk(ctx.createBiquadFilter()), fb = mk(ctx.createGain());
      send.gain.value = def.echo;
      dl.delayTime.value = Math.min(0.9, (3 * 60) / def.bpm / 4);
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.5;
      fb.gain.value = 0.3;
      ch.lead.connect(send); send.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl);
      connectPan(lp, 0.4, out, nodes);
    }
    ch.harm = mk(ctx.createGain());
    ch.harm.gain.value = num(mix.harm, 0.06);
    connectPan(ch.harm, 0.22, out, nodes);
    const bassG = mk(ctx.createGain());
    bassG.gain.value = num(mix.bass, 0.18);
    bassG.connect(out);
    ch.bass = mk(ctx.createBiquadFilter());
    ch.bass.type = 'lowpass'; ch.bass.frequency.value = num(def.bassCut, 1000); ch.bass.Q.value = 2.2;
    ch.bass.connect(bassG);
    ch.drums = mk(ctx.createGain());
    ch.drums.gain.value = num(mix.drums, 0.3);
    ch.drums.connect(out);
    song = {
      name, def, comp: cmp, step: 0, nextTime: ctx.currentTime + 0.08, mult: tempoTarget,
      out, ch, nodes, sources: new Set(), done: false, disposed: false, loops: 0, notes: 0,
    };
  }

  function disposeSongLater(s, t) {
    if (s.disposed) return;
    s.disposed = true;
    disposals.push({ t, nodes: s.nodes });
  }
  function stopSong(s, tc) {
    const now = ctx.currentTime;
    s.done = true;
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setValueAtTime(s.out.gain.value, now);
    s.out.gain.setTargetAtTime(0, now, tc);
    const tEnd = now + tc * 7;
    for (const src of s.sources) {
      if (src._t1 > tEnd) {
        const t = Math.max(tEnd, src._t0 + 0.005);
        try { src.stop(t); src._t1 = t; } catch (e) { /* stopped already */ }
      }
    }
    disposeSongLater(s, tEnd + 0.4);
  }

  const stepDur = (s) => 60 / (s.def.bpm * s.mult) / 4;
  function scheduleSong(now) {
    const s = song, L = s.comp.length;
    // First tick came late (scene change hitch right after bgm()): nothing has been played yet,
    // so start the song a little later from bar 1 instead of skipping its opening.
    if (s.step === 0 && s.loops === 0 && s.nextTime < now + 0.02) s.nextTime = now + 0.03;
    // Throttled tab (timer fired late): jump forward silently instead of bursting old notes.
    if (s.nextTime < now - 0.1) {
      while (s.nextTime < now) {
        s.step++;
        if (s.step >= L) {
          if (s.def.loop === false) { s.done = true; disposeSongLater(s, now + 3); return; }
          s.step = 0; s.loops++;
        }
        s.nextTime += stepDur(s);
      }
    }
    let n = 0;
    while (s.nextTime < now + lookahead && n++ < 2048) {
      if (s.step >= L) {
        if (s.def.loop === false) { s.done = true; disposeSongLater(s, s.nextTime + 4); return; }
        s.step = 0; s.loops++;
      }
      const sd = stepDur(s), evs = s.comp.buckets[s.step];
      for (let i = 0; i < evs.length; i++) playEvent(s, evs[i], s.nextTime + evs[i].off * sd, sd);
      s.step++;
      s.nextTime += sd;
      s.mult += (tempoTarget - s.mult) * (1 - Math.exp(-sd / 0.6));   // smooth tempo glide
      if (Math.abs(tempoTarget - s.mult) < 1e-4) s.mult = tempoTarget;
    }
  }

  const ENV = {
    lead: { a: 0.006, d: 0.18, sus: 0.62, r: 0.07, gate: 0.94 },
    harm: { a: 0.01, d: 0.25, sus: 0.55, r: 0.09, gate: 0.92 },
    arp: { a: 0.003, d: 0.05, sus: 0.45, r: 0.02, gate: 0.8 },
    bass: { a: 0.004, d: 0.12, sus: 0.72, r: 0.04, gate: 0.86 },
  };
  function trackSrc(s, src, nodes, t0, t1, off) {
    src._t0 = t0; src._t1 = t1;
    s.sources.add(src);
    s.notes++;
    src.onended = () => {
      s.sources.delete(src);
      for (let i = 0; i < nodes.length; i++) safeDisconnect(nodes[i]);
    };
    if (off) src.start(t0, off); else src.start(t0);
    src.stop(t1);
  }
  function playEvent(s, ev, t, sd) {
    if (s.sources.size >= MAX_MUSIC_SOURCES) return;
    if (ev.ch) drumHit(s, ev.ch, ev.acc, t);
    else playNote(s, ev.v, s.def.ins[ev.v], ev.midi, t, ev.len * sd, ev.arp ? ENV.arp : ENV[ev.v]);
  }
  function playNote(s, v, wave, midi, t, dur, env) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    setWave(o, wave);
    o.frequency.setValueAtTime(mtof(midi), t);
    const gate = Math.max(env.a + 0.012, dur * env.gate);
    const p = g.gain, wg = WAVE_GAIN[wave] || 1;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(wg, t + env.a);
    p.setTargetAtTime(env.sus * wg, t + env.a, env.d);
    p.setTargetAtTime(0, t + gate, env.r / 4);
    if (v === 'lead' && dur > 0.3) vibrato(o.detune, t + 0.15, t + gate);
    o.connect(g);
    g.connect(s.ch[v]);
    trackSrc(s, o, [o, g], t, t + gate + env.r * 1.6);
  }
  // Delayed vibrato via a detune curve (no extra nodes).
  function vibrato(param, t0, t1, depth = 16, rate = 5.5) {
    const d = t1 - t0;
    if (d < 0.08 || !param || !param.setValueCurveAtTime) return;
    const n = Math.max(2, Math.ceil(d * 80)), c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tt = (i / (n - 1)) * d;
      c[i] = depth * Math.min(1, tt / 0.3) * Math.sin(2 * Math.PI * rate * tt);
    }
    param.setValueCurveAtTime(c, t0, d);
  }

  function noiseHit(s, dest, t, type, f, q, peak, tc, len) {
    const n = ctx.createBufferSource(), bf = ctx.createBiquadFilter(), g = ctx.createGain();
    n.buffer = noiseBuf;
    bf.type = type; bf.frequency.value = f; bf.Q.value = q;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.004, tc);
    n.connect(bf); bf.connect(g); g.connect(dest);
    trackSrc(s, n, [n, bf, g], t, t + len, 0.01 + Math.random() * (NOISE_LEN - len - 0.05));
  }
  function toneHit(s, dest, t, type, f0, f1, sweep, peak, tc, len) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.012, tc);
    o.connect(g); g.connect(dest);
    trackSrc(s, o, [o, g], t, t + len);
  }
  function drumHit(s, ch, acc, t) {
    const d = s.ch.drums, v = acc ? 1 : 0.8;
    switch (ch) {
      case 'k': toneHit(s, d, t, 'sine', 160, 42, 0.12, v, 0.07, 0.4); break;
      case 's':
        noiseHit(s, d, t, 'bandpass', 1900, 0.7, v * 0.85, 0.05, 0.3);
        toneHit(s, d, t, 'triangle', 210, 150, 0.06, v * 0.45, 0.03, 0.16);
        break;
      case 'h': noiseHit(s, d, t, 'highpass', 7600, 0.7, v * 0.26, 0.013, 0.08); break;
      case 'o': noiseHit(s, d, t, 'highpass', 7000, 0.7, v * 0.24, 0.07, 0.4); break;
      case 'c': noiseHit(s, d, t, 'highpass', 4200, 0.5, v * 0.3, 0.32, 1.7); break;
      case 't': toneHit(s, d, t, 'triangle', 230, 140, 0.16, v * 0.8, 0.07, 0.42); break;
      case 'm': toneHit(s, d, t, 'triangle', 170, 105, 0.16, v * 0.8, 0.08, 0.45); break;
      case 'l': toneHit(s, d, t, 'triangle', 125, 75, 0.18, v * 0.85, 0.09, 0.5); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------------------------------
  // continuous loops — built once on first use, then only parameter targets change
  // ---------------------------------------------------------------------------------------
  let eng = null, scr = null, pitL = null, alm = null, wnd = null;
  let pitOn = false, pitNext = 0, pitIdx = 0, alarmOn = false, alarmNext = 0;

  function loopKit() {
    const k = { nodes: [] };
    k.add = (n) => { k.nodes.push(n); return n; };
    k.gain = (v, dest) => { const g = k.add(ctx.createGain()); g.gain.value = v; if (dest) g.connect(dest); return g; };
    k.filt = (type, f, q, dest) => {
      const b = k.add(ctx.createBiquadFilter());
      b.type = type; b.frequency.value = f; b.Q.value = q;
      if (dest) b.connect(dest);
      return b;
    };
    k.osc = (wave, f, dest) => {
      const o = k.add(ctx.createOscillator());
      setWave(o, wave); o.frequency.value = f;
      if (dest) o.connect(dest);
      o.start();
      return o;
    };
    k.noise = (dest) => {
      const n = k.add(ctx.createBufferSource());
      n.buffer = noiseBuf; n.loop = true;
      n.connect(dest);
      n.start(ctx.currentTime, Math.random() * (NOISE_LEN - 0.1));
      return n;
    };
    k.out = k.gain(0, loopBus);
    k.tail = k.out;          // the one node wired into loopBus
    k.awake = true;
    k.quietAt = -1;
    return k;
  }
  // Set a loop's output level. A loop that has been silent for LOOP_SLEEP seconds is unplugged
  // from the bus (pull-based engines then stop rendering its oscillators/filters — no CPU in
  // menus after a race); it is plugged back in, without rebuilding anything, when it is needed.
  const LOOP_SLEEP = 2;
  function loopLevel(k, v, tc) {
    if (v > 0) {
      if (!k.awake) { k.tail.connect(loopBus); k.awake = true; }
      k.quietAt = -1;
    } else if (k.quietAt < 0) k.quietAt = ctx.currentTime;
    setT(k.out.gain, v, tc);
  }
  function sleepLoops(now) {
    for (const k of [eng, scr, pitL, alm, wnd]) {
      if (k && k.awake && k.quietAt >= 0 && now - k.quietAt > LOOP_SLEEP) {
        safeDisconnect(k.tail);
        k.awake = false;
      }
    }
  }

  // Machine timbres: base pitch, 2nd oscillator ratio, waveforms, filter brightness, turbine
  // whine harmonic, hiss amount, hover wobble rate.
  const MACHINES = {
    comet: { base: 56, ratio: 1.5, waveA: 'sawtooth', waveB: 'square', cut: 1.0, whine: 7, whineVol: 0.05, hiss: 0.1, sub: 0.45, wob: 7, vol: 1.0 },
    lynx: { base: 72, ratio: 2.0, waveA: 'square', waveB: 'sawtooth', cut: 1.2, whine: 9, whineVol: 0.07, hiss: 0.08, sub: 0.3, wob: 9, vol: 0.8 },
    bison: { base: 42, ratio: 1.5, waveA: 'sawtooth', waveB: 'sawtooth', cut: 0.75, whine: 6, whineVol: 0.035, hiss: 0.13, sub: 0.75, wob: 5, vol: 1.1 },
    hornet: { base: 63, ratio: 1.335, waveA: 'sawtooth', waveB: 'square', cut: 1.1, whine: 8, whineVol: 0.05, hiss: 0.12, sub: 0.4, wob: 11, vol: 0.95 },
  };
  function buildEngine() {
    const k = loopKit();
    k.lp = k.filt('lowpass', 600, 5, k.out);
    k.ga = k.gain(0.5, k.lp); k.a = k.osc('sawtooth', 60, k.ga);
    k.gb = k.gain(0.28, k.lp); k.b = k.osc('square', 90, k.gb);
    k.gs = k.gain(0.15, k.out); k.sub = k.osc('triangle', 30, k.gs);
    k.gw = k.gain(0, k.out); k.w = k.osc('sine', 400, k.gw);
    k.gn = k.gain(0, k.out); k.bp = k.filt('bandpass', 800, 1.2, k.gn); k.n = k.noise(k.bp);
    k.gbst = k.gain(0, k.out); k.hp = k.filt('highpass', 1800, 0.7, k.gbst); k.bn = k.noise(k.hp);
    k.lfoG = k.gain(9, null); k.lfoG.connect(k.a.detune); k.lfoG.connect(k.b.detune);
    k.lfo = k.osc('sine', 7, k.lfoG);
    k.m = null;
    return k;
  }
  function engine(p) {
    if (!ctx) return;
    if (!p) { if (eng) loopLevel(eng, 0, 0.12); return; }
    if (!eng) eng = buildEngine();
    const m = MACHINES[p.machine] || MACHINES.comet;
    if (eng.m !== m) {
      eng.m = m;
      eng.a.type = m.waveA; eng.b.type = m.waveB;
      setT(eng.lfo.frequency, m.wob, 0.05);
      setT(eng.gs.gain, m.sub * 0.35, 0.1);
    }
    const sp = clamp(num(+p.speed, 0), 0, 1.6), thr = p.throttle ? 1 : 0;
    const boost = p.boost ? 1 : 0, air = p.air ? 1 : 0;
    const f = m.base * (0.85 + sp * 2.1 + boost * 0.25) * (1 + air * 0.07 + thr * 0.03);
    setT(eng.a.frequency, f, 0.07);
    setT(eng.b.frequency, f * m.ratio, 0.07);
    setT(eng.sub.frequency, f * 0.5, 0.07);
    setT(eng.w.frequency, f * m.whine, 0.08);
    setT(eng.gw.gain, m.whineVol * (0.25 + Math.min(sp, 1.3)) * (0.7 + 0.3 * thr), 0.1);
    setT(eng.lp.frequency, 350 + sp * 2200 * m.cut + thr * 450 + boost * 1400 + air * 500, 0.08);
    setT(eng.bp.frequency, 500 + sp * 2600, 0.1);
    setT(eng.gn.gain, m.hiss * (0.15 + sp * 0.9) * (1 + air * 0.4), 0.1);
    setT(eng.gbst.gain, boost ? 0.16 : 0, boost ? 0.04 : 0.3);
    loopLevel(eng, (0.1 + 0.035 * thr + 0.025 * Math.min(sp, 1.2)) * m.vol, 0.08);
  }

  function buildScrape() {
    const k = loopKit();
    k.am = k.gain(0.55, k.out);
    k.lfoG = k.gain(0.45, k.am.gain); k.lfo = k.osc('square', 26, k.lfoG);   // electric flutter
    k.bp = k.filt('bandpass', 1400, 1.5, k.am);
    k.o1 = k.osc('sawtooth', 96, k.bp);
    k.o2 = k.osc('square', 151, k.bp);
    k.ng = k.gain(0.6, k.am); k.hp = k.filt('highpass', 2600, 0.7, k.ng); k.n = k.noise(k.hp);
    return k;
  }
  function scrape(i) {
    if (!ctx) return;
    i = clamp(num(+i, 0), 0, 1);
    if (!scr) { if (i <= 0) return; scr = buildScrape(); }
    loopLevel(scr, i * 0.24, i > 0 ? 0.015 : 0.05);
    setT(scr.o1.frequency, 80 + 50 * i, 0.05);
    setT(scr.o2.frequency, 127 + 70 * i, 0.05);
    setT(scr.lfo.frequency, 20 + 14 * i, 0.1);
  }

  const PIT_NOTES = [72, 76, 79, 84, 88, 91, 88, 84].map(mtof);
  function buildPit() {
    const k = loopKit();
    k.hg = k.gain(0.3, k.out);
    k.tg = k.gain(0.15, k.hg.gain); k.trem = k.osc('sine', 9, k.tg);   // shimmering hum
    k.h1 = k.osc('triangle', 220, k.hg);
    k.h2 = k.osc('sine', 330.5, k.hg);
    k.ag = k.gain(0, k.out); k.arp = k.osc('p25', 1046.5, k.ag);
    return k;
  }
  function pit(on) {
    if (!ctx) return;
    on = !!on;
    if (!pitL) { if (!on) return; pitL = buildPit(); }
    if (on && !pitOn) pitNext = Math.max(pitNext, ctx.currentTime + 0.02);
    pitOn = on;
    loopLevel(pitL, on ? 0.16 : 0, on ? 0.03 : 0.08);
  }
  function schedulePit(now) {
    if (pitNext < now) pitNext = now + 0.01;
    while (pitNext < now + lookahead) {
      const t = pitNext, g = pitL.ag.gain;
      pitL.arp.frequency.setValueAtTime(PIT_NOTES[pitIdx++ % PIT_NOTES.length], t);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(0.5, t + 0.004);
      g.linearRampToValueAtTime(0.12, t + 0.05);
      g.linearRampToValueAtTime(0, t + 0.068);
      pitNext += 0.07;
    }
  }

  function buildAlarm() {
    const k = loopKit();
    k.lp = k.filt('lowpass', 3500, 0.7, k.out);
    k.g = k.gain(0, k.lp);
    k.o = k.osc('sq', 1046.5, k.g);
    return k;
  }
  function alarm(on) {
    if (!ctx) return;
    on = !!on;
    if (!alm) { if (!on) return; alm = buildAlarm(); }
    if (on && !alarmOn) alarmNext = Math.max(alarmNext, ctx.currentTime + 0.02);
    alarmOn = on;
    loopLevel(alm, on ? 0.1 : 0, on ? 0.005 : 0.02);
  }
  function beep(t, f) {
    const g = alm.g.gain;
    alm.o.frequency.setValueAtTime(f, t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + 0.006);
    g.setValueAtTime(1, t + 0.11);
    g.linearRampToValueAtTime(0, t + 0.125);
  }
  function scheduleAlarm(now) {
    if (alarmNext < now) alarmNext = now + 0.01;
    while (alarmNext < now + lookahead) {
      beep(alarmNext, 1046.5);           // hi
      beep(alarmNext + 0.16, 784);       // lo
      alarmNext += 0.52;
    }
  }

  function buildWind() {
    const k = loopKit();
    let dest = k.out;
    if (ctx.createStereoPanner) {                            // slow drifting stereo gusts
      k.out.disconnect();
      k.pan = k.add(ctx.createStereoPanner());
      k.out.connect(k.pan); k.pan.connect(loopBus);
      k.tail = k.pan;
      k.l3g = k.gain(0.5, k.pan.pan); k.l3 = k.osc('sine', 0.11, k.l3g);
    }
    k.amp = k.gain(0.6, dest);
    k.bp = k.filt('bandpass', 700, 0.9, k.amp); k.n = k.noise(k.bp);
    k.l1g = k.gain(380, k.bp.frequency); k.l1 = k.osc('sine', 0.19, k.l1g);
    k.l2g = k.gain(0.35, k.amp.gain); k.l2 = k.osc('sine', 0.31, k.l2g);
    k.rg = k.gain(0.4, dest); k.lp = k.filt('lowpass', 260, 0.7, k.rg); k.n2 = k.noise(k.lp);
    return k;
  }
  function wind(i) {
    if (!ctx) return;
    i = clamp(num(+i, 0), 0, 1);
    if (!wnd) { if (i <= 0) return; wnd = buildWind(); }
    loopLevel(wnd, i * 1.1, 0.25);
    setT(wnd.bp.frequency, 500 + 900 * i, 0.4);
  }

  // ---------------------------------------------------------------------------------------
  // one-shot sound effects — every voice disconnects all its nodes when its sources end
  // ---------------------------------------------------------------------------------------
  const sfxVoices = [];
  const lastSfx = {};
  function vStart(level, pan) {
    while (sfxVoices.length >= MAX_SFX_VOICES) stealVoice(sfxVoices[0]);
    const out = ctx.createGain();
    out.gain.value = level;
    const v = { out, nodes: [out], srcs: [], live: 0, dead: false };
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      v.nodes.push(p);
      out.connect(p); p.connect(sfxBus);
    } else out.connect(sfxBus);
    sfxVoices.push(v);
    return v;
  }
  function stealVoice(v) {
    const now = ctx.currentTime, i = sfxVoices.indexOf(v);
    if (i >= 0) sfxVoices.splice(i, 1);
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.setTargetAtTime(0, now, 0.01);
    for (const s of v.srcs) {
      if (s._t1 > now + 0.06) { try { s.stop(now + 0.06); s._t1 = now + 0.06; } catch (e) { /* ok */ } }
    }
  }
  function vDispose(v) {
    if (v.dead) return;
    v.dead = true;
    for (const n of v.nodes) safeDisconnect(n);
    const i = sfxVoices.indexOf(v);
    if (i >= 0) sfxVoices.splice(i, 1);
  }
  const vAdd = (v, n) => { v.nodes.push(n); return n; };
  function vSrc(v, src, t0, t1, off) {
    v.srcs.push(src); v.live++;
    src._t0 = t0; src._t1 = t1;
    src.onended = () => { if (--v.live <= 0) vDispose(v); };
    if (off) src.start(t0, off); else src.start(t0);
    src.stop(t1);
    return src;
  }
  function vGain(v, dest, val) {
    const g = vAdd(v, ctx.createGain());
    g.gain.value = val || 0;
    g.connect(dest);
    return g;
  }
  function vFilt(v, type, f, q, dest) {
    const b = vAdd(v, ctx.createBiquadFilter());
    b.type = type; b.frequency.value = f; b.Q.value = q;
    b.connect(dest);
    return b;
  }
  function vOsc(v, wave, f, t0, t1, dest) {
    const o = vAdd(v, ctx.createOscillator());
    setWave(o, wave);
    o.frequency.setValueAtTime(f, t0);
    o.connect(dest);
    return vSrc(v, o, t0, t1);
  }
  function vNoise(v, t0, t1, dest) {
    const n = vAdd(v, ctx.createBufferSource());
    n.buffer = noiseBuf; n.loop = true;
    n.connect(dest);
    return vSrc(v, n, t0, t1, 0.01 + Math.random() * (NOISE_LEN - 0.1));
  }
  // attack, then exponential decay with time constant tc
  function adEnv(param, t, peak, a, tc) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.setTargetAtTime(0, t + a, tc);
  }
  // attack / hold / linear release; returns end time
  function linEnv(param, t, peak, a, hold, r) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.setValueAtTime(peak, t + a + hold);
    param.linearRampToValueAtTime(0, t + a + hold + r);
    return t + a + hold + r;
  }
  // A short melody (note notation, `step` seconds per 16th) on ONE oscillator with
  // click-free per-note envelopes. Returns the end time.
  function vMelody(v, wave, notes, t, step, peak, dest, detune) {
    const p = parseVoice(notes);
    const o = vAdd(v, ctx.createOscillator()), g = vGain(v, dest, 0);
    setWave(o, wave);
    if (detune) o.detune.value = detune;
    o.connect(g);
    let end = t;
    for (const e of p.events) {
      const t0 = t + e.s * step, d = e.len * step;
      const a = Math.min(0.006, d * 0.2), r = Math.min(0.03, d * 0.35);
      const dk = Math.min(0.08, Math.max(0, d - a - r - 0.002));
      const s1 = peak * 0.75, s2 = d > 0.2 ? peak * 0.35 : s1;
      o.frequency.setValueAtTime(mtof(e.midi), t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      g.gain.linearRampToValueAtTime(s1, t0 + a + dk);
      g.gain.linearRampToValueAtTime(s2, t0 + d - r);
      g.gain.linearRampToValueAtTime(0, t0 + d - 0.001);
      end = t0 + d;
    }
    vSrc(v, o, t, end + 0.02);
    return end;
  }
  function sweep(param, t, f0, f1, dur) {
    param.setValueAtTime(f0, t);
    param.exponentialRampToValueAtTime(f1, t + dur);
  }

  const SFX = {
    menuMove(t) {
      const v = vStart(0.3), g = vGain(v, v.out);
      adEnv(g.gain, t, 1, 0.002, 0.026);
      sweep(vOsc(v, 'p25', 1480, t, t + 0.16, g).frequency, t, 1480, 1180, 0.05);
    },
    menuSelect(t) {
      const v = vStart(0.27);
      vMelody(v, 'p25', 'c6:1 g6 c7:3', t, 0.045, 1, v.out);
      vMelody(v, 'p12', 'e5:1 c6 e6:3', t, 0.045, 0.5, v.out, 6);
    },
    menuBack(t) {
      const v = vStart(0.2);
      vMelody(v, 'p50', 'g5:1 c5:2', t, 0.05, 1, v.out);
    },
    menuError(t) {
      const v = vStart(0.17), g = vGain(v, v.out), lp = vFilt(v, 'lowpass', 1200, 0.7, g);
      vOsc(v, 'sq', 150, t, t + 0.25, lp);
      vOsc(v, 'sawtooth', 157, t, t + 0.25, lp);
      const p = g.gain;
      p.setValueAtTime(0, t); p.linearRampToValueAtTime(1, t + 0.005);
      p.setValueAtTime(1, t + 0.07); p.linearRampToValueAtTime(0, t + 0.08);
      p.setValueAtTime(0, t + 0.11); p.linearRampToValueAtTime(1, t + 0.115);
      p.setValueAtTime(1, t + 0.2); p.linearRampToValueAtTime(0, t + 0.215);
    },
    pause(t) {
      const v = vStart(0.3);
      vMelody(v, 'p12', 'b5:2 e6 b6:5', t, 0.04, 1, v.out);
      vMelody(v, 'p25', 'e5:2 b5 e6:5', t, 0.04, 0.45, v.out);
    },
    count(t) {
      const v = vStart(0.3), g = vGain(v, v.out);
      linEnv(g.gain, t, 1, 0.004, 0.15, 0.08);
      vOsc(v, 'p50', 880, t, t + 0.26, g);
      vOsc(v, 'sine', 440, t, t + 0.26, vGain(v, g, 0.5));
    },
    go(t) {
      const v = vStart(0.32), g = vGain(v, v.out);
      const end = linEnv(g.gain, t, 1, 0.004, 0.45, 0.35);
      vOsc(v, 'p50', 1760, t, end + 0.02, g);
      vOsc(v, 'p25', 1318.5, t, end + 0.02, vGain(v, g, 0.55));
      vOsc(v, 'sine', 880, t, end + 0.02, vGain(v, g, 0.5));
    },
    lap(t) {
      const v = vStart(0.28);
      vMelody(v, 'p25', 'e5:1 a5 c#6 e6:2 c#6:1 e6:5', t, 0.055, 1, v.out);
      vMelody(v, 'p12', 'c#5:1 e5 a5 c#6:2 a5:1 c#6:5', t, 0.055, 0.45, v.out);
    },
    finalLap(t) {
      const v = vStart(0.3);
      vMelody(v, 'p25', 'e5:1 e5 e5 r g5 g5 g5 r a5 c6 e6 a6:6', t, 0.055, 1, v.out);
      vMelody(v, 'p12', 'c5:1 c5 c5 r e5 e5 e5 r e5 a5 c6 e6:6', t, 0.055, 0.5, v.out);
      vMelody(v, 'tri', 'a3:4 c4 e4:3 a3:6', t, 0.055, 0.8, v.out);
    },
    goal(t) {
      const v = vStart(0.32);
      vMelody(v, 'p25', 'g5:2 c6 e6 g6:2 e6:1 g6 c7:8', t, 0.06, 1, v.out);
      vMelody(v, 'p12', 'e5:2 g5 c6 e6:2 c6:1 e6 g6:8', t, 0.06, 0.5, v.out);
      vMelody(v, 'tri', 'c4:6 g3:4 c4:8', t, 0.06, 0.8, v.out);
      const g = vGain(v, v.out), hp = vFilt(v, 'highpass', 5000, 0.7, g);
      adEnv(g.gain, t + 0.48, 0.35, 0.003, 0.4);
      vNoise(v, t + 0.48, t + 2.3, hp);
    },
    record(t) {
      const v = vStart(0.36), line = 'c6:1 e6 g6 c7 e6 g6 c7 e7 g6 c7 e7 g7:4';
      vMelody(v, 'p12', line, t, 0.04, 1, v.out);
      vMelody(v, 'p25', line, t + 0.07, 0.04, 0.35, v.out, 8);
    },
    boostReady(t) {
      const v = vStart(0.26);
      vMelody(v, 'p12', 'e6:2 r:1 b6:5', t, 0.05, 1, v.out);
      vMelody(v, 'sine', 'e5:2 r:1 b5:5', t, 0.05, 0.6, v.out);
    },
    wallHit(t, o) {
      const pw = clamp(num(+o.power, 0.6), 0, 1), v = vStart(0.25 + 0.5 * pw);
      const g1 = vGain(v, v.out);
      adEnv(g1.gain, t, 1, 0.002, 0.06);
      sweep(vOsc(v, 'sine', 110, t, t + 0.35, g1).frequency, t, 110, 40, 0.15);
      const g2 = vGain(v, v.out), lp = vFilt(v, 'lowpass', 900 + 1500 * pw, 0.7, g2);
      adEnv(g2.gain, t, 0.9, 0.002, 0.05);
      vNoise(v, t, t + 0.3, lp);
      const g3 = vGain(v, v.out), bp = vFilt(v, 'bandpass', 2200, 9, g3);
      adEnv(g3.gain, t, 0.3 + 0.9 * pw, 0.001, 0.07);
      vNoise(v, t, t + 0.4, bp);
      const g4 = vGain(v, v.out);
      adEnv(g4.gain, t, 0.35, 0.002, 0.03);
      vOsc(v, 'sq', 74, t, t + 0.18, g4);
    },
    carHit(t, o) {
      const pw = clamp(num(+o.power, 0.6), 0, 1), v = vStart(0.2 + 0.45 * pw, clamp(num(+o.pan, 0), -1, 1));
      const g = vGain(v, v.out), bp = vFilt(v, 'bandpass', 1400, 2, g);
      adEnv(g.gain, t, 1, 0.001, 0.045);
      sweep(vOsc(v, 'sq', 340, t, t + 0.25, bp).frequency, t, 340, 250, 0.12);
      sweep(vOsc(v, 'sq', 489, t, t + 0.25, bp).frequency, t, 489, 377, 0.12);
      const g2 = vGain(v, v.out), hp = vFilt(v, 'highpass', 1800, 0.7, g2);
      adEnv(g2.gain, t, 0.6, 0.001, 0.03);
      vNoise(v, t, t + 0.2, hp);
    },
    boost(t) {
      const v = vStart(0.4);
      const g = vGain(v, v.out), bp = vFilt(v, 'bandpass', 400, 1.4, g);
      const end = linEnv(g.gain, t, 1, 0.03, 0.35, 0.6);
      sweep(bp.frequency, t, 400, 3200, 0.5);
      vNoise(v, t, end + 0.02, bp);
      const g2 = vGain(v, v.out), lp = vFilt(v, 'lowpass', 1800, 2, g2);
      linEnv(g2.gain, t, 0.5, 0.02, 0.3, 0.55);
      sweep(vOsc(v, 'sawtooth', 110, t, end + 0.02, lp).frequency, t, 110, 520, 0.45);
      const g3 = vGain(v, v.out);
      adEnv(g3.gain, t, 0.9, 0.003, 0.08);
      sweep(vOsc(v, 'sine', 90, t, t + 0.4, g3).frequency, t, 90, 40, 0.2);
    },
    dash(t) {
      const v = vStart(0.45);
      const g = vGain(v, v.out);
      adEnv(g.gain, t, 0.8, 0.004, 0.08);
      sweep(vOsc(v, 'sawtooth', 320, t, t + 0.4, g).frequency, t, 320, 1500, 0.2);
      const g2 = vGain(v, v.out);
      adEnv(g2.gain, t, 0.4, 0.004, 0.07);
      sweep(vOsc(v, 'p12', 640, t, t + 0.4, g2).frequency, t, 640, 3000, 0.2);
      const g3 = vGain(v, v.out), hp = vFilt(v, 'highpass', 3000, 0.7, g3);
      adEnv(g3.gain, t, 0.3, 0.004, 0.06);
      vNoise(v, t, t + 0.35, hp);
    },
    jump(t) {
      const v = vStart(0.26), g = vGain(v, v.out);
      const end = linEnv(g.gain, t, 1, 0.01, 0.2, 0.12);
      const o1 = vOsc(v, 'p25', 260, t, end + 0.02, g), o2 = vOsc(v, 'p12', 262, t, end + 0.02, vGain(v, g, 0.4));
      o1.frequency.linearRampToValueAtTime(820, t + 0.28);
      o2.frequency.linearRampToValueAtTime(1240, t + 0.28);
    },
    land(t, o) {
      const pw = clamp(num(+o.power, 0.5), 0, 1), v = vStart(0.22 + 0.4 * pw);
      const g = vGain(v, v.out);
      adEnv(g.gain, t, 1, 0.002, 0.06);
      sweep(vOsc(v, 'sine', 130, t, t + 0.35, g).frequency, t, 130, 45, 0.14);
      const g2 = vGain(v, v.out), lp = vFilt(v, 'lowpass', 700, 0.7, g2);
      adEnv(g2.gain, t, 0.7, 0.002, 0.04);
      vNoise(v, t, t + 0.25, lp);
    },
    mine(t) {
      const v = vStart(0.5);
      const g = vGain(v, v.out), lp = vFilt(v, 'lowpass', 2600, 0.8, g);
      adEnv(g.gain, t, 1, 0.002, 0.14);
      sweep(lp.frequency, t, 2600, 250, 0.45);
      vNoise(v, t, t + 0.9, lp);
      const g2 = vGain(v, v.out);
      adEnv(g2.gain, t, 1, 0.002, 0.1);
      sweep(vOsc(v, 'sine', 120, t, t + 0.6, g2).frequency, t, 120, 32, 0.35);
      const g3 = vGain(v, v.out), hp = vFilt(v, 'highpass', 3000, 0.7, g3);
      adEnv(g3.gain, t, 0.6, 0.001, 0.02);
      vNoise(v, t, t + 0.15, hp);
    },
    explode(t) {
      const v = vStart(0.65);
      const g = vGain(v, v.out), lp = vFilt(v, 'lowpass', 3500, 0.8, g);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.004);
      g.gain.setTargetAtTime(0, t + 0.05, 0.45);
      sweep(lp.frequency, t, 3500, 160, 1.6);
      vNoise(v, t, t + 2.4, lp);
      const g2 = vGain(v, v.out);
      adEnv(g2.gain, t, 1, 0.003, 0.25);
      sweep(vOsc(v, 'sine', 85, t, t + 1.4, g2).frequency, t, 85, 24, 0.9);
      const g3 = vGain(v, v.out), bp = vFilt(v, 'bandpass', 1800, 0.8, g3);
      g3.gain.setValueAtTime(0, t);
      for (let i = 0; i < 10; i++) {                        // debris crackle
        const tt = t + 0.08 + i * 0.1 + Math.random() * 0.04;
        g3.gain.setValueAtTime(0, tt);
        g3.gain.linearRampToValueAtTime(0.6 * (1 - i / 10), tt + 0.003);
        g3.gain.linearRampToValueAtTime(0, tt + 0.04);
      }
      vNoise(v, t, t + 1.3, bp);
    },
    rankOut(t) {
      const v = vStart(0.3);
      vMelody(v, 'p50', 'e5:3 c5 a4 f4:8', t, 0.06, 1, v.out);
      vMelody(v, 'p25', 'c5:3 a4 f4 d4:8', t, 0.06, 0.45, v.out);
      vMelody(v, 'tri', 'a3:3 f3 d3 bb2:8', t, 0.06, 0.8, v.out);
    },
    retire(t) {
      const v = vStart(0.36), g = vGain(v, v.out), lp = vFilt(v, 'lowpass', 2400, 1.5, g);
      const end = linEnv(g.gain, t, 1, 0.01, 0.9, 0.5);
      sweep(lp.frequency, t, 2400, 300, 1.3);
      const o = vOsc(v, 'sawtooth', 560, t, end + 0.02, lp);
      sweep(o.frequency, t, 560, 70, 1.3);
      vibrato(o.detune, t + 0.05, end, 45, 7);
      const g2 = vGain(v, v.out), hp = vFilt(v, 'highpass', 2000, 0.7, g2);
      linEnv(g2.gain, t, 0.25, 0.02, 0.5, 0.6);
      vNoise(v, t, end + 0.02, hp);
    },
  };
  const SFX_GAP = { wallHit: 0.07, carHit: 0.06, land: 0.08, menuMove: 0.02 };

  function sfx(name, opts) {
    if (!ctx || muted) return;
    const fn = SFX[name];
    if (!fn || !playable()) return;
    const now = ctx.currentTime, gap = SFX_GAP[name] || 0.03;
    if (lastSfx[name] !== undefined && now - lastSfx[name] < gap && now >= lastSfx[name]) return;
    lastSfx[name] = now;
    fn(now + 0.005, opts && typeof opts === 'object' ? opts : {});
  }

  // ---------------------------------------------------------------------------------------
  // scheduler tick + public API
  // ---------------------------------------------------------------------------------------
  function tick() {
    if (!ctx) return;
    const now = ctx.currentTime;
    // Adaptive look-ahead: ~0.15 s normally; when the timer fires late (throttled background
    // tab, ~1 s) schedule a little beyond the observed gap so the music stays continuous.
    const gap = lastTick < 0 ? 0 : now - lastTick;
    lastTick = now;
    lookahead = gap > 0.1 ? Math.min(MAX_LOOKAHEAD, gap + 0.25) : LOOKAHEAD;
    for (let i = disposals.length - 1; i >= 0; i--) {
      if (now >= disposals[i].t) {
        const d = disposals.splice(i, 1)[0];
        for (const n of d.nodes) safeDisconnect(n);
      }
    }
    if (song && !song.done) scheduleSong(now);
    if (pitOn && pitL) schedulePit(now);
    if (alarmOn && alm) scheduleAlarm(now);
    sleepLoops(now);
  }

  function init() {
    if (ctx) { resume(); return true; }
    if (available === false) return false;
    const AC = getAC();
    if (!AC) { available = false; return false; }
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
      try { ctx = new AC(); } catch (e2) { ctx = null; }
    }
    if (!ctx) { available = false; return false; }
    available = true;
    initWall = now0();
    comp = ctx.createDynamicsCompressor();             // bus limiter
    const cp = (k, v) => { if (comp[k]) comp[k].value = v; };
    cp('threshold', -10); cp('knee', 6); cp('ratio', 12); cp('attack', 0.003); cp('release', 0.25);
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : vol.master;
    musicBus = ctx.createGain(); musicBus.gain.value = vol.bgm * MUSIC_GAIN;
    sfxBus = ctx.createGain(); sfxBus.gain.value = vol.sfx;
    loopBus = ctx.createGain(); loopBus.gain.value = 1;
    loopBus.connect(sfxBus);
    musicBus.connect(comp); sfxBus.connect(comp);
    comp.connect(masterGain); masterGain.connect(ctx.destination);
    // shared white noise (deterministic LCG; no Math.random needed for the buffer itself)
    const len = Math.floor(ctx.sampleRate * NOISE_LEN);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    // iOS/Safari unlock: play one silent sample inside the user gesture
    try {
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.onended = () => safeDisconnect(b);
      b.start(0);
      b.stop(ctx.currentTime + 0.01);
    } catch (e) { /* ignore */ }
    timer = setInterval(guard(tick, 'tick'), TICK_MS);
    resume();
    hookGestures();
    if (pendingBgm) { const n = pendingBgm; pendingBgm = null; bgm(n); }
    return true;
  }

  function applyVolumes() {
    if (!ctx) return;
    setT(masterGain.gain, muted ? 0 : vol.master, 0.03);
    setT(musicBus.gain, vol.bgm * MUSIC_GAIN, 0.05);
    setT(sfxBus.gain, vol.sfx, 0.05);
  }
  function setVolume(o) {
    if (!o || typeof o !== 'object') return;
    if (o.master != null) vol.master = clamp(num(+o.master, vol.master), 0, 1);
    if (o.bgm != null) vol.bgm = clamp(num(+o.bgm, vol.bgm), 0, 1);
    if (o.sfx != null) vol.sfx = clamp(num(+o.sfx, vol.sfx), 0, 1);
    applyVolumes();
  }
  function setMuted(b) {
    muted = !!b;
    applyVolumes();
  }
  const isMuted = () => muted;

  function bgm(name) {
    if (name != null && !Object.prototype.hasOwnProperty.call(SONGS, name)) return;
    if (!ctx) { pendingBgm = name || null; return; }     // remembered; starts on init()
    if (song && song.name === name) return;               // already playing: idempotent
    if (!song && name == null) return;
    if (song) { stopSong(song, name == null ? 0.12 : 0.05); song = null; }
    if (name != null) { tempoTarget = 1; startSong(name); }
  }
  function bgmTempo(mult) {
    tempoTarget = clamp(num(+mult, 1), 0.5, 2);
  }

  // Errors inside audio must never break the game loop (tests set _dev.opts.strict).
  const warned = {};
  function guard(fn, name) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) {
        if (dev.strict) throw e;
        if (!warned[name] && typeof console !== 'undefined') { warned[name] = 1; console.warn('AUDIO.' + name, e); }
        return undefined;
      }
    };
  }

  return {
    init: guard(init, 'init'),
    setVolume: guard(setVolume, 'setVolume'),
    setMuted: guard(setMuted, 'setMuted'),
    isMuted,
    engine: guard(engine, 'engine'),
    scrape: guard(scrape, 'scrape'),
    pit: guard(pit, 'pit'),
    alarm: guard(alarm, 'alarm'),
    wind: guard(wind, 'wind'),
    sfx: guard(sfx, 'sfx'),
    bgm: guard(bgm, 'bgm'),
    bgmTempo: guard(bgmTempo, 'bgmTempo'),
    // development / test hooks (no side effects)
    _dev: {
      opts: dev, SONGS, RANGE, DRUM_CHARS, PITCHED, DRUM_ROWS,
      sfxNames: Object.keys(SFX), bgmNames: Object.keys(SONGS),
      parseVoice, parseDrums, compile, noteToMidi, midiToNote,
      internals: () => ({ ctx, comp, masterGain, musicBus, sfxBus, loopBus, song, eng, scr, pitL, alm, wnd }),
      stats() {
        return {
          ctx: !!ctx, voices: sfxVoices.length, disposals: disposals.length, tempoTarget, lookahead,
          song: song ? {
            name: song.name, step: song.step, loops: song.loops, done: song.done, mult: song.mult,
            stepDur: stepDur(song), sources: song.sources.size, notes: song.notes, length: song.comp.length,
          } : null,
          loops: { engine: !!eng, scrape: !!scr, pit: !!pitL, alarm: !!alm, wind: !!wnd },
        };
      },
    },
  };
})();
