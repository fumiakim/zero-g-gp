// combine PNG frames into a grid (decode via zlib) : node montage.mjs out.png cols a.png b.png ...
import fs from 'node:fs'; import zlib from 'node:zlib'; import { writePNG } from './png.mjs';
function decode(p) {
  const b = fs.readFileSync(p); let o = 8, w, h; const idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o); const type = b.toString('ascii', o + 4, o + 8); const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); } else if (type === 'IDAT') idat.push(data); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) { if (raw[y * (w * 4 + 1)] !== 0) throw new Error('filter'); raw.copy(out, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)); }
  return { w, h, d: out };
}
const [out, cols, ...files] = process.argv.slice(2); const imgs = files.map(decode); const c = +cols, r = Math.ceil(imgs.length / c);
const W = imgs[0].w, H = imgs[0].h, img = new Uint8Array(W * c * H * r * 4);
imgs.forEach((im, i) => { const ox = (i % c) * W, oy = Math.floor(i / c) * H; for (let y = 0; y < H; y++) img.set(im.d.subarray(y * W * 4, (y + 1) * W * 4), ((oy + y) * W * c + ox) * 4); });
writePNG(out, W * c, H * r, img);
