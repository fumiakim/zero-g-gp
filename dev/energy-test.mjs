// where does the player's energy go? node dev/energy-test.mjs [course]
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../parts/core-sim.js', import.meta.url), 'utf8');
const SIM = new Function(src + '\nreturn SIM;')();
for (const id of (process.argv[2] ? [process.argv[2]] : SIM.COURSES.map(c => c.id))) {
  const T = SIM.buildTrack(SIM.courseById(id));
  const agg = { wall: 0, car: 0, scrape: 0, mine: 0, n: 0, lap1: 0 };
  for (let seed = 1; seed <= 6; seed++) {
    const race = SIM.createRace(T, { mode: 'gp', playerMachine: 'comet', difficulty: 'standard', seed, countdown: 0.01, playerSlot: 11 });
    race.autopilot = true; SIM.setupAI(race, race.player); race.player.ai.skill = 1;
    const p = race.player;
    let prevE = p.energy;
    while (!p.finished && !p.retired && race.t < 300) {
      SIM.step(race);
      let cause = null;
      for (const e of race.events) {
        if (e.type === 'carHit' && (e.car === p.id || e.other === p.id)) cause = 'car';
        if (e.type === 'wallHit' && e.car === p.id) cause = 'wall';
        if (e.type === 'mine' && e.car === p.id) cause = 'mine';
      }
      race.events.length = 0;
      const d = prevE - p.energy;
      if (d > 0) agg[cause || 'scrape'] += d;
      prevE = p.energy;
      if (p.lapsDone === 1 && !agg['l' + seed]) { agg['l' + seed] = 1; agg.lap1 += 100 - p.energy; }
    }
    agg.n++;
  }
  console.log(id.padEnd(8), Object.fromEntries(Object.entries(agg).filter(([k]) => !k.startsWith('l') || k === 'lap1').map(([k, v]) => [k, typeof v === 'number' ? +(v / 6).toFixed(1) : v])));
}
