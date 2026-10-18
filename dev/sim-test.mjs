// Headless race simulation: node dev/sim-test.mjs [courseId] [mode]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../parts/core-sim.js'), 'utf8');
const SIM = new Function(src + '\nreturn SIM;')();

const only = process.argv[2];
const mode = process.argv[3] || 'attract';
const diff = process.argv[4] || 'standard';
for (const def of SIM.COURSES) {
  if (only && only !== 'all' && def.id !== only) continue;
  const T = SIM.buildTrack(def);
  const race = SIM.createRace(T, { mode, playerMachine: 'comet', difficulty: diff, seed: 7, countdown: 0.01 });
  if (mode !== 'attract') { race.autopilot = true; SIM.setupAI(race, race.player); race.player.ai.skill = 1; }
  const t0 = performance.now();
  let ticks = 0;
  const evc = {};
  let stuck = 0;
  const lastProg = new Map();
  while (race.doneT < 0 && race.t < 400) {
    if (mode !== 'attract' && race.player && !race.player.finished && !race.player.retired) {
      // crude "player": use the AI controller for the player too
      if (!race.player.ai) SIM.setupAI(race, race.player);
      race.player.ai.skill = 1;
    }
    SIM.step(race);
    ticks++;
    if (mode !== 'attract' && race.player && race.player.ai && !race.player.finished && !race.player.retired) {
      // drive player with AI each tick (step skips AI for player before finishing)
    }
    for (const e of race.events) evc[e.type] = (evc[e.type] || 0) + 1;
    race.events.length = 0;
    if (ticks % 600 === 0) {
      for (const c of race.cars) {
        if (c.retired || c.finished) continue;
        const prev = lastProg.get(c.id);
        if (prev !== undefined && c.raceDist - prev < 200) stuck++;
        lastProg.set(c.id, c.raceDist);
      }
    }
  }
  const ms = performance.now() - t0;
  const res = SIM.classify(race);
  console.log(`\n=== ${def.id} L=${T.L.toFixed(0)} simT=${race.t.toFixed(1)}s cpu=${ms.toFixed(0)}ms (${(ms / ticks * 1000).toFixed(1)}us/tick) stuckFlags=${stuck}`);
  console.log('events', JSON.stringify(evc));
  for (const r of res) {
    const c = race.cars[r.id];
    const laps = r.lapTimes.map((t) => t.toFixed(1)).join(' ');
    console.log(`${String(r.pos).padStart(2)} ${r.name.padEnd(11)} ${r.retired ? ('RET:' + r.retired).padEnd(12) : SIM.fmtTime(r.time).padEnd(12)} laps[${laps}] wall=${c.stats.wallHits} car=${c.stats.carHits} vmax=${(c.stats.maxSpeed * SIM.KMH).toFixed(0)} E=${c.energy.toFixed(0)}`);
  }
}
