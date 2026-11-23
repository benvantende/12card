// Run: node tests/model12.test.js <path-to-card-copy>
// Checks the parser against a real card copy on disk.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const M = require('../model12.js');

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({
      path: path.relative(path.dirname(base), full).split(path.sep).join('/'),
      size: st.size,
      getFile: async () => new Blob([fs.readFileSync(full)]),
    });
  }
  return out;
}

// Unit checks that don't need a card
assert.deepStrictEqual(M.fatDateTime(0x5b51, 0xae32), new Date(2025, 9, 17, 21, 49, 36));
assert.strictEqual(M.findCardRoot(['SD CARD 01/MTR/TV/song.sys', 'SD CARD 01/tascam_m.sys']), 'SD CARD 01');
assert.strictEqual(M.findCardRoot(['MTR/TV/song.sys']), '');
{
  const f = M.pcmToFloat(new Uint8Array([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80]), 24, 1, 0);
  assert.ok(Math.abs(f[0] - 8388607 / 8388608) < 1e-9 && f[1] === -1);
  const g = M.pcmToFloat(new Uint8Array([0x00, 0x80, 0xff, 0x7f]), 16, 2, 1);
  assert.ok(Math.abs(g[0] - 32767 / 32768) < 1e-9);
}

// Name rules (case-insensitive card, 11 chars, plain characters)
{
  const songs = [{ folder: 'TV' }, { folder: 'WANDERING' }, { folder: 'epistem 01' }];
  const v = (n, own) => M.validateSongName(n, songs, own);
  assert.ok(v('tv 2', 'TV').ok);
  assert.ok(v('tv', 'TV').ok && v('tv', 'TV').caseOnly, 'case-only rename allowed, flagged');
  assert.ok(!v('TV', 'TV').ok && v('TV', 'TV').same, 'same name is a no-op');
  assert.ok(!v('wandering', 'TV').ok, 'clash ignoring case');
  assert.ok(!v('EPISTEM 01', 'TV').ok, 'clash ignoring case (with space)');
  assert.ok(!v('twelve chars', 'TV').ok, 'max 11');
  assert.ok(v('eleven char', 'TV').ok);
  for (const bad of ['a/b', 'a:b', 'a?', 'é', 'a"b', ' lead', 'trail ', 'dot.', '', '~tmm1', 'tmmtmp_x']) assert.ok(!v(bad, 'TV').ok, `reject "${bad}"`);
  for (const good of ['Take 2 (ok)', 'mix_v3', 'A&B-#1']) assert.ok(v(good, 'TV').ok, `accept "${good}"`);
  assert.strictEqual(M.renamedTrackFile('01_TV_TR01.wav', 'TV', 'tv 2'), '01_tv 2_TR01.wav');
  assert.strictEqual(M.renamedTrackFile('01_A_TR_B_TR12.wav', 'A_TR_B', 'x'), '01_x_TR12.wav');
  assert.strictEqual(M.renamedTrackFile('song.sys', 'TV', 'x'), 'song.sys');
  assert.strictEqual(M.renamedTrackFile('tempTr1_A.bin', 'TV', 'x'), 'tempTr1_A.bin');
}

(async () => {
  // tascam_m.sys current-song rewrite, checked against the unit's own write (WANDERING -> TV)
  const base = '/mnt/user-data/uploads/TASCAM-MODEL-MANAGER/';
  if (fs.existsSync(base + 'SD CARD 01/tascam_m.sys') && fs.existsSync(base + 'SD CARD 02/tascam_m.sys')) {
    const before = fs.readFileSync(base + 'SD CARD 01/tascam_m.sys');
    const unit = fs.readFileSync(base + 'SD CARD 02/tascam_m.sys');
    assert.deepStrictEqual(Buffer.from(M.setCurrentSongName(before, 'TV')), unit, 'matches what the Model 12 writes');
    console.log('setCurrentSongName matches the unit byte for byte');
  }

  for (const dir of process.argv.slice(2)) {
    const card = await M.loadCard(walk(dir));
    console.log(`\n== ${dir}  current song: ${card.info && card.info.currentSong}  music files: ${card.music.length}`);
    for (const s of card.songs.sort((a, b) => a.folder.localeCompare(b.folder))) {
      const sys = s.sys || {};
      console.log(
        `${s.folder.padEnd(12)} used ${String(s.used).padStart(2)}/12  ${s.sampleRate}Hz/${s.bitsPerSample}bit` +
        `  ${(s.duration || 0).toFixed(1)}s  tempo ${sys.tempo}  marks ${JSON.stringify(sys.marks)}` +
        `  protected ${sys.protected}  created ${sys.created && sys.created.toISOString().slice(0, 10)}` +
        (s.warnings.length ? `  WARN: ${s.warnings.join('; ')}` : '')
      );
      if (s.sys && s.bitsPerSample) assert.strictEqual(sys.bytesPerSample * 8, s.bitsPerSample, 'song.sys bit depth matches WAV');
    }
  }
  
// --- song info (metadata.txt) ---
{
  const txt = '# c\n[TV]\ntitle = Hello\nartist=Ben\ncomment = a\\nb \\\\ c\nbogus = x\n[tv 2]\nyear = 2025\n';
  const p = M.parseMetadata(txt);
  assert.deepStrictEqual(p, { TV: { title: 'Hello', artist: 'Ben', comment: 'a\nb \\ c' }, 'tv 2': { year: '2025' } });
  assert.deepStrictEqual(M.parseMetadata(M.serializeMetadata(p)), p, 'metadata round trip');
  assert.ok(!M.serializeMetadata({ X: { title: '  ' } }).includes('[X]'), 'empty sections are left out');
}
// --- WAV tags ---
{
  assert.strictEqual(M.wavTagChunks({}).length, 0, 'no tags, no chunks');
  const t = M.wavTagChunks({ title: 'Tïtle', year: '2026' });
  assert.strictEqual(String.fromCharCode(...t.subarray(0, 4)), 'LIST');
  const listLen = 8 + new DataView(t.buffer).getUint32(4, true);
  assert.strictEqual(String.fromCharCode(...t.subarray(listLen + (listLen & 1), listLen + 4)), 'id3 ');
  assert.strictEqual(t.length % 2, 0, 'chunks are word-aligned');
}
// --- new song.sys ---
{
  const fs = require('fs'), path = require('path');
  const tpl = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'song_protected.sys')));
  const n = M.newSongSys(tpl, new Date(2026, 10, 20, 15, 30, 10));
  const s = M.parseSongSys(n);
  assert.strictEqual(s.protected, false); assert.strictEqual(s.tempo, 120); assert.strictEqual(s.marks.length, 0);
  assert.strictEqual(s.created.getFullYear(), 2026); assert.strictEqual(s.created.getHours(), 15);
  const changed = [...n].map((v, i) => (v !== tpl[i] ? i : -1)).filter((i) => i >= 0);
  assert.ok(changed.every((i) => i === 0x20 || (i >= 0x5c && i <= 0x5f) || (i >= 0xd0 && i < 0xd0 + 396) || i === 0x25c || i === 0x262), 'only the reset fields change');
}

// --- tempo estimate on synthetic beats (kick on every beat, quieter hat on the off-beats) ---
{
  for (const bpm of [86, 100, 119, 128, 140]) {
    const sr = 44100, secs = 20, x = new Float32Array(sr * secs), beat = 60 / bpm;
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (let t = 0; t < secs; t += beat) {
      const k = Math.floor(t * sr);
      for (let i = 0; i < 2000 && k + i < x.length; i++) x[k + i] += 0.8 * Math.sin(2 * Math.PI * 60 * i / sr) * Math.exp(-i / 400);
      const h = Math.floor((t + beat / 2) * sr);
      for (let i = 0; i < 600 && h + i < x.length; i++) x[h + i] += 0.25 * rnd() * Math.exp(-i / 120);
    }
    const e = M.estimateTempo(x, sr);
    assert.ok(Math.abs(e.bpm - bpm) < 1, `tempo ${bpm}: estimated ${e.bpm}`);
  }
  assert.strictEqual(M.estimateTempo(new Float32Array(44100 * 3), 44100), null, 'too short: no estimate');
  const tags = M.wavTagChunks({ bpm: '86.4' });
  assert.ok(Buffer.from(tags).includes(Buffer.from('TBPM')), 'BPM goes into the ID3 tag');
  assert.deepStrictEqual(M.parseMetadata(M.serializeMetadata({ X: { bpm: '86' } })), { X: { bpm: '86' } });
}

// --- cover art in the ID3 tag ---
{
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const tags = Buffer.from(M.wavTagChunks({}, undefined, { bytes: jpg, mime: 'image/jpeg' }));
  const i = tags.indexOf('APIC');
  assert.ok(i > 0, 'cover alone still makes a tag');
  const body = tags.subarray(i + 10, i + 10 + tags.readUInt32BE(i + 4));
  assert.strictEqual(body.subarray(1, 11).toString(), 'image/jpeg');
  assert.strictEqual(body[12], 3, 'picture type 3 = front cover');
  assert.ok(Buffer.from(jpg).equals(body.subarray(body.length - jpg.length)), 'image bytes unchanged');
  const card = M.scanEntries([{ path: 'tascam_m.sys', size: 2360 }, { path: 'cover.jpg', size: 9 }, { path: 'MTR/A/song.sys', size: 2048 }]);
  assert.strictEqual(card.coverEntry && card.coverEntry.path, 'cover.jpg', 'cover.jpg in the card root is found');
}
console.log('\nall checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
