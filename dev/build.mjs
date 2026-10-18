// Assemble the single-file game: node dev/build.mjs  ->  index.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ORDER = ['font.js', 'themes.js', 'cars.js', 'audio.js', 'core-sim.js', 'core-render.js', 'core-app.js'];
const parts = ORDER.map((f) => {
  const p = path.join(root, 'parts', f);
  if (!fs.existsSync(p)) {
    if (f === 'audio.js' && process.env.STUB_AUDIO) {
      console.warn('WARNING: audio.js missing - using silent stub');
      return `// ----- ${f} (STUB) -----\nconst AUDIO = (() => { const n = () => {}; let m = false; return { init: n, setVolume: n, setMuted: (v) => { m = v; }, isMuted: () => m, engine: n, scrape: n, pit: n, alarm: n, wind: n, sfx: n, bgm: n, bgmTempo: n }; })();`;
    }
    throw new Error('missing part: ' + f);
  }
  return `// ----- ${f} -----\n` + fs.readFileSync(p, 'utf8').trimEnd();
});
const js = "'use strict';\n" + parts.join('\n\n');
if (js.includes('</script')) throw new Error('script contains </script');
const tpl = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
const html = tpl.replace('/*@@SCRIPT@@*/', () => js);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('index.html', (html.length / 1024).toFixed(1), 'KB,', html.split('\n').length, 'lines');
