// Compare player-sprite viewing pitches on a real frame: node dev/pitch-exp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG, upscale } from './png.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '../parts', f), 'utf8');
const { SIM, RENDER, THEMES, CARS } = new Function(['themes.js', 'cars.js', 'core-sim.js', 'core-render.js'].map(read).join('\n') + '\nreturn { SIM, RENDER, THEMES, CARS };')();
const def = SIM.courseById(process.argv[2] || 'neon');
const T = SIM.buildTrack(def);
const world = RENDER.buildWorld(T, THEMES.get(def.theme));
const race = SIM.createRace(T, { mode: 'gp', playerMachine: 'comet', difficulty: 'standard', seed: 3 });
race.autopilot = true; SIM.setupAI(race, race.player);
const cam = RENDER.createCamera(), fx = RENDER.createFx(), view = RENDER.createView();
let t = -race.count;
while (t < 12) { SIM.step(race); t += SIM.DT; if ((race.tick & 1) === 0) RENDER.followCamera(cam, race.player, SIM.DT * 2, false); race.events.length = 0; }
const pitches = (process.argv[3] || '28,20,16,12').split(',').map(Number);
const keys = ['comet', 'lynx', 'bison', 'hornet', 'drone0', 'drone1', 'drone2', 'drone3', 'drone4', 'drone5'];
for (const p of pitches) {
  const sheets = {};
  for (const k of keys) {
    const mk = (ppu, pitch) => { const sh = CARS.buildSheet(k, { pxPerUnit: ppu, pitchDeg: pitch, yawSteps: 32, bankDeg: [-18, 0, 18] }); return { sheet: sh, px: new Uint32Array(sh.pixels.buffer, sh.pixels.byteOffset, sh.width * sh.height) }; };
    const near = mk(4, p), far = mk(2, Math.max(4, p * 0.45));
    sheets[k] = { near, mid: near, far, farHi: far, list: [near, far] };
  }
  RENDER.renderWorld(view, world, cam, race, sheets, fx, {});
  writePNG(path.join(here, `preview/pitch-${p}.png`), 768, 432, upscale(384, 216, new Uint8Array(view.buf.buffer), 2));
}
console.log('done', pitches);
