// Render real game frames headlessly to PNG: node dev/frame-test.mjs [courseId] [seconds...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePNG, upscale } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '../parts', f), 'utf8');
const has = (f) => fs.existsSync(path.join(here, '../parts', f));

// stub theme used until themes.js exists
const STUB = `const THEMES = (() => { const pal = { road:[86,92,112], roadAlt:[80,86,104], roadSeam:[60,64,80], roadLine:[220,220,230],
 railA:[240,190,40], railB:[30,30,40], railLight:[255,250,200], railDark:[20,20,28], shoulder:[10,10,16], startA:[250,250,250], startB:[20,20,20],
 pit:[200,60,170], pitStripe:[150,40,130], dash:[255,210,40], dashDark:[120,80,10], jump:[80,160,255], jumpDark:[30,60,140], rough:[140,110,70], roughDark:[90,70,40],
 ice:[180,225,255], iceLight:[240,250,255], minimapRoad:'#ccd', minimapBg:'#000', hudAccent:'#ffd23a' };
 const th = { id:'stub', name:'STUB', fog:[60,40,90], palette: pal, weather: null,
  buildGroundTile(n){ const a=new Uint32Array(n*n); for(let y=0;y<n;y++)for(let x=0;x<n;x++){ const b=((x>>5)+(y>>5))&1; const g=b?40:28; a[y*n+x]=((255<<24)|((g+20)<<16)|(g<<8)|g)>>>0;} return a; },
  buildPanorama(w,h){ const a=new Uint8ClampedArray(w*h*4); for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4; a[i]=20+y; a[i+1]=10+y*0.4; a[i+2]=60+y; a[i+3]=255; if (y>h-20 && ((x*7)%37)<14 && y > h-20+((x*13)%17)) {a[i]=10;a[i+1]=10;a[i+2]=20;} } return a; } };
 return { ids:['neon','coast','desert','gale','frost','inferno'], get: () => th }; })();`;

let src = '';
src += has('themes.js') ? read('themes.js') : STUB;
src += '\n' + read('cars.js') + '\n' + read('core-sim.js') + '\n' + read('core-render.js');
const { SIM, RENDER, THEMES, CARS } = new Function(src + '\nreturn { SIM, RENDER, THEMES, CARS };')();

const courseId = process.argv[2] || 'neon';
const times = process.argv.slice(3).map(Number);
if (!times.length) times.push(0, 6, 14);
const def = SIM.courseById(courseId);
let t0 = performance.now();
const T = SIM.buildTrack(def);
const world = RENDER.buildWorld(T, THEMES.get(def.theme));
console.log('world build', (performance.now() - t0).toFixed(0), 'ms');
t0 = performance.now();
const sheets = RENDER.prepSheets(CARS, ['comet', 'lynx', 'bison', 'hornet', 'drone0', 'drone1', 'drone2', 'drone3', 'drone4', 'drone5']);
console.log('sheets', (performance.now() - t0).toFixed(0), 'ms');
const race = SIM.createRace(T, { mode: 'gp', playerMachine: 'comet', difficulty: 'standard', seed: 3 });
race.autopilot = true; SIM.setupAI(race, race.player); race.player.ai.skill = 1;
const view = RENDER.createView();
const cam = RENDER.createCamera();
const fx = RENDER.createFx();
RENDER.followCamera(cam, race.player, 0, true);
let simT = -race.count;
let rendMs = 0, frames = 0;
for (const target of times) {
  while (simT < target) {
    SIM.step(race);
    simT += SIM.DT;
    if ((race.tick & 1) === 0) { RENDER.followCamera(cam, race.player, SIM.DT * 2, false); RENDER.updateFx(fx, SIM.DT * 2); }
    race.events.length = 0;
  }
  const r0 = performance.now();
  RENDER.renderWorld(view, world, cam, race, sheets, fx, {});
  rendMs += performance.now() - r0; frames++;
  const rgba = new Uint8Array(view.buf.buffer);
  const out = path.join(here, `preview/frame-${courseId}-${target}.png`);
  writePNG(out, 384 * 2, 216 * 2, upscale(384, 216, rgba, 2));
  console.log('wrote', out, 'player s', race.player.s.toFixed(0), 'rank', race.player.rank);
}
console.log('avg render', (rendMs / frames).toFixed(2), 'ms');
