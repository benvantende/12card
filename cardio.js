/*
 * cardio.js — reading and writing the card through the browser's File System Access API.
 *
 * Everything that changes the card lives here, written to be careful:
 *  - check the song folder before touching it
 *  - rename by creating the new folder and moving files into it (Chrome can move files, not folders);
 *    a move only changes the directory entry, the audio itself is not copied
 *  - files the browser refuses to move (e.g. song.sys in Chrome, everything in Brave) are copied
 *    and checked byte for byte instead
 *  - on any error, undo what was done; only after verification is anything deleted
 */
(function (root) {
  'use strict';
  const M = root.Model12;

  class CardError extends Error {}

  async function listDir(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) out.push({ name, handle: h, kind: h.kind });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function exists(dir, name) {
    // Look the name up case-insensitively, like the card does.
    const lower = name.toLowerCase();
    for await (const n of dir.keys()) if (n.toLowerCase() === lower) return n;
    return null;
  }

  async function inventory(dir) {
    const items = await listDir(dir);
    const files = [];
    for (const it of items) {
      if (it.kind !== 'file') throw new CardError(`Unexpected folder "${it.name}" inside the song folder. Not touching it.`);
      const f = await it.handle.getFile(); // also proves the file is readable
      files.push({ name: it.name, handle: it.handle, size: f.size });
    }
    return files;
  }

  const CHUNK = 4 * 1024 * 1024;

  async function copyFile(srcHandle, dstDir, dstName, onBytes) {
    const src = await srcHandle.getFile();
    const dst = await dstDir.getFileHandle(dstName, { create: true });
    const w = await dst.createWritable({ keepExistingData: false });
    try {
      for (let off = 0; off < src.size; off += CHUNK) {
        const buf = await src.slice(off, Math.min(off + CHUNK, src.size)).arrayBuffer();
        await w.write(buf);
        onBytes(buf.byteLength);
      }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (e2) { /* ignore */ } throw e; }
    return dst;
  }

  async function sameBytes(aHandle, bHandle, onBytes = () => {}) {
    const a = await aHandle.getFile(), b = await bHandle.getFile();
    if (a.size !== b.size) return false;
    for (let off = 0; off < a.size; off += CHUNK) {
      const [x, y] = await Promise.all([a.slice(off, off + CHUNK).arrayBuffer(), b.slice(off, off + CHUNK).arrayBuffer()]);
      const xa = new Uint8Array(x), ya = new Uint8Array(y);
      if (xa.length !== ya.length) return false;
      for (let i = 0; i < xa.length; i++) if (xa[i] !== ya[i]) return false;
      onBytes(xa.length);
    }
    return true;
  }

  // Remember which file types this browser refuses to move, so we don't ask again for every file.
  const noMove = new Set();
  const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');

  /**
   * Transfer every file from folder `from` to a new folder `to`, renaming the track files.
   *  1. per file: move it if the browser allows; if the browser refuses (NotSupportedError), copy it instead
   *  2. verify: moved files by name + size, copied files byte for byte against the original
   *  3. only then delete the originals of copied files and the old folder
   * On any error before step 3: moved files are moved back, copies are deleted; the song is unchanged.
   */
  async function transferSongFolder(mtr, from, to, oldName, newName, log, progress) {
    if (await exists(mtr, to)) throw new CardError(`A folder called "${to}" already exists on the card.`);
    const oldDir = await mtr.getDirectoryHandle(from);
    const files = await inventory(oldDir);
    const tracks = files.filter((f) => M.TRACK_RE.test(f.name));
    if (tracks.length !== M.TRACKS) throw new CardError(`"${from}" has ${tracks.length} track files instead of ${M.TRACKS}. Rename stopped; run "Check card" first.`);

    const newDir = await mtr.getDirectoryHandle(to, { create: true });
    const moved = [], copied = [];
    const total = 2 * files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    const bump = (n, what) => { done += n; progress(done, total, what); };
    try {
      for (const f of files) {
        const target = M.renamedTrackFile(f.name, oldName, newName);
        let didMove = false;
        if (!noMove.has(extOf(f.name))) {
          try {
            await f.handle.move(newDir, target);
            didMove = true;
          } catch (err) {
            if (!err || err.name !== 'NotSupportedError') throw err;
            noMove.add(extOf(f.name));
            log(`browser refuses to move ${extOf(f.name) || 'extensionless'} files (${err.message}); copying those instead`);
          }
        }
        if (didMove) {
          moved.push({ handle: f.handle, from: f.name, to: target, size: f.size });
          bump(2 * f.size, `Moving ${target}`);
          log(`moved ${f.name} → ${to}/${target}`);
        } else {
          const dst = await copyFile(f.handle, newDir, target, (n) => bump(n, `Copying ${target}`));
          copied.push({ src: f, dst, to: target });
          log(`copied ${f.name} → ${to}/${target}`);
        }
      }
      // verify
      for (const c of copied) {
        if (!(await sameBytes(c.src.handle, c.dst, (n) => bump(n, `Checking ${c.to}`)))) throw new CardError(`Verification failed: the copy of ${c.src.name} differs from the original.`);
      }
      const after = await inventory(newDir);
      const want = new Map([...moved.map((m) => [m.to, m.size]), ...copied.map((c) => [c.to, c.src.size])]);
      if (after.length !== files.length || after.some((a) => want.get(a.name) !== a.size)) {
        throw new CardError('Verification failed: the new folder does not match the original.');
      }
      const left = (await listDir(oldDir)).map((x) => x.name).sort();
      const expectLeft = copied.map((c) => c.src.name).sort();
      if (left.join('\n') !== expectLeft.join('\n')) throw new CardError(`Unexpected files left in "${from}": ${left.join(', ')}`);
    } catch (err) {
      log(`error: ${err.message}. Undoing ${moved.length} move(s) and ${copied.length} copy(ies)…`);
      const problems = [];
      for (const m of moved.reverse()) {
        try { await m.handle.move(oldDir, m.from); } catch (e) { problems.push(`${to}/${m.to}`); }
      }
      for (const c of copied) { try { await newDir.removeEntry(c.to); } catch (e) { /* removed with the folder below */ } }
      if (!problems.length) { try { await mtr.removeEntry(to, { recursive: true }); } catch (e) { problems.push(`folder ${to}`); } }
      const extra = problems.length
        ? ` Could not undo: ${problems.join(', ')}. Your copy on the computer is the safe source.`
        : ' Everything was put back; the song is unchanged.';
      throw new CardError((err.message || String(err)) + extra);
    }
    // the new folder is complete and checked: remove the originals of copied files, then the old folder
    try {
      for (const c of copied) await oldDir.removeEntry(c.src.name);
      await mtr.removeEntry(from); // not recursive: fails if anything unexpected is left
      log(`removed old folder ${from}`);
    } catch (err) {
      throw new CardError(`"${to}" is complete and checked, but the old folder "${from}" could not be removed completely (${err.message}). Delete "${from}" on the computer; "${to}" is the good copy.`);
    }
  }

  /**
   * Rename a song the way the Model 12 does: folder + the 12 track files. Nothing inside the files changes.
   * Case-only changes (TV → tv) go through a temporary name, because the card ignores case.
   * If the song is the current song, tascam_m.sys gets the new name too.
   */
  async function renameSong(cardRoot, card, oldFolder, newName, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === oldFolder);
    if (!song) throw new CardError(`Song "${oldFolder}" not found.`);
    if (song.sys && song.sys.protected) throw new CardError(`"${oldFolder}" is protected. Click Unprotect first (or unprotect it on the Model 12).`);
    const v = M.validateSongName(newName, card.songs, oldFolder);
    if (!v.ok) throw new CardError(v.same ? 'The name is unchanged.' : v.errors.join(' '));

    const mtr = await cardRoot.getDirectoryHandle(M.MTR);
    if (v.caseOnly) {
      let tmp;
      do { tmp = 'tmmtmp_' + Math.random().toString(36).slice(2, 7); } while (await exists(mtr, tmp));
      log(`case-only change: going through temporary folder ${tmp}`);
      await transferSongFolder(mtr, oldFolder, tmp, oldFolder, newName, log, progress);
      try {
        await transferSongFolder(mtr, tmp, newName, newName, newName, log, progress);
      } catch (err) {
        // second step failed and was rolled back into tmp: put the song back under its old name
        log('second step failed; restoring the original name');
        await transferSongFolder(mtr, tmp, oldFolder, newName, oldFolder, log, progress);
        throw err;
      }
    } else {
      await transferSongFolder(mtr, oldFolder, newName, oldFolder, newName, log, progress);
    }

    if (card.info && card.info.currentSong === oldFolder && card.cardSys) {
      const fh = await cardRoot.getFileHandle('tascam_m.sys');
      const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
      await writeFile(fh, M.setCurrentSongName(buf, newName));
      log(`tascam_m.sys: current song is now "${newName}"`);
    }
    return { from: oldFolder, to: newName };
  }

  // ---------- copying tracks inside a song (e.g. 11/12 → 7/8) ----------

  // Channels as the Model 12's TRACK SWAP / CLEAR screens offer them: 1–12 single, plus 7/8, 9/10, 11/12
  const CHANNELS = M.CHANNELS;

  async function readAll(fileHandle) {
    return new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
  }

  const isReadOnly = (e) => !!e && (e.name === 'NoModificationAllowedError' || /read-?only/i.test(e.message || ''));

  const READ_ONLY_CARD = 'The card is read-only right now, so nothing was changed. Check that the lock switch on the side of the SD card is not on LOCK, and that your computer did not mount the card read-only (Linux does this after it finds a file-system error: "mount | grep MODEL12" then shows "ro"). A third cause: the MTR folder itself is marked read-only (often after copying a card from a computer); on Linux, "chmod -R u+w" on the card fixes that. Eject the card, fix the cause, put it back and open it again.';

  /** Can we write to the card at all? Creates and removes a tiny file in MTR. Throws a clear message if not. */
  async function probeWritable(cardRoot) {
    const name = 'tmmtmp_probe.bin';
    let dir;
    try {
      dir = await cardRoot.getDirectoryHandle(M.MTR);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      await dir.removeEntry(name);
    } catch (err) {
      if (dir) { try { await dir.removeEntry(name); } catch (e) { /* not there */ } }
      throw new CardError(`${READ_ONLY_CARD}\n\nThe browser said: ${err.name}: ${err.message || '(no reason given)'}`);
    }
  }

  /**
   * When a single file is marked read-only (the card itself is writable): write the new version as a new file
   * next to it, verify it, remove the original and give the new file the original name.
   * `writeTo(handle)` writes and verifies one file.
   */
  async function replaceReadOnly(dir, name, writeTo) {
    if (!dir) throw new CardError(`${name} is marked read-only and cannot be changed.`);
    const tmpName = `tmmtmp_new_${Date.now()}_${name}`;
    const tmp = await dir.getFileHandle(tmpName, { create: true });
    try { await writeTo(tmp); } catch (e) { try { await dir.removeEntry(tmpName); } catch (e2) { /* gone */ } throw e; }
    try { await dir.removeEntry(name); } catch (e) {
      try { await dir.removeEntry(tmpName); } catch (e2) { /* gone */ }
      throw new CardError(`${name} is marked read-only and the card refused to replace it (${e.message}). Nothing was changed.`);
    }
    try {
      await tmp.move(dir, name);
    } catch (e) {
      // browser can't rename (Brave): copy the verified temp file to a new file with the right name
      try {
        const nf = await dir.getFileHandle(name, { create: true });
        await rawWrite(nf, await readAll(tmp));
        if (!(await sameBytes(tmp, nf))) throw new CardError('verification failed');
      } catch (e2) {
        throw new CardError(`Replacing the read-only file ${name} failed halfway (${e2.message}). The new version is safe on the card as ${tmpName}; run "Check card".`);
      }
      await dir.removeEntry(tmpName);
    }
  }

  async function rawWrite(fileHandle, bytes, onBytes = () => {}) {
    const w = await fileHandle.createWritable({ keepExistingData: false });
    try {
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
        await w.write(part);
        onBytes(part.length);
      }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (e2) { /* ignore */ } throw e; }
  }

  /** Write bytes to a file (Chrome writes to a swap file and only replaces the original on close), then read back and compare. */
  async function writeVerified(fileHandle, bytes, onBytes = () => {}, dir = null) {
    try {
      await writeVerifiedOnce(fileHandle, bytes, onBytes);
    } catch (err) {
      if (!isReadOnly(err)) throw err;
      await replaceReadOnly(dir, fileHandle.name, (h) => writeVerifiedOnce(h, bytes, onBytes));
    }
  }
  async function writeVerifiedOnce(fileHandle, bytes, onBytes = () => {}) {
    const w = await fileHandle.createWritable({ keepExistingData: false });
    try {
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
        await w.write(part);
        onBytes(part.length);
      }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (e2) { /* ignore */ } throw e; }
    const back = await readAll(fileHandle);
    if (back.length !== bytes.length) throw new CardError(`Verification failed: ${fileHandle.name} has the wrong size after writing.`);
    for (let i = 0; i < back.length; i++) if (back[i] !== bytes[i]) throw new CardError(`Verification failed: ${fileHandle.name} differs after writing.`);
    onBytes(bytes.length);
  }

  function trackFileName(song, n) {
    const t = song.tracks[n - 1];
    if (!t) throw new CardError(`Track ${n} is missing in "${song.folder}".`);
    return t.entry.path.split('/').pop();
  }

  function songOk(song) {
    if (song.sys && song.sys.protected) throw new CardError(`"${song.folder}" is protected. Click Unprotect first (or unprotect it on the Model 12).`);
    if (song.warnings.length) throw new CardError(`"${song.folder}" has problems (${song.warnings.join('; ')}). Run "Check card" first.`);
  }

  /** Check a swap/copy request: same width, no overlap, song in good shape. Returns the track pairs. */
  function planCopy(song, srcId, dstId) {
    const src = CHANNELS.find((c) => c.id === srcId), dst = CHANNELS.find((c) => c.id === dstId);
    if (!src || !dst) throw new CardError('Unknown channel.');
    if (src === dst) throw new CardError('Pick two different channels.');
    if (src.tracks.length !== dst.tracks.length) throw new CardError(`${src.id} is ${src.tracks.length === 1 ? 'a single track' : 'a stereo pair'} and ${dst.id} is ${dst.tracks.length === 1 ? 'a single track' : 'a stereo pair'}. Pick two single tracks or two pairs.`);
    if (src.tracks.some((t) => dst.tracks.includes(t))) throw new CardError(`${src.id} and ${dst.id} share a track. Pick two separate channels.`);
    if (song.sys && song.sys.protected) throw new CardError(`"${song.folder}" is protected. Click Unprotect first (or unprotect it on the Model 12).`);
    if (song.warnings.length) throw new CardError(`"${song.folder}" has problems (${song.warnings.join('; ')}). Run "Check card" first.`);
    return src.tracks.map((from, i) => ({ from, to: dst.tracks[i] }));
  }

  /**
   * Replace track(s) `to` with a copy of track(s) `from` in one song. The old target audio is
   * returned as `backup` (kept in memory) so it can be put back with restoreTracks.
   */
  async function copyTracks(cardRoot, card, folder, srcId, dstId, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const pairs = planCopy(song, srcId, dstId);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const items = [];
    for (const p of pairs) {
      items.push({ ...p, src: await dir.getFileHandle(trackFileName(song, p.from)), dst: await dir.getFileHandle(trackFileName(song, p.to)) });
    }
    // keep the audio that is about to be replaced, for undo
    const backup = [];
    for (const it of items) backup.push({ track: it.to, bytes: await readAll(it.dst) });
    log(`kept ${backup.length} track(s) in memory for undo`);

    const total = 2 * (await Promise.all(items.map(async (it) => (await it.src.getFile()).size))).reduce((a, b) => a + b, 0) || 1;
    let done = 0;
    const written = [];
    try {
      for (const it of items) {
        const bytes = await readAll(it.src);
        await writeVerified(it.dst, bytes, (n) => { done += n; progress(done, total, `TR${String(it.from).padStart(2, '0')} → TR${String(it.to).padStart(2, '0')}`); }, dir);
        written.push(it);
        log(`TR${it.from} copied onto TR${it.to} and verified`);
      }
    } catch (err) {
      log(`error: ${err.message}. Restoring ${written.length} track(s)…`);
      const problems = [];
      for (const it of written) {
        try { await writeVerified(it.dst, backup.find((b) => b.track === it.to).bytes, undefined, dir); } catch (e) { problems.push(`TR${it.to}`); }
      }
      throw new CardError(`${err.message} ${problems.length ? `Could not restore ${problems.join(', ')}. Your copy on the computer is the safe source.` : 'The tracks were put back; the song is unchanged.'}`);
    }
    return { folder, srcId, dstId, backup };
  }

  /**
   * Empty the tracks of the given channels, the way the Model 12 stores an empty track
   * (the track's own header with zero audio). The old audio is returned as `backup` for undo.
   */
  async function clearTracks(cardRoot, card, folder, channelIds, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    if (song.sys && song.sys.protected) throw new CardError(`"${folder}" is protected. Click Unprotect first (or unprotect it on the Model 12).`);
    if (song.warnings.length) throw new CardError(`"${folder}" has problems (${song.warnings.join('; ')}). Run "Check card" first.`);
    const tracks = channelIds.flatMap((id) => {
      const c = CHANNELS.find((x) => x.id === id);
      if (!c) throw new CardError(`Unknown channel ${id}.`);
      return c.tracks;
    }).filter((n) => song.tracks[n - 1] && !song.tracks[n - 1].empty);
    if (!tracks.length) throw new CardError('Those channels are already empty.');
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);

    const items = [];
    for (const n of tracks) items.push({ n, fh: await dir.getFileHandle(trackFileName(song, n)) });
    const backup = [];
    for (const it of items) backup.push({ track: it.n, bytes: await readAll(it.fh) });
    log(`kept ${backup.length} track(s) in memory for undo`);

    const total = backup.reduce((a, b) => a + 2 * 5548, 0) || 1;
    let done = 0;
    const written = [];
    try {
      for (const it of items) {
        const old = backup.find((b) => b.track === it.n).bytes;
        await writeVerified(it.fh, M.emptyTrack(old.subarray(0, Math.min(old.length, 65536))), (k) => { done += k; progress(done, total, `Clearing TR${String(it.n).padStart(2, '0')}`); }, dir);
        written.push(it);
        log(`TR${it.n} cleared`);
      }
    } catch (err) {
      log(`error: ${err.message}. Restoring ${written.length} track(s)…`);
      const problems = [];
      for (const it of written) {
        try { await writeVerified(it.fh, backup.find((b) => b.track === it.n).bytes, undefined, dir); } catch (e) { problems.push(`TR${it.n}`); }
      }
      throw new CardError(`${err.message} ${problems.length ? `Could not restore ${problems.join(', ')}. Your copy on the computer is the safe source.` : 'The tracks were put back; the song is unchanged.'}`);
    }
    return { folder, ids: channelIds, backup };
  }

  /** Put backed-up track audio back (undo of copyTracks / clearTracks). */
  async function restoreTracks(cardRoot, card, folder, backup, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const total = 2 * backup.reduce((a, b) => a + b.bytes.length, 0) || 1;
    let done = 0;
    for (const b of backup) {
      const fh = await dir.getFileHandle(trackFileName(song, b.track));
      await writeVerified(fh, b.bytes, (n) => { done += n; progress(done, total, `Restoring TR${String(b.track).padStart(2, '0')}`); }, dir);
      log(`TR${b.track} restored`);
    }
  }


  // ---------- new song (only offered from Import) ----------

  /** Songs that can serve as a template for a new song at this sample rate. */
  const templatesFor = (card, sampleRate) => card.songs.filter((s) => s.songSys && s.sampleRate === sampleRate && !s.warnings.length && s.tracks.every(Boolean));

  /**
   * Create an empty song like the unit's: MTR/<name>/ with song.sys (cloned from a template song, see
   * Model12.newSongSys), 12 empty tracks built from the template's own track headers, and the empty
   * tempTr*.bin files. On any error everything created is removed again. Returns the file names created.
   */
  async function createSong(cardRoot, card, name, templateFolder, log = () => {}) {
    const v = M.validateSongName(name, card.songs, null);
    if (!v.ok) throw new CardError(v.errors.join(' '));
    if (card.songs.length >= 100) throw new CardError('The card already has 100 songs, the Model 12 maximum.');
    const tpl = card.songs.find((s) => s.folder === templateFolder);
    if (!tpl || !tpl.songSys) throw new CardError('No song to copy the settings from.');
    const mtr = await cardRoot.getDirectoryHandle(M.MTR);
    if (await exists(mtr, name)) throw new CardError(`A folder called "${name}" already exists in MTR.`);
    const tdir = await mtr.getDirectoryHandle(tpl.folder);
    const sys = M.newSongSys(await readAll(await tdir.getFileHandle('song.sys')), new Date());
    const temps = [];
    for await (const [n, h] of tdir.entries()) if (h.kind === 'file' && /^tempTr.*\.bin$/i.test(n)) temps.push(n);
    const dir = await mtr.getDirectoryHandle(name, { create: true });
    const made = [];
    try {
      // the unit's own track header (with bext, cue, LIST), preferably from an empty track of the template
      const heads = [];
      for (let n = 1; n <= M.TRACKS; n++) {
        const f = await (await tdir.getFileHandle(trackFileName(tpl, n))).getFile();
        heads.push({ n, empty: tpl.tracks[n - 1].empty, head: new Uint8Array(await f.slice(0, 65536).arrayBuffer()) });
      }
      const unitMade = heads.filter((h) => { try { return !!M.findChunk(h.head, 'bext'); } catch (e) { return false; } });
      if (!unitMade.length) throw new CardError(`"${tpl.folder}" has no track made by the Model 12 to copy the format from.`);
      const pick = (n) => unitMade.find((h) => h.n === n && h.empty) || unitMade.find((h) => h.empty) || unitMade.find((h) => h.n === n) || unitMade[0];
      for (let n = 1; n <= M.TRACKS; n++) {
        const head = pick(n).head;
        const fileName = `01_${name}_TR${String(n).padStart(2, '0')}.wav`;
        const bytes = M.setBextDateTime(M.emptyTrack(head.subarray(0, Math.min(head.length, 65536))), new Date());
        await writeVerified(await dir.getFileHandle(fileName, { create: true }), bytes, undefined, dir);
        made.push(fileName);
      }
      await writeVerified(await dir.getFileHandle('song.sys', { create: true }), sys, undefined, dir);
      made.push('song.sys');
      for (const t of temps) { await writeVerified(await dir.getFileHandle(t, { create: true }), new Uint8Array(0), undefined, dir); made.push(t); }
      log(`created MTR/${name} (${made.length} files, settings from "${tpl.folder}")`);
      return { files: made };
    } catch (err) {
      await removeSong(cardRoot, name, made.concat(['song.sys'])).catch(() => {});
      throw err;
    }
  }

  /**
   * Duplicate a song completely: every file of MTR/<from> copied into MTR/<to> (track files get the new name,
   * like a rename) and each copy read back and compared. On any error the copies are removed again.
   */
  async function duplicateSong(cardRoot, card, from, to, log = () => {}, progress = () => {}) {
    const v = M.validateSongName(to, card.songs, null);
    if (!v.ok) throw new CardError(v.errors.join(' '));
    if (card.songs.length >= 100) throw new CardError('The card already has 100 songs, the Model 12 maximum.');
    const mtr = await cardRoot.getDirectoryHandle(M.MTR);
    if (await exists(mtr, to)) throw new CardError(`A folder called "${to}" already exists in MTR.`);
    const src = await mtr.getDirectoryHandle(from);
    const files = [];
    for await (const [n, h] of src.entries()) if (h.kind === 'file') files.push({ name: n, handle: h, size: (await h.getFile()).size });
    const total = files.reduce((t, f) => t + f.size, 0);
    let done = 0;
    const dst = await mtr.getDirectoryHandle(to, { create: true });
    const made = [];
    try {
      for (const f of files) {
        const name = M.renamedTrackFile(f.name, from, to);
        const bytes = await readAll(f.handle);
        await writeVerified(await dst.getFileHandle(name, { create: true }), bytes, (k) => { done += k; progress(done, total, `Copying ${name}`); }, dst);
        made.push(name);
      }
      log(`duplicated MTR/${from} → MTR/${to} (${made.length} files, verified)`);
      return { files: made };
    } catch (err) {
      await removeSong(cardRoot, to, made).catch(() => {});
      throw err;
    }
  }

  /** Remove a song this app created: only the listed files, then the (then empty) folder. */
  async function removeSong(cardRoot, name, files, log = () => {}) {
    const mtr = await cardRoot.getDirectoryHandle(M.MTR);
    const dir = await mtr.getDirectoryHandle(name);
    for (const f of files) { try { await dir.removeEntry(f); } catch (e) { if (e.name !== 'NotFoundError') throw e; } }
    try { await mtr.removeEntry(name); } catch (e) {
      throw new CardError(`MTR/${name} still contains other files, so it was left on the card. (${e.message})`);
    }
    log(`removed MTR/${name}`);
  }

  /**
   * Delete a song from the card for good: every file in MTR/<name>/ (track files, song.sys, the unit's
   * temp files, hidden files a computer may have added), then the folder. Refused for protected songs
   * and for folders with subfolders (not something the Model 12 makes). If it was the current song,
   * tascam_m.sys points to `nextCurrent` afterwards (the same bytes the unit writes when loading a song).
   */
  async function deleteSong(cardRoot, card, name, nextCurrent = null, log = () => {}) {
    const song = card.songs.find((s) => s.folder === name);
    if (!song) throw new CardError(`There is no song "${name}" on the card.`);
    if (song.sys && song.sys.protected) throw new CardError(`"${name}" is protected. Unprotect it first.`);
    const mtr = await cardRoot.getDirectoryHandle(M.MTR);
    const dir = await mtr.getDirectoryHandle(name);
    const files = [];
    for await (const [n, h] of dir.entries()) {
      if (h.kind !== 'file') throw new CardError(`MTR/${name} contains a folder ("${n}"), which the Model 12 doesn't make. Nothing was deleted; check the card on your computer.`);
      files.push(n);
    }
    for (const n of files) await dir.removeEntry(n);
    log(`deleted ${files.length} files in MTR/${name}`);
    await mtr.removeEntry(name);
    log(`removed MTR/${name}`);
    if (card.info && card.info.currentSong === name && card.cardSys && nextCurrent) {
      const fh = await cardRoot.getFileHandle('tascam_m.sys');
      const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer());
      await writeFile(fh, M.setCurrentSongName(buf, nextCurrent));
      log(`tascam_m.sys: current song is now "${nextCurrent}"`);
    }
    return { files: files.length };
  }

  // ---------- song info and mixes: SETTINGS/<song>.json ----------

  const jsonBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
  const isEmpty = (sec) => !sec || !Object.keys(sec).some((k) => sec[k] != null && String(sec[k]).trim());

  /**
   * Store the songs whose section changed between `before` and `after` (the app's in-memory tables):
   * SETTINGS/<song>.json is written (verified) or, when a song has nothing left, removed.
   * Removals go first, so a rename that only changes upper/lower case works on the card's file system.
   */
  async function writeMetadata(cardRoot, after, before = {}) {
    const dir = await cardRoot.getDirectoryHandle(M.SETTINGS_DIR, { create: true });
    const folders = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => f !== '*');
    const same = (f) => JSON.stringify(after[f] || {}) === JSON.stringify(before[f] || {});
    for (const f of folders) {
      if (same(f) || !isEmpty(after[f])) continue;
      try { await dir.removeEntry(`${f}.json`); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
    }
    for (const f of folders) {
      if (same(f) || isEmpty(after[f])) continue;
      const fh = await dir.getFileHandle(`${f}.json`, { create: true });
      await writeVerified(fh, jsonBytes(M.metaToSettings(f, after[f])), undefined, dir);
    }
  }

  /** SETTINGS/_card_settings.json: things that belong to the card, not one song (artist and genre lists). */
  async function writeCardSettings(cardRoot, settings) {
    const dir = await cardRoot.getDirectoryHandle(M.SETTINGS_DIR, { create: true });
    const fh = await dir.getFileHandle(M.CARD_SETTINGS, { create: true });
    await writeVerified(fh, jsonBytes(Object.assign({ app: '12card', format: 1 }, settings)), undefined, dir);
  }

  /** Convert metadata.txt into SETTINGS/*.json (all songs, verified), then remove metadata.txt. */
  async function migrateMetadata(cardRoot, map, cardSettings) {
    await writeMetadata(cardRoot, map, {});
    await writeCardSettings(cardRoot, cardSettings);
    await cardRoot.removeEntry(M.META_FILE);
  }

  // ---------- protect (like SONG PROTECT on the unit) ----------

  /** Set or clear the protect flag (song.sys byte 0x20). Only that byte changes, as on the unit. */
  async function setProtected(cardRoot, card, folder, on, log = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const fh = await dir.getFileHandle('song.sys');
    const bytes = await readAll(fh);
    if (bytes.length !== M.MODEL.songSysSize || String.fromCharCode(...bytes.subarray(0, 5)) !== 'MODEL') throw new CardError(`song.sys of "${folder}" doesn't look like a Model 12 song file; not changed.`);
    if (bytes[M.SONG.PROTECT] === (on ? 1 : 0)) return { changed: false };
    bytes[M.SONG.PROTECT] = on ? 1 : 0;
    await writeVerified(fh, bytes, undefined, dir);
    log(`${folder}: protect ${on ? 'on' : 'off'}`);
    return { changed: true };
  }

  /** Set the click (metronome) tempo, song.sys byte 0x25C, as a whole number. Only that byte changes. */
  async function setClickTempo(cardRoot, card, folder, bpm, log = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    if (song.sys && song.sys.protected) throw new CardError(`"${folder}" is protected.`);
    const v = Math.round(bpm);
    const [lo, hi] = M.SONG.TEMPO_RANGE;
    if (!(v >= lo && v <= hi)) throw new CardError(`${bpm} BPM is outside what the click can be set to (${lo}–${hi}).`);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const fh = await dir.getFileHandle('song.sys');
    const bytes = await readAll(fh);
    if (bytes.length !== M.MODEL.songSysSize || String.fromCharCode(...bytes.subarray(0, 5)) !== 'MODEL') throw new CardError(`song.sys of "${folder}" doesn't look like a Model 12 song file; not changed.`);
    if (bytes[M.SONG.TEMPO] === v) return { changed: false };
    bytes[M.SONG.TEMPO] = v;
    await writeVerified(fh, bytes, undefined, dir);
    log(`${folder}: click tempo ${v} BPM`);
    return { changed: true };
  }

  // ---------- swap (like TRACK SWAP on the unit) ----------

  /**
   * Swap track(s) A and B. Tries file renames first (instant, no audio rewritten); if the browser refuses
   * to move files (Brave), swaps the file contents instead, verified. Undo = swap again.
   */
  async function swapTracks(cardRoot, card, folder, aId, bId, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    songOk(song);
    const pairs = planCopy(song, aId, bId);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    let done = 0;
    for (const p of pairs) {
      const nameA = trackFileName(song, p.from), nameB = trackFileName(song, p.to);
      const fa = await dir.getFileHandle(nameA), fb = await dir.getFileHandle(nameB);
      let renamed = false;
      if (!noMove.has('.wav')) {
        const tmp = `tmmtmp_swap_${p.from}_${Date.now()}.wav`;
        const steps = [];
        try {
          await fa.move(dir, tmp); steps.push(() => fa.move(dir, nameA));
          await fb.move(dir, nameA); steps.push(() => fb.move(dir, nameB));
          await fa.move(dir, nameB);
          renamed = true;
          log(`TR${p.from} ⇄ TR${p.to}: swapped by renaming`);
        } catch (err) {
          for (const undo of steps.reverse()) { try { await undo(); } catch (e) { throw new CardError(`Swap failed (${err.message}) and could not be undone: check TR${p.from}/TR${p.to} in "${folder}". Your copy on the computer is the safe source.`); } }
          if (steps.length !== 0) throw err;
          if (err && err.name === 'NotSupportedError') noMove.add('.wav');
          log(`renaming refused (${err.name}: ${err.message}); swapping contents instead`);
        }
      }
      if (!renamed) {
        const a = await readAll(fa), b = await readAll(fb);
        const total = 2 * (a.length + b.length) || 1;
        await writeVerified(fa, b, (n) => { done += n; progress(done, total, `TR${p.from} ⇄ TR${p.to}`); }, dir);
        try {
          await writeVerified(fb, a, (n) => { done += n; progress(done, total, `TR${p.from} ⇄ TR${p.to}`); }, dir);
        } catch (err) {
          try { await writeVerified(fa, a, undefined, dir); } catch (e) { throw new CardError(`Swap failed (${err.message}) and TR${p.from} could not be restored. Your copy on the computer is the safe source.`); }
          throw new CardError(`${err.message} TR${p.from} was put back; the song is unchanged.`);
        }
        log(`TR${p.from} ⇄ TR${p.to}: contents swapped and verified`);
      }
    }
    return { folder, aId, bId };
  }

  // ---------- streaming writes with a checksum (import, export) ----------

  /** Write a file from a series of byte chunks, then read it back and compare checksums. */
  async function writeStreamVerified(fileHandle, chunks, onBytes = () => {}, dir = null) {
    let w;
    try {
      w = await fileHandle.createWritable({ keepExistingData: false });
    } catch (err) {
      if (!isReadOnly(err)) throw err;
      return replaceReadOnly(dir, fileHandle.name, (h) => writeStreamVerified(h, chunks, onBytes));
    }
    let sum = 0x811c9dc5, len = 0;
    try {
      for await (const part of chunks) {
        await w.write(part);
        sum = M.fnv1a(part, sum); len += part.length;
        onBytes(part.length);
      }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (e2) { /* ignore */ } throw e; }
    const f = await fileHandle.getFile();
    if (f.size !== len) throw new CardError(`Verification failed: ${fileHandle.name} has the wrong size after writing.`);
    let back = 0x811c9dc5;
    for (let off = 0; off < f.size; off += CHUNK) {
      const part = new Uint8Array(await f.slice(off, off + CHUNK).arrayBuffer());
      back = M.fnv1a(part, back);
      onBytes(part.length);
    }
    if (back !== sum) throw new CardError(`Verification failed: ${fileHandle.name} differs after writing.`);
  }

  // ---------- import (like TRACK IMPORT on the unit) ----------

  /** Read a WAV file's format (for the import dialog). */
  async function inspectWav(file) {
    const head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    return M.parseAnyWav(head, file.size);
  }

  // decoded audio, kept while the import dialog is open (decoding a long file takes a moment)
  const decoded = new WeakMap();
  /** Decode any file the browser can read, at the given sample rate (the browser converts the rate). */
  async function decodeAt(file, rate) {
    let per = decoded.get(file);
    if (!per) decoded.set(file, (per = new Map()));
    if (per.has(rate)) return per.get(rate);
    const Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Ctx) throw new CardError('This browser cannot decode audio files.');
    let buf;
    try { buf = await new Ctx(1, 1, rate).decodeAudioData(await file.arrayBuffer()); }
    catch (e) { throw new CardError(`The browser can't read this file (${e.message || e.name}). Try WAV, FLAC, MP3, M4A/AAC, OGG or Opus.`); }
    per.clear(); per.set(rate, buf); // keep only the latest, to save memory
    return buf;
  }

  /**
   * What's in an audio file: WAV is read from its header; other formats (FLAC, MP3, M4A/AAC, OGG, Opus, AIFF)
   * are decoded by the browser. Returns { format, lossless, channels, sampleRate (null if unknown),
   * bitsPerSample (null for lossy), duration, ... }.
   */
  async function inspectAudio(file) {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const format = M.sniffAudio(head);
    if (format === 'wav') return Object.assign({ format, lossless: true }, await inspectWav(file));
    let rate = null, bits = null;
    if (format === 'flac') { const f = M.parseFlacInfo(head); rate = f.sampleRate; bits = f.bitsPerSample; }
    const buf = await decodeAt(file, rate || 48000);
    return {
      format, lossless: M.LOSSLESS.has(format), channels: buf.numberOfChannels,
      sampleRate: rate, bitsPerSample: bits, duration: buf.duration, float: false,
    };
  }

  /** Check an import: same sample rate as the song, mono → single empty track, stereo → empty pair. */
  function planImport(song, info, dstId) {
    songOk(song);
    const dst = CHANNELS.find((c) => c.id === dstId);
    if (!dst) throw new CardError('Pick a target track.');
    if (!song.sampleRate) throw new CardError('The song format is unknown.');
    if (info.channels > 2) throw new CardError(`This file has ${info.channels} channels; only mono and stereo files can be imported.`);
    if (info.channels !== dst.tracks.length) throw new CardError(info.channels === 1 ? 'This is a mono file: pick a single track.' : 'This is a stereo file: pick a pair (7/8, 9/10 or 11/12).');
    const busy = dst.tracks.filter((n) => !song.tracks[n - 1] || !song.tracks[n - 1].empty);
    if (busy.length) throw new CardError(`Track ${busy.join(' and ')} ${busy.length > 1 ? 'are' : 'is'} not empty. Like on the unit, import only goes to empty tracks; clear ${dst.id} first.`);
    return dst.tracks;
  }

  /**
   * Import a WAV file onto empty track(s). The new file is the empty track's own header (as the unit made it)
   * with the audio added, converted to the song's bit depth. Undo puts the empty tracks back.
   */
  /** Loudness (LUFS) and sample peak (dBFS) of an audio file, decoded at `rate`. */
  async function measureLoudness(file, rate) {
    const buf = await decodeAt(file, rate);
    const chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    return root.Loudness.measure(chs, rate);
  }

  /**
   * Put an audio file on empty track(s). opts.gainDb: change the level first (normalise); the audio is
   * then decoded and dithered instead of copied exactly.
   */
  async function importTrack(cardRoot, card, folder, file, dstId, log = () => {}, progress = () => {}, opts = {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const info = await inspectAudio(file);
    const targets = planImport(song, info, dstId);
    const outBits = song.bitsPerSample;
    const resample = info.sampleRate !== song.sampleRate;
    // WAV at the song's rate streams straight from the file; everything else is decoded at the song's rate
    const gainDb = opts.gainDb || 0, gain = Math.pow(10, gainDb / 20);
    const pcm = info.format === 'wav' && !resample && !gainDb ? null : await decodeAt(file, song.sampleRate);
    const exact = !!pcm && !gainDb && !resample && info.lossless && info.bitsPerSample >= 8 && info.bitsPerSample <= outBits;
    const frames = pcm ? pcm.length : info.frames;
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const items = [];
    for (const n of targets) items.push({ n, fh: await dir.getFileHandle(trackFileName(song, n)) });
    const backup = [];
    for (const it of items) backup.push({ track: it.n, bytes: await readAll(it.fh) });

    const outBytes = frames * outBits / 8;
    const total = items.length * 2 * outBytes || 1;
    let done = 0;
    const framesPerChunk = pcm ? 0 : Math.max(1, Math.floor(CHUNK / info.bytesPerFrame));
    const written = [];
    try {
      for (const [ci, it] of items.entries()) {
        const empty = backup[ci].bytes;
        const header = M.setBextDateTime(M.headerFromTemplate(M.emptyTrack(empty.subarray(0, Math.min(empty.length, 65536))), { channels: 1, bitsPerSample: outBits, dataBytes: outBytes }), new Date());
        async function* chunks() {
          yield header;
          if (pcm) {
            const ch = pcm.getChannelData(ci), step = Math.floor(CHUNK / (outBits / 8));
            for (let f = 0; f < frames; f += step) {
              let part = ch.subarray(f, Math.min(frames, f + step));
              if (gainDb) part = part.map((v) => v * gain); // a copy: the decoded file stays as it was (for redo)
              yield M.floatToPcm(part, outBits, exact);
            }
            return;
          }
          for (let f = 0; f < info.frames; f += framesPerChunk) {
            const n = Math.min(framesPerChunk, info.frames - f);
            const a = info.dataOffset + f * info.bytesPerFrame;
            const src = new Uint8Array(await file.slice(a, a + n * info.bytesPerFrame).arrayBuffer());
            yield M.convertChannel(src, info, ci, outBits);
          }
        }
        await writeStreamVerified(it.fh, chunks(), (k) => { done += k; progress(done, total, `Importing into TR${String(it.n).padStart(2, '0')}`); }, dir);
        written.push(it);
        log(`TR${it.n}: imported ${frames} frames from ${info.format}${gainDb ? `, level ${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB` : ''}${resample ? `, ${info.sampleRate ? info.sampleRate / 1000 + ' kHz' : 'rate'} → ${song.sampleRate / 1000} kHz` : ''}${exact ? ' (exact)' : ''}`);
      }
    } catch (err) {
      const problems = [];
      for (const it of written) {
        try { await writeVerified(it.fh, backup.find((b) => b.track === it.n).bytes, undefined, dir); } catch (e) { problems.push(`TR${it.n}`); }
      }
      // a failed write leaves the original in place (the browser only replaces it on close)
      throw new CardError(`${err.message} ${problems.length ? `Could not restore ${problems.join(', ')}.` : 'The tracks were put back; the song is unchanged.'}`);
    }
    return { folder, dstId, backup, converted: info.bitsPerSample !== outBits || info.float, resampled: resample, fromRate: info.sampleRate, format: info.format, gainDb };
  }

  // ---------- stereo mix export (like STEREO MIX EXPORT on the unit) ----------

  const MAX_FILE = 2 ** 31 - 1; // the unit splits exports at 2 GB

  /**
   * File names the unit would use: <song>_2-MIX_01.wav, and _02, _03 … above 2 GB.
   * Without `totalFrames` the length is estimated from the file sizes (good enough for showing the names);
   * the export itself uses exportPlanExact, which reads the real track headers.
   */
  function exportPlan(song, totalFrames) {
    songHasMix(song);
    const l = song.tracks[10], r = song.tracks[11];
    const bytesPerSample = song.bitsPerSample / 8;
    const header = 5548; // the unit's track/export header size
    if (totalFrames == null) totalFrames = Math.ceil((Math.max(l.size, r.size) - header) / bytesPerSample);
    const perFile = Math.floor((MAX_FILE - header) / (2 * bytesPerSample));
    const files = [];
    for (let i = 0, f = 0; f < totalFrames; i++, f += perFile) {
      files.push({ name: `${song.folder}_2-MIX_${String(i + 1).padStart(2, '0')}.wav`, from: f, frames: Math.min(perFile, totalFrames - f) });
    }
    return files;
  }
  async function exportPlanExact(song) {
    songHasMix(song);
    const frames = [];
    for (const t of [song.tracks[10], song.tracks[11]]) {
      const f = await t.entry.getFile();
      frames.push(M.parseWavHeader(new Uint8Array(await f.slice(0, 65536).arrayBuffer()), f.size).frames);
    }
    return exportPlan(song, Math.max(...frames));
  }
  function songHasMix(song) {
    const l = song.tracks[10], r = song.tracks[11];
    if (!l || !r || l.empty || r.empty) throw new CardError('There is no main mix on tracks 11/12 to export (on the unit: "MAIN file error"). Record a mixdown on the Model 12 first.');
  }

  /** Produce the export as byte chunks per output file. */
  async function* exportChunks(song, part) {
    const lh = await song.tracks[10].entry.getFile(), rh = await song.tracks[11].entry.getFile();
    const head = new Uint8Array(await lh.slice(0, 65536).arrayBuffer());
    const li = M.parseWavHeader(head, lh.size);
    const ri = M.parseWavHeader(new Uint8Array(await rh.slice(0, 65536).arrayBuffer()), rh.size);
    const bps = li.bitsPerSample / 8;
    if (ri.bitsPerSample !== li.bitsPerSample || ri.sampleRate !== li.sampleRate) throw new CardError('Tracks 11 and 12 have different formats.');
    yield M.setBextDateTime(M.headerFromTemplate(head, { channels: 2, bitsPerSample: li.bitsPerSample, dataBytes: part.frames * 2 * bps }), new Date());
    const step = Math.floor(CHUNK / bps);
    for (let f = part.from; f < part.from + part.frames; f += step) {
      const n = Math.min(step, part.from + part.frames - f);
      const read = async (file, info) => {
        const a = info.dataOffset + f * bps;
        const end = Math.min(info.dataOffset + info.dataSize, a + n * bps);
        const got = a < end ? new Uint8Array(await file.slice(a, end).arrayBuffer()) : new Uint8Array(0);
        if (got.length === n * bps) return got;
        const padded = new Uint8Array(n * bps); padded.set(got); return padded; // shorter track: silence
      };
      const [L, R] = await Promise.all([read(lh, li), read(rh, ri)]);
      const out = new Uint8Array(n * 2 * bps);
      for (let i = 0, o = 0, s = 0; i < n; i++, s += bps) {
        for (let k = 0; k < bps; k++) out[o++] = L[s + k];
        for (let k = 0; k < bps; k++) out[o++] = R[s + k];
      }
      yield out;
    }
  }

  /** Export to the card's MUSIC folder (overwriting like the unit does; the old file is kept in memory for undo). */
  async function exportMixToCard(cardRoot, card, folder, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const parts = await exportPlanExact(song);
    const music = await cardRoot.getDirectoryHandle(M.MUSIC, { create: true });
    const total = parts.reduce((a, p) => a + 2 * (5548 + p.frames * 2 * song.bitsPerSample / 8), 0) || 1;
    let done = 0;
    const results = [];
    try {
      for (const part of parts) {
        let old = null;
        try { old = await readAll(await music.getFileHandle(part.name)); } catch (e) { /* new file */ }
        const fh = await music.getFileHandle(part.name, { create: true });
        results.push({ name: part.name, old });
        await writeStreamVerified(fh, exportChunks(song, part), (k) => { done += k; progress(done, total, `Writing MUSIC/${part.name}`); }, music);
        log(`MUSIC/${part.name} written and verified${old ? ' (replaced the old file)' : ''}`);
      }
    } catch (err) {
      await restoreExport(cardRoot, results).catch(() => {});
      throw new CardError(`${err.message} The MUSIC folder was put back as it was.`);
    }
    return { folder, files: results };
  }

  /** Undo an export: put replaced files back, remove new ones. */
  async function restoreExport(cardRoot, files) {
    const music = await cardRoot.getDirectoryHandle(M.MUSIC);
    for (const f of files) {
      if (f.old) await writeVerified(await music.getFileHandle(f.name, { create: true }), f.old, undefined, music);
      else { try { await music.removeEntry(f.name); } catch (e) { /* already gone */ } }
    }
  }

  /** Export as downloads (no card writes needed). Returns [{ name, blob }]. */
  async function exportMixBlobs(card, folder, progress = () => {}, tags = null) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const parts = await exportPlanExact(song);
    const total = parts.reduce((a, p) => a + 5548 + p.frames * 2 * song.bitsPerSample / 8, 0) || 1;
    let done = 0;
    const out = [];
    for (const part of parts) {
      const chunks = [];
      for await (const c of exportChunks(song, part)) { chunks.push(c); done += c.length; progress(done, total, part.name); }
      const extra = tags ? M.wavTagChunks(tags, undefined, tags.cover || null) : new Uint8Array(0);
      if (extra.length) {
        // tags go after the audio; only the RIFF size in the header changes
        const head = chunks[0].slice();
        const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        dv.setUint32(4, dv.getUint32(4, true) + extra.length, true);
        chunks[0] = head;
        chunks.push(extra);
      }
      out.push({ name: part.name, blob: new Blob(chunks, { type: 'audio/wav' }) });
    }
    return out;
  }

  async function writeFile(fileHandle, bytes) {
    const w = await fileHandle.createWritable({ keepExistingData: false });
    await w.write(bytes);
    await w.close();
    // read back
    const back = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
    if (back.length !== bytes.length || back.some((x, i) => x !== bytes[i])) throw new CardError('Verification failed after writing ' + fileHandle.name);
  }

  /**
   * Read every byte of every file, to find files the card can't read.
   * entries: card entries ({ path, size, getFile }). onProgress(doneBytes, totalBytes, path).
   */
  async function checkAllFiles(entries, onProgress, signal) {
    const CHUNK = 8 * 1024 * 1024;
    const total = entries.reduce((a, e) => a + e.size, 0);
    let done = 0;
    const bad = [];
    for (const e of entries) {
      if (signal && signal.aborted) break;
      try {
        const f = await e.getFile();
        if (f.size !== e.size) throw new Error(`size changed (${e.size} → ${f.size})`);
        for (let off = 0; off < f.size; off += CHUNK) {
          if (signal && signal.aborted) break;
          const n = (await f.slice(off, Math.min(off + CHUNK, f.size)).arrayBuffer()).byteLength;
          if (n !== Math.min(CHUNK, f.size - off)) throw new Error(`short read at ${off}`);
          done += n;
          onProgress(done, total, e.path);
        }
      } catch (err) {
        bad.push({ path: e.path, error: err.message || String(err) });
        done += e.size; // count it so the progress bar keeps moving
        onProgress(done, total, e.path);
      }
    }
    return { total, done, bad, aborted: !!(signal && signal.aborted), files: entries.length };
  }

  /**
   * Which files refuse to be written? Opens each file for writing and cancels straight away
   * (Chrome writes to a separate swap file, so the original is never touched).
   * Returns { cardReadOnly } or { readOnly: [{path, song}], other: [{path, error}] }.
   */
  async function checkWritable(entries, cardRoot, onProgress = () => {}) {
    try { await probeWritable(cardRoot); } catch (e) { return { cardReadOnly: true, reason: e.message, readOnly: [], other: [] }; }
    const readOnly = [], other = [];
    const list = entries.filter((e) => e.handle && /(^|\/)(MTR|MUSIC)\/|(^|\/)tascam_m\.sys$/i.test(e.path) && !/(^|\/)(~tmm|tmmtmp_)/i.test(e.path));
    let i = 0;
    for (const e of list) {
      onProgress(++i, list.length, e.path);
      try {
        const w = await e.handle.createWritable({ keepExistingData: false });
        await w.abort();
      } catch (err) {
        const m = /(?:^|\/)MTR\/([^/]+)\//.exec(e.path);
        if (isReadOnly(err)) readOnly.push({ path: e.path, song: m ? m[1] : null });
        else other.push({ path: e.path, error: `${err.name}: ${err.message}` });
      }
    }
    return { cardReadOnly: false, readOnly, other, files: list.length };
  }

  // ---------- trim song: cut the same stretch off the start and end of every track ----------
  //
  // Each track with audio is written again as a new file next to it (tmmtmp_trim_…): its own header with only
  // the sizes (and moved marks) changed, then the kept part of its audio, copied sample for sample. Only when
  // every new file is written and read back correctly are they swapped in. The swap moves the originals to
  // SETTINGS/trim-undo/<stamp>/ (a move changes the directory entry only), so ↶ can put them back, and nothing
  // big is ever rewritten in place. Empty tracks are not touched; song.sys only when it has marks.

  const TRIM_DIR = 'trim-undo';
  const SOUND_DB = -60;            // "sound" for Find silence: louder than −60 dBFS
  const PAD_BEFORE = 0.25, PAD_AFTER = 1; // seconds kept before the first and after the last sound

  async function trimRoot(cardRoot, create) {
    const s = await cardRoot.getDirectoryHandle(M.SETTINGS_DIR, { create });
    return s.getDirectoryHandle(TRIM_DIR, { create });
  }

  /** The tracks of a song that hold audio, with their headers. */
  async function audioTracks(song) {
    const out = [];
    for (const t of song.tracks) {
      if (!t || t.empty) continue;
      const file = await t.entry.getFile();
      const head = new Uint8Array(await file.slice(0, M.HEADER_READ_BYTES).arrayBuffer());
      const h = M.parseWavHeader(head, file.size);
      if (h.channels !== 1) throw new CardError(`TR${String(t.n).padStart(2, '0')} is not a mono track (${h.channels} channels). Run "Check card" first.`);
      out.push({ n: t.n, name: t.entry.path.split('/').pop(), file, head, h });
    }
    return out;
  }

  /**
   * Where the sound starts and ends across all tracks, in frames: the first and last sample louder than −60 dBFS
   * on any track, with 0.25 s kept before and 1 s after. Reads from both ends of each track until it hears
   * something, so it is quick unless a track is silent all the way through.
   */
  async function findSound(song, progress = () => {}) {
    const tracks = await audioTracks(song);
    if (!tracks.length) throw new CardError('This song has no recorded tracks.');
    const rate = tracks[0].h.sampleRate;
    const total = Math.max(...tracks.map((t) => t.h.frames));
    let first = Infinity, last = -1;
    const thr = Math.pow(10, SOUND_DB / 20);
    const loud = (bytes, B, fromEnd) => {
      const n = Math.floor(bytes.length / B), full = B === 2 ? 32768 : 8388608, lim = thr * full;
      for (let k = 0; k < n; k++) {
        const i = fromEnd ? n - 1 - k : k, o = i * B;
        const v = B === 2 ? ((bytes[o] | (bytes[o + 1] << 8)) << 16 >> 16) : ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8);
        if (Math.abs(v) > lim) return i;
      }
      return -1;
    };
    for (const [ti, t] of tracks.entries()) {
      const B = t.h.bitsPerSample / 8, step = rate; // one second at a time
      progress(ti, tracks.length, `TR${String(t.n).padStart(2, '0')}`);
      let a = -1;
      for (let f = 0; f < t.h.frames && f < first; f += step) {
        const n = Math.min(step, t.h.frames - f);
        const i = loud(new Uint8Array(await t.file.slice(t.h.dataOffset + f * B, t.h.dataOffset + (f + n) * B).arrayBuffer()), B, false);
        if (i >= 0) { a = f + i; break; }
      }
      if (a < 0 && first === Infinity) continue; // silent until the earliest sound found so far (or all the way): nothing here
      if (a >= 0) first = Math.min(first, a);
      for (let f = t.h.frames; f > 0 && f > last; f -= step) {
        const s0 = Math.max(0, f - step);
        const i = loud(new Uint8Array(await t.file.slice(t.h.dataOffset + s0 * B, t.h.dataOffset + f * B).arrayBuffer()), B, true);
        if (i >= 0) { last = Math.max(last, s0 + i); break; }
      }
    }
    if (first === Infinity || last < 0) return { start: 0, end: total, frames: total, rate, silent: true };
    return { start: Math.max(0, first - Math.round(PAD_BEFORE * rate)), end: Math.min(total, last + 1 + Math.round(PAD_AFTER * rate)), frames: total, rate };
  }

  /** What a trim of [start, end) frames would do (for the dialog), without changing anything. */
  async function planTrim(song, start, end) {
    songOk(song);
    const tracks = await audioTracks(song);
    if (!tracks.length) throw new CardError('This song has no recorded tracks.');
    const total = Math.max(...tracks.map((t) => t.h.frames));
    start = Math.max(0, Math.round(start)); end = Math.min(total, Math.round(end));
    if (end - start < tracks[0].h.sampleRate * 0.1) throw new CardError('Keep at least a tenth of a second.');
    if (start === 0 && end >= total) throw new CardError('Move the start or the end: nothing would be cut.');
    const items = tracks.map((t) => {
      const s = Math.min(start, t.h.frames), e = Math.min(end, t.h.frames);
      let frames = Math.max(0, e - s);
      if (t.h.bytesPerFrame & 1) frames -= frames & 1; // keep the audio an even number of bytes (no pad byte), as the unit does
      const extra = t.file.size - (t.h.dataOffset + t.h.dataSize);
      return { ...t, start: s, frames, extra };
    });
    const keptFrames = end - start;
    let marks = null;
    if (song.sys && song.sys.marks && song.sys.marks.length) {
      const after = M.shiftMarks(song.sys.marks, start, keptFrames).length;
      marks = { before: song.sys.marks.length, after };
    }
    const newBytes = items.reduce((a, it) => a + it.h.dataOffset + it.frames * it.h.bytesPerFrame, 0);
    const oldBytes = items.reduce((a, it) => a + it.file.size, 0);
    return { start, end, total, rate: tracks[0].h.sampleRate, items, marks, newBytes, oldBytes };
  }

  const stampNow = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  const toB64 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };

  async function trimSong(cardRoot, card, folder, start, end, log = () => {}, progress = () => {}) {
    const song = card.songs.find((s) => s.folder === folder);
    if (!song) throw new CardError(`Song "${folder}" not found.`);
    const plan = await planTrim(song, start, end);
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(folder);
    const total = plan.items.reduce((a, it) => a + 2 * (it.h.dataOffset + it.frames * it.h.bytesPerFrame), 0) || 1;
    let done = 0;
    const temps = [];
    const cleanTemps = async () => { for (const t of temps) { try { await dir.removeEntry(t.tmpName); } catch (e) { /* gone */ } } };

    // 1. the new tracks, next to the old ones
    try {
      for (const it of plan.items) {
        const label = `TR${String(it.n).padStart(2, '0')}`;
        const tmpName = `tmmtmp_trim_${String(it.n).padStart(2, '0')}.wav`;
        const fh = await dir.getFileHandle(tmpName, { create: true });
        temps.push({ it, tmpName, fh });
        const B = it.h.bytesPerFrame;
        const { header, marksBefore, marksAfter } = it.frames ? M.trimmedHeader(it.head, { start: it.start, frames: it.frames, bytesPerFrame: B }) : { header: M.emptyTrack(it.head), marksBefore: 0, marksAfter: 0 };
        async function* chunks() {
          yield header;
          const a = it.h.dataOffset + it.start * B, z = a + it.frames * B;
          for (let off = a; off < z; off += CHUNK) yield new Uint8Array(await it.file.slice(off, Math.min(z, off + CHUNK)).arrayBuffer());
        }
        await writeStreamVerified(fh, chunks(), (k) => { done += k; progress(done, total, `Writing ${label}`); });
        log(`${label}: ${it.frames} frames kept from frame ${it.start}${marksBefore ? `, marks ${marksBefore} → ${marksAfter}` : ''}${it.extra > 0 ? `, ${it.extra} extra bytes after the audio left out` : ''}`);
      }
    } catch (err) {
      await cleanTemps();
      throw new CardError(`${err.message} Nothing was changed: the song is as it was.`);
    }

    // 2. song.sys with the marks moved (small: written in place, the old bytes are kept for undo)
    const sysHandle = song.songSys ? await dir.getFileHandle(song.songSys.path.split('/').pop()) : null;
    const sysOld = sysHandle ? await readAll(sysHandle) : null;
    const sysNew = sysOld ? M.trimmedSongSys(sysOld, plan.start, plan.end - plan.start) : null;

    // 3. swap: originals to SETTINGS/trim-undo/<stamp>/, new files under the original names
    const stamp = `${stampNow()}_${folder}`;
    let undo;
    try { undo = await (await trimRoot(cardRoot, true)).getDirectoryHandle(stamp, { create: true }); }
    catch (err) { await cleanTemps(); throw new CardError(`Could not make the undo folder (${err.message}). Nothing was changed.`); }
    const steps = [];
    try {
      for (const t of temps) {
        const orig = await dir.getFileHandle(t.it.name);
        await orig.move(undo, t.it.name); steps.push(() => orig.move(dir, t.it.name));
        await t.fh.move(dir, t.it.name); steps.push(() => t.fh.move(dir, t.tmpName));
        progress(total, total, `Swapping TR${String(t.it.n).padStart(2, '0')}`);
      }
      if (sysNew) { await writeVerified(sysHandle, sysNew.bytes, undefined, dir); steps.push(() => writeVerified(sysHandle, sysOld, undefined, dir)); log(`song.sys: marks ${sysNew.before} → ${sysNew.after}`); }
      const manifest = { folder, date: new Date().toISOString(), start: plan.start, end: plan.end, sampleRate: plan.rate, files: temps.map((t) => t.it.name), songSys: sysNew ? toB64(sysOld) : null };
      await writeVerified(await undo.getFileHandle('trim.json', { create: true }), new TextEncoder().encode(JSON.stringify(manifest, null, 1)));
    } catch (err) {
      const problems = [];
      for (const s of steps.reverse()) { try { await s(); } catch (e) { problems.push(e.message); } }
      if (!problems.length) {
        await cleanTemps();
        try { await (await trimRoot(cardRoot, false)).removeEntry(stamp, { recursive: true }); } catch (e) { /* leave it */ }
        if (err && err.name === 'NotSupportedError') throw new CardError('This browser cannot move files on the card, which trimming needs. Nothing was changed.');
        throw new CardError(`${err.message} Everything was put back; the song is unchanged.`);
      }
      throw new CardError(`${err.message} Putting things back also failed (${problems.join('; ')}). The original tracks are in SETTINGS/${TRIM_DIR}/${stamp} on the card; run "Check card" and don't record on this song until it is sorted.`);
    }
    log(`originals kept in SETTINGS/${TRIM_DIR}/${stamp}`);
    return { folder, stamp, files: temps.map((t) => t.it.name), sysOld: sysNew ? sysOld : null, sysNew: sysNew ? sysNew.bytes : null, tracks: temps.length, marks: sysNew ? { before: sysNew.before, after: sysNew.after } : null, oldBytes: plan.oldBytes };
  }

  /** Undo or redo a trim: exchange the song's tracks with the ones kept in SETTINGS/trim-undo/<stamp>/. */
  async function swapTrim(cardRoot, entry, direction, log = () => {}) {
    const dir = await (await cardRoot.getDirectoryHandle(M.MTR)).getDirectoryHandle(entry.folder);
    const undo = await (await trimRoot(cardRoot, false)).getDirectoryHandle(entry.stamp);
    const steps = [];
    try {
      for (const name of entry.files) {
        const a = await dir.getFileHandle(name), b = await undo.getFileHandle(name);
        const tmp = `tmmtmp_x_${name}`;
        await a.move(undo, tmp); steps.push(() => a.move(dir, name));
        await b.move(dir, name); steps.push(() => b.move(undo, name));
        await a.move(undo, name); steps.push(() => a.move(undo, tmp));
        log(`${name} exchanged`);
      }
      if (entry.sysOld) {
        const sh = await dir.getFileHandle('song.sys');
        const [to, back] = direction === 'undo' ? [entry.sysOld, entry.sysNew] : [entry.sysNew, entry.sysOld];
        await writeVerified(sh, to, undefined, dir); steps.push(() => writeVerified(sh, back, undefined, dir));
        log('song.sys marks put ' + (direction === 'undo' ? 'back' : 'forward'));
      }
    } catch (err) {
      const problems = [];
      for (const s of steps.reverse()) { try { await s(); } catch (e) { problems.push(e.message); } }
      throw new CardError(`${err.message} ${problems.length ? `Putting things back also failed; the other version of the tracks is in SETTINGS/${TRIM_DIR}/${entry.stamp}. Run "Check card".` : 'Nothing was changed.'}`);
    }
  }

  /** Remove the originals kept from trims (all of SETTINGS/trim-undo). */
  async function deleteTrimBackups(cardRoot) {
    const s = await cardRoot.getDirectoryHandle(M.SETTINGS_DIR);
    try { await s.removeEntry(TRIM_DIR, { recursive: true }); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }

  root.CardIO = { findSound, planTrim, trimSong, swapTrim, deleteTrimBackups, TRIM_DIR, measureLoudness, deleteSong, duplicateSong, setClickTempo, templatesFor, createSong, removeSong, writeMetadata, writeCardSettings, migrateMetadata, setProtected, checkWritable, probeWritable, isReadOnly, READ_ONLY_CARD, renameSong, checkAllFiles, CardError, listDir, noMove, CHANNELS, planCopy, copyTracks, clearTracks, restoreTracks, swapTracks, inspectWav, inspectAudio, planImport, importTrack, exportPlan, exportMixToCard, exportMixBlobs, restoreExport };
})(self);
