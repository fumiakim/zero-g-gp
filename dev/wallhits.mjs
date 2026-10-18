import fs from 'node:fs';
const src = fs.readFileSync(new URL('../parts/core-sim.js', import.meta.url), 'utf8');
const SIM = new Function(src + '\nreturn SIM;')();
const id = process.argv[2] || 'coast';
const T = SIM.buildTrack(SIM.courseById(id));
const hist = {};
for (let seed = 1; seed <= 6; seed++) {
  const race = SIM.createRace(T, { mode: 'gp', playerMachine: process.argv[3] || 'comet', difficulty: 'standard', seed, countdown: 0.01 });
  race.autopilot = true; SIM.setupAI(race, race.player); race.player.ai.skill = 1;
  const p = race.player;
  while (!p.finished && !p.retired && race.t < 300) {
    SIM.step(race);
    for (const e of race.events) if (e.type === 'wallHit' && e.car === p.id) { const k = Math.round(p.s / 100) * 100; hist[k] = (hist[k] || 0) + 1; }
    race.events.length = 0;
  }
}
const pieces = [];
console.log(id, 'L', T.L.toFixed(0), 'jumps', T.jump.map(j => j.s.toFixed(0)), 'dash', T.dash.map(j => j.s.toFixed(0)));
console.log(Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `s${k}:${v}`).join('  '));
// curvature near hits
for (const k of Object.keys(hist)) { const i = Math.floor(+k / T.step); console.log(k, 'R', T.R[i % T.n].toFixed(0), 'slip', T.slip[i % T.n]); }
