// FLAC encoder check: encode many kinds of audio, decode with ffmpeg (stopping at any CRC error) and compare every sample.
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process'), assert = require('assert');
global.self = global;
require(path.join(__dirname, '..', 'flac.js'));
const FLAC = self.FLAC, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-'));
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

function signal(kind, n, bps, ch) {
  const max = 2 ** (bps - 1) - 1, out = [];
  for (let c = 0; c < ch; c++) {
    const x = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let v;
      if (kind === 'silence') v = 0;
      else if (kind === 'noise') v = rnd() * 2 * max;
      else if (kind === 'full') v = i % 2 ? max : -max - 1;              // extreme values, full swing
      else if (kind === 'music') v = max * (0.5 * Math.sin(i * (0.031 + c * 0.002)) + 0.2 * Math.sin(i * 0.17) + 0.05 * rnd());
      else v = max * 0.6 * Math.sin(i * 0.02 + c);                        // sine, the two channels nearly the same
      x[i] = Math.max(-max - 1, Math.min(max, Math.round(v)));
    }
    out.push(x);
  }
  return out;
}
function decode(file, bps, ch) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-err_detect', 'crccheck+bitstream+buffer+explode', '-i', file, '-f', bps === 16 ? 's16le' : 's32le', '-'], { maxBuffer: 1 << 30 });
  const n = raw.length / (bps === 16 ? 2 : 4) / ch, chans = Array.from({ length: ch }, () => new Int32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) chans[c][i] = bps === 16 ? raw.readInt16LE((i * ch + c) * 2) : raw.readInt32LE((i * ch + c) * 4) >> 8;
  return chans;
}
(async () => {
  let cases = 0;
  for (const bps of [16, 24]) for (const ch of [1, 2]) for (const kind of ['sine', 'music', 'noise', 'silence', 'full'])
    for (const n of [1, 100, 4096, 4097, 50000]) {
      const x = signal(kind, n, bps, ch);
      const bytes = await FLAC.encode({ channels: x, sampleRate: n === 100 ? 48000 : 44100, bitsPerSample: bps });
      const f = path.join(tmp, `t.flac`); fs.writeFileSync(f, bytes);
      const y = decode(f, bps, ch);
      assert.strictEqual(y[0].length, n, `${kind} ${bps}-bit ${ch}ch ${n}: length ${y[0].length}`);
      for (let c = 0; c < ch; c++) for (let i = 0; i < n; i++) if (y[c][i] !== x[c][i]) assert.fail(`${kind} ${bps}-bit ${ch}ch ${n}: sample ${i} ch ${c}: ${y[c][i]} ≠ ${x[c][i]}`);
      // MD5 in STREAMINFO = MD5 of the samples (as ffmpeg computes it)
      const md5 = Buffer.from(bytes.subarray(4 + 4 + 18, 4 + 4 + 34)).toString('hex');
      const ref = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'md5', '-c:a', bps === 16 ? 'pcm_s16le' : 'pcm_s24le', '-'], { encoding: 'utf8' }).trim().split('=')[1];
      assert.strictEqual(md5, ref, `${kind} ${bps}-bit ${ch}ch ${n}: MD5`);
      cases++;
    }
  // metadata: tags and cover
  const cover = fs.readFileSync(path.join(__dirname, '..', 'icons', 'cover.jpg'));
  const x = signal('music', 88200, 24, 2);
  const bytes = await FLAC.encode({ channels: x, sampleRate: 44100, bitsPerSample: 24, tags: { title: 'Travelogue', artist: 'SHAPE', genre: 'Ambient', year: '2026', bpm: '119', comment: 'Made it while … travelling' }, cover: { bytes: new Uint8Array(cover), mime: 'image/jpeg' } });
  const f = path.join(tmp, 'tags.flac'); fs.writeFileSync(f, bytes);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_name,width,height:stream_disposition=attached_pic', '-of', 'json', f], { encoding: 'utf8' });
  const j = JSON.parse(probe), t = Object.fromEntries(Object.entries(j.format.tags).map(([k, v]) => [k.toLowerCase(), v]));
  assert.deepStrictEqual([t.title, t.artist, t.genre, t.date, t.bpm, t.comment], ['Travelogue', 'SHAPE', 'Ambient', '2026', '119', 'Made it while … travelling']);
  const pic = j.streams.find((s) => s.codec_name === 'mjpeg');
  assert.ok(pic && pic.width === 1400 && pic.height === 1400 && pic.disposition.attached_pic === 1, 'front cover picture');
  const out = path.join(tmp, 'pic.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-f', 'image2', out, '-y']);
  assert.ok(fs.readFileSync(out).equals(cover), 'picture bytes unchanged');
  const ratio = bytes.length / (88200 * 2 * 3);
  console.log(`${cases} signal cases bit-exact with matching MD5; tags + cover OK; music 24-bit compresses to ${(ratio * 100).toFixed(0)}% of WAV`);
  console.log('all checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
