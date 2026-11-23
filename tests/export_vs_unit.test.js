// Compares the app's stereo mix export with the Model 12's own export of the same song.
//   node tests/export_vs_unit.test.js "<card copy>" "<song folder>" "<MUSIC file name>"
const fs = require('fs'), path = require('path');
global.self = global;
self.Model12 = require('../model12.js');
require('../cardio.js');
const M = self.Model12, C = self.CardIO;
const [dir, folder, mixName] = process.argv.slice(2);
function walk(d, base = d, out = []) {
  for (const n of fs.readdirSync(d)) {
    const full = path.join(d, n), st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, getFile: async () => new Blob([fs.readFileSync(full)]) });
  }
  return out;
}
(async () => {
  const card = await M.loadCard(walk(dir));
  const files = await C.exportMixBlobs(card, folder);
  const mine = new Uint8Array(await files[0].blob.arrayBuffer());
  const unit = fs.readFileSync(path.join(dir, 'MUSIC', mixName));
  const bext = M.findChunk(unit, 'bext');
  const timeBytes = new Set(Array.from({ length: 18 }, (_, i) => bext.body + 320 + i)); // export date/time
  let diff = 0;
  for (let i = 0; i < Math.max(mine.length, unit.length); i++) if (mine[i] !== unit[i] && !timeBytes.has(i)) diff++;
  console.log(`app: ${files[0].name} ${mine.length} bytes | unit: ${mixName} ${unit.length} bytes | differing bytes (apart from the export time): ${diff}`);
  console.log(diff === 0 && mine.length === unit.length ? 'PASS export is identical to the Model 12\'s own' : 'FAIL');
  process.exit(diff === 0 && mine.length === unit.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
