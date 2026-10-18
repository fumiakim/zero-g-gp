// machine balance: autopilot player (skill 1) per machine per course, solo time attack
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../parts/core-sim.js', import.meta.url), 'utf8');
const SIM = new Function(src + '\nreturn SIM;')();
const mode = process.argv[2] || 'ta';
console.log('course   ' + SIM.HERO_KEYS.map(k => k.padStart(16)).join(''));
for (const def of SIM.COURSES) {
  const T = SIM.buildTrack(def);
  const row = [];
  for (const k of SIM.HERO_KEYS) {
    const race = SIM.createRace(T, { mode, playerMachine: k, difficulty: process.argv[3] || 'standard', seed: 5, countdown: 0.01 });
    race.autopilot = true; SIM.setupAI(race, race.player); race.player.ai.skill = 1; race.player.vmul = 1;
    const p = race.player;
    while (!p.finished && !p.retired && race.t < 300) { SIM.step(race); race.events.length = 0; }
    row.push(p.finished ? `${SIM.fmtTime(p.finishT)} P${p.place} E${p.energy.toFixed(0)}`.padStart(16) : ('RET ' + p.retired).padStart(16));
  }
  console.log(def.id.padEnd(9) + row.join(''));
}
