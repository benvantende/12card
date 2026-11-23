/*
 * model12.js — reads the TASCAM Model 12 SD card format.
 *
 * No browser APIs here, so it can also be tested with Node.
 * Format notes: see claude/model12-sd-card-format.md in the project.
 *
 * A "card" is built from a flat list of entries:
 *   { path: 'MTR/TV/01_TV_TR01.wav', size: 17946796, getFile: async () => File|Blob }
 * Paths are relative to the card root (the folder that holds tascam_m.sys).
 */
(function (root) {
  'use strict';

  // The card format comes from config/card-model12.js (plain JSON); in Node the file is loaded here.
  const g = typeof globalThis !== 'undefined' ? globalThis : root;
  if (!(g.CFG12 && g.CFG12.model) && typeof require === 'function') require('./config/card-model12.js');
  const MODEL = g.CFG12 && g.CFG12.model;
  if (!MODEL) throw new Error('config/card-model12.js is missing or not valid JSON, so 12card cannot read the card.');
  const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : v);

  const TRACKS = MODEL.tracks;
  const EMPTY_TRACK_MAX_BYTES = MODEL.emptyTrackMaxBytes; // an empty track is a 5,548-byte header-only file
  const HEADER_READ_BYTES = MODEL.headerReadBytes;        // enough to cover bext + cue + LIST + fmt chunks
  const MTR = MODEL.folders.songs, MUSIC = MODEL.folders.mixdowns;

  // song.sys offsets (little-endian)
  const S = MODEL.songSys;
  const SONG = {
    MAGIC: hex(S.magic),             // "MODEL   "
    PROTECT: hex(S.protect),         // 0 = off, 1 = protected (tested on the unit)
    BYTES_PER_SAMPLE: hex(S.bytesPerSample),
    FAT_DATE: hex(S.fatDate),
    FAT_TIME: hex(S.fatTime),
    MARKS: hex(S.marks),             // uint32 sample positions, 0xFFFFFFFF = empty
    MARK_SLOTS: S.markSlots,
    TEMPO: hex(S.clickTempo),        // metronome (click) tempo
    TEMPO_RANGE: S.clickTempoRange,
    FLAG_262: hex(S.flag262),
  };

  // tascam_m.sys offsets
  const CARD = {
    MAGIC: hex(MODEL.cardSys.magic),               // "TASCAM_M"
    LAST_POS: hex(MODEL.cardSys.lastPos),          // uint32, unknown meaning
    CURRENT_SONG: hex(MODEL.cardSys.currentSong),  // null-terminated song name
  };

  // ---------- small helpers ----------

  function ascii(bytes, start, len) {
    let s = '';
    for (let i = start; i < start + len && i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s;
  }

  function asBytes(buf) {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  function fatDateTime(dateWord, timeWord) {
    if (!dateWord) return null;
    const year = (dateWord >> 9) + 1980;
    const month = (dateWord >> 5) & 0x0f;
    const day = dateWord & 0x1f;
    const hour = timeWord >> 11;
    const min = (timeWord >> 5) & 0x3f;
    const sec = (timeWord & 0x1f) * 2;
    if (month < 1 || month > 12 || day < 1) return null;
    // The unit stores local time; treat it as local time here too.
    return new Date(year, month - 1, day, hour, min, sec);
  }

  // ---------- file parsers ----------

  function parseSongSys(buf) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const magic = ascii(b, SONG.MAGIC, 8);
    if (b.length < 0x300 || !magic.startsWith('MODEL')) {
      throw new Error('Not a Model song.sys file');
    }
    const marks = [];
    for (let i = 0; i < SONG.MARK_SLOTS; i++) {
      const v = dv.getUint32(SONG.MARKS + i * 4, true);
      if (v !== 0xffffffff) marks.push(v);
    }
    return {
      protected: b[SONG.PROTECT] === 1,
      bytesPerSample: b[SONG.BYTES_PER_SAMPLE] || null,
      created: fatDateTime(dv.getUint16(SONG.FAT_DATE, true), dv.getUint16(SONG.FAT_TIME, true)),
      marks: marks.sort((a, b2) => a - b2),
      tempo: b[SONG.TEMPO] || null,
    };
  }

  function parseCardSys(buf) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (ascii(b, CARD.MAGIC, 8) !== 'TASCAM_M') throw new Error('Not a tascam_m.sys file');
    return {
      currentSong: b.length > CARD.CURRENT_SONG ? ascii(b, CARD.CURRENT_SONG, 64) : '',
      lastPosition: b.length >= CARD.LAST_POS + 4 ? dv.getUint32(CARD.LAST_POS, true) : 0,
    };
  }

  /**
   * Walk the RIFF chunks in the first part of a WAV file.
   * fileSize is the full file size, so a data chunk past the bytes we read is still sized correctly.
   */
  function parseWavHeader(buf, fileSize) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') throw new Error('Not a WAV file');
    const out = { format: null, channels: 0, sampleRate: 0, bitsPerSample: 0, dataOffset: -1, dataSize: 0, bextDate: null };
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = dv.getUint32(p + 4, true);
      if (id === 'fmt ' && p + 24 <= b.length) {
        out.format = dv.getUint16(p + 8, true);
        out.channels = dv.getUint16(p + 10, true);
        out.sampleRate = dv.getUint32(p + 12, true);
        out.bitsPerSample = dv.getUint16(p + 22, true);
      } else if (id === 'bext' && p + 8 + 338 <= b.length) {
        out.bextDate = ascii(b, p + 8 + 320, 10) + ' ' + ascii(b, p + 8 + 330, 8);
      } else if (id === 'data') {
        out.dataOffset = p + 8;
        const total = fileSize != null ? fileSize : b.length;
        out.dataSize = Math.min(size, Math.max(0, total - out.dataOffset));
        break; // audio follows; nothing else we need
      }
      p += 8 + size + (size & 1);
    }
    if (out.format !== 1) throw new Error('Unsupported WAV format (expected PCM)');
    if (out.dataOffset < 0) { out.dataOffset = p; out.dataSize = 0; } // header-only (empty) track
    out.bytesPerFrame = out.channels * (out.bitsPerSample / 8);
    out.frames = Math.floor(out.dataSize / out.bytesPerFrame);
    out.duration = out.sampleRate ? out.frames / out.sampleRate : 0;
    return out;
  }

  /** Convert raw little-endian PCM bytes of one channel of an interleaved stream to floats. */
  function pcmToFloat(bytes, bitsPerSample, channels, channel, out) {
    const b = asBytes(bytes);
    const bps = bitsPerSample / 8;
    const frameBytes = bps * channels;
    const frames = Math.floor(b.length / frameBytes);
    const res = out || new Float32Array(frames);
    let o = channel * bps;
    if (bps === 2) {
      for (let i = 0; i < frames; i++, o += frameBytes) {
        let v = b[o] | (b[o + 1] << 8);
        if (v & 0x8000) v -= 0x10000;
        res[i] = v / 32768;
      }
    } else if (bps === 3) {
      for (let i = 0; i < frames; i++, o += frameBytes) {
        let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        res[i] = v / 8388608;
      }
    } else if (bps === 4) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i < frames; i++, o += frameBytes) res[i] = dv.getInt32(o, true) / 2147483648;
    } else {
      throw new Error('Unsupported bit depth: ' + bitsPerSample);
    }
    return res;
  }

  // ---------- card scanning ----------

  const TRACK_RE = new RegExp(MODEL.trackFile, 'i');

  /**
   * Find the card root inside a list of paths. Handles the user picking the card itself,
   * or a folder that contains a copy of the card (e.g. "SD CARD 01/").
   */
  function findCardRoot(paths) {
    let best = null;
    for (const p of paths) {
      const parts = p.split('/');
      const i = parts.findIndex((x) => x === MTR || x.toLowerCase() === MODEL.cardFile);
      if (i < 0) continue;
      const prefix = parts.slice(0, i).join('/');
      if (best === null || prefix.length < best.length) best = prefix;
    }
    return best;
  }

  /** Group entries into songs. Only file sizes are used here, so no file contents are read. */
  function scanEntries(entries) {
    const root = findCardRoot(entries.map((e) => e.path));
    if (root === null) throw new Error('No MTR folder or tascam_m.sys found. Pick the SD card (TASCAM_M) folder.');
    const strip = root ? root.length + 1 : 0;
    const rel = entries
      .filter((e) => !root || e.path.startsWith(root + '/'))
      .map((e) => Object.assign({}, e, { path: e.path.slice(strip) }));

    const songs = new Map();
    const music = [];
    const leftovers = [];
    let cardSys = null, metaEntry = null, coverEntry = null;
    const settings = [];

    for (const e of rel) {
      const parts = e.path.split('/');
      if (parts.some((p) => /^(~tmm|tmmtmp_)/i.test(p))) { leftovers.push(e.path); if (parts[0] === MUSIC) continue; }
      if (parts.length === 1 && parts[0].toLowerCase() === MODEL.cardFile) cardSys = e;
      else if (parts.length === 1 && parts[0].toLowerCase() === META_FILE) metaEntry = e;
      else if (parts.length === 2 && parts[0].toUpperCase() === SETTINGS_DIR && /\.json$/i.test(parts[1])) settings.push(e);
      else if (parts.length === 1 && /^(cover|folder)\.(jpe?g|png)$/i.test(parts[0]) && (!coverEntry || /^cover\.jpe?g$/i.test(parts[0]))) coverEntry = e;
      else if (parts[0] === MUSIC && parts.length <= 4 && /\.wav$/i.test(e.path)) music.push(e);
      else if (parts[0] === MTR && parts.length === 3) {
        const folder = parts[1];
        if (!songs.has(folder)) songs.set(folder, { folder, name: folder, songSys: null, tracks: new Array(TRACKS).fill(null), warnings: [] });
        const s = songs.get(folder);
        const file = parts[2];
        if (file.toLowerCase() === MODEL.songFile) s.songSys = e;
        const m = TRACK_RE.exec(file);
        if (m) {
          const n = parseInt(m[3], 10);
          if (n >= 1 && n <= TRACKS) {
            s.tracks[n - 1] = { n, entry: e, size: e.size, empty: e.size <= EMPTY_TRACK_MAX_BYTES };
            if (m[2] !== folder) s.warnings.push(`TR${m[3]} file prefix "${m[2]}" differs from folder name`);
          }
        }
      }
    }

    const list = [...songs.values()].map((s) => {
      const missing = s.tracks.map((t, i) => (t ? null : i + 1)).filter(Boolean);
      if (missing.length) s.warnings.push(`Missing track files: ${missing.join(', ')}`);
      if (!s.songSys) s.warnings.push('song.sys is missing');
      s.used = s.tracks.filter((t) => t && !t.empty).length;
      s.totalBytes = s.tracks.reduce((a, t) => a + (t ? t.size : 0), 0);
      return s;
    });

    music.sort((a, b) => a.path.localeCompare(b.path));
    return { root, cardSys, metaEntry, coverEntry, settings, songs: list, music, leftovers };
  }

  async function readSlice(entry, start, end) {
    const f = await entry.getFile();
    return new Uint8Array(await f.slice(start, end).arrayBuffer());
  }

  /** Read song.sys and one track header for each song. Fills in details on the song objects. */
  async function loadSongDetails(song) {
    if (song.songSys) {
      try { Object.assign(song, { sys: parseSongSys(await readSlice(song.songSys, 0, 2048)) }); }
      catch (err) { song.warnings.push('song.sys: ' + err.message); }
    }
    // Prefer the longest track for duration; any track works for the format.
    const ref = song.tracks.filter(Boolean).sort((a, b) => b.size - a.size)[0];
    if (ref) {
      try {
        const h = parseWavHeader(await readSlice(ref.entry, 0, HEADER_READ_BYTES), ref.size);
        song.sampleRate = h.sampleRate;
        song.bitsPerSample = h.bitsPerSample;
        song.duration = h.duration;
        song.recorded = h.bextDate;
      } catch (err) { song.warnings.push(`TR${String(ref.n).padStart(2, '0')}: ${err.message}`); }
    }
    return song;
  }

  async function loadCard(entries) {
    const card = scanEntries(entries);
    card.info = null;
    if (card.cardSys) {
      try { card.info = parseCardSys(await readSlice(card.cardSys, 0, card.cardSys.size)); }
      catch (err) { card.warning = 'tascam_m.sys: ' + err.message; }
    }
    // song info and mixes: SETTINGS/<song>.json, plus the older metadata.txt (converted on the first write)
    card.meta = {};
    card.cardSettings = { artists: [], genres: [] };
    if (card.metaEntry) {
      try {
        const legacy = parseMetadata(new TextDecoder().decode(await readSlice(card.metaEntry, 0, card.metaEntry.size)));
        if (legacy['*']) { if (legacy['*'].artist) card.cardSettings.artists.push(legacy['*'].artist); delete legacy['*']; } // old default artist/mix
        card.meta = legacy;
      } catch (err) { card.warning = `${META_FILE}: ${err.message}`; }
    }
    for (const e of card.settings) {
      const name = e.path.split('/').pop();
      try {
        const json = JSON.parse(new TextDecoder().decode(await readSlice(e, 0, e.size)));
        if (name.toLowerCase() === CARD_SETTINGS.toLowerCase()) { card.cardSettings = Object.assign({ artists: [], genres: [] }, json, { artists: [...new Set([...(json.artists || []), ...card.cardSettings.artists])], genres: json.genres || [] }); continue; }
        const stem = name.replace(/\.json$/i, '');
        const song = card.songs.find((s) => s.folder.toLowerCase() === stem.toLowerCase());
        card.meta[song ? song.folder : stem] = settingsToMeta(json);
      } catch (err) { card.warning = `${SETTINGS_DIR}/${name}: ${err.message}`; }
    }
    await Promise.all(card.songs.map(loadSongDetails));
    for (const s of card.songs) s.isCurrent = !!card.info && card.info.currentSong === s.folder;
    return card;
  }

  // ---------- song names ----------

  const NAME_MAX = MODEL.songNameMax; // Model 12 limit (manual p.37)
  // Letters, digits, space and plain symbols. Excludes characters FAT can't store (\ / : * ? " < > |).
  const NAME_ALLOWED = new RegExp(MODEL.songNameAllowed);

  /**
   * Check a new song name against the Model 12 and SD card rules.
   * songs: the songs on the card; ownFolder: the folder being renamed (or null for a new name).
   */
  function validateSongName(name, songs, ownFolder) {
    const errors = [];
    const same = name === ownFolder;
    const caseOnly = !!ownFolder && !same && name.toLowerCase() === ownFolder.toLowerCase();
    if (!name) errors.push('Enter a name.');
    else {
      if (name.length > NAME_MAX) errors.push(`Max ${NAME_MAX} characters (the Model 12 limit).`);
      if (!NAME_ALLOWED.test(name)) errors.push('Use letters, digits, spaces and plain symbols only. Not allowed: \\ / : * ? " < > | and accented letters.');
      if (/^ | $/.test(name)) errors.push('No space at the start or end.');
      if (/\.$/.test(name) || /^\.+$/.test(name)) errors.push('The name cannot end with a dot.');
      if (/^(~tmm|tmmtmp_)/i.test(name)) errors.push('Names starting with "tmmtmp_" are reserved for the app.');
      const clash = songs.find((s) => s.folder !== ownFolder && s.folder.toLowerCase() === name.toLowerCase());
      if (clash) errors.push(`A song called "${clash.folder}" already exists (the card ignores upper/lower case).`);
    }
    return { ok: !errors.length && !same, errors, caseOnly, same };
  }

  /** New name for a file inside a song folder: only "NN_<old>_TRnn.wav" files change. */
  function renamedTrackFile(fileName, oldName, newName) {
    const m = TRACK_RE.exec(fileName);
    if (!m || m[2] !== oldName) return fileName;
    return `${m[1]}_${newName}${fileName.slice(fileName.lastIndexOf('_TR'))}`;
  }

  /** Return a copy of tascam_m.sys with a new current-song name (null-padded, like the unit does). */
  function setCurrentSongName(buf, name) {
    const b = new Uint8Array(asBytes(buf)); // copy
    if (ascii(b, CARD.MAGIC, 8) !== 'TASCAM_M' || b.length <= CARD.CURRENT_SONG + NAME_MAX) throw new Error('Not a tascam_m.sys file');
    b.fill(0, CARD.CURRENT_SONG);
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) throw new Error('Song name must be plain ASCII');
      b[CARD.CURRENT_SONG + i] = c;
    }
    return b;
  }

  /**
   * Turn a track's header into an empty track, the way the Model 12 stores one:
   * all chunks before the audio unchanged, then a 'data' chunk of size 0 (5,548 bytes on the unit).
   * `buf` must contain at least everything up to the start of the audio.
   */
  function emptyTrack(buf) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') throw new Error('Not a WAV file');
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = dv.getUint32(p + 4, true);
      if (id === 'data') {
        const out = new Uint8Array(p + 8);
        out.set(b.subarray(0, p + 8));
        const odv = new DataView(out.buffer);
        odv.setUint32(p + 4, 0, true);            // no audio
        odv.setUint32(4, out.length - 8, true);   // RIFF size
        return out;
      }
      p += 8 + size + (size & 1);
    }
    throw new Error('No data chunk found in the track header');
  }

  // ---------- channels, as the Model 12's TRACK SWAP / TRACK CLEAR screens offer them ----------

  // Manual order: 1 … 8, 7/8, 9, 10, 9/10, 11, 12, 11/12
  const CHANNELS = MODEL.channels.map((c) => ({ id: c.id, tracks: c.tracks.slice() }));
  const channel = (id) => CHANNELS.find((c) => c.id === id);

  // ---------- building WAV files the way the unit writes them ----------

  /** Find a chunk in a RIFF header: returns { offset (of the chunk id), size, body (offset of the content) } or null. */
  function findChunk(buf, wanted) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = dv.getUint32(p + 4, true);
      if (id === wanted) return { offset: p, size, body: p + 8 };
      if (id === 'data') return null;
      p += 8 + size + (size & 1);
    }
    return null;
  }

  /** Write the BWF origination date and time (local) into a header's bext chunk, like the unit does on export. */
  function setBextDateTime(header, date) {
    const bext = findChunk(header, 'bext');
    if (!bext || bext.size < 338) return header;
    const p2 = (n) => String(n).padStart(2, '0');
    const d = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
    const t = `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
    for (let i = 0; i < 10; i++) header[bext.body + 320 + i] = d.charCodeAt(i);
    for (let i = 0; i < 8; i++) header[bext.body + 330 + i] = t.charCodeAt(i);
    return header;
  }

  /**
   * Make a new header from a Model 12 track header (everything up to and including the data chunk header),
   * set to the given channel count / bit depth and audio size. All other chunks (bext, cue, LIST) stay as they are.
   */
  function headerFromTemplate(template, { channels, bitsPerSample, dataBytes }) {
    const t = asBytes(template);
    const data = findDataOffset(t);
    const h = new Uint8Array(t.subarray(0, data + 8));
    const dv = new DataView(h.buffer);
    const fmt = findChunk(h, 'fmt ');
    if (!fmt) throw new Error('Template has no fmt chunk');
    const rate = dv.getUint32(fmt.body + 4, true);
    const block = channels * (bitsPerSample / 8);
    dv.setUint16(fmt.body + 2, channels, true);
    dv.setUint32(fmt.body + 8, rate * block, true);
    dv.setUint16(fmt.body + 12, block, true);
    dv.setUint16(fmt.body + 14, bitsPerSample, true);
    dv.setUint32(data + 4, dataBytes, true);
    dv.setUint32(4, h.length - 8 + dataBytes, true);
    return h;
  }

  function findDataOffset(buf) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 12;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      if (id === 'data') return p;
      const size = dv.getUint32(p + 4, true);
      p += 8 + size + (size & 1);
    }
    throw new Error('No data chunk found in the header');
  }

  // ---------- reading WAV files from elsewhere (for import) ----------

  /**
   * Read the format of any common WAV file: PCM 16/24/32-bit or 32-bit float, also WAVE_FORMAT_EXTENSIBLE.
   * Returns { channels, sampleRate, bitsPerSample, float, dataOffset, dataSize, frames, bytesPerFrame, duration }.
   */
  function parseAnyWav(buf, fileSize) {
    const b = asBytes(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') throw new Error('This is not a WAV file.');
    let p = 12, fmt = null;
    while (p + 8 <= b.length) {
      const id = ascii(b, p, 4);
      const size = dv.getUint32(p + 4, true);
      if (id === 'fmt ') {
        let tag = dv.getUint16(p + 8, true);
        if (tag === 0xfffe && size >= 40) tag = dv.getUint16(p + 8 + 24, true); // extensible: sub-format GUID starts with the tag
        fmt = { tag, channels: dv.getUint16(p + 10, true), sampleRate: dv.getUint32(p + 12, true), bitsPerSample: dv.getUint16(p + 22, true) };
      } else if (id === 'data') {
        if (!fmt) throw new Error('The WAV file has no format information before its audio.');
        const total = fileSize != null ? fileSize : b.length;
        const dataSize = Math.min(size, total - (p + 8));
        const isFloat = fmt.tag === 3;
        if (!(fmt.tag === 1 || isFloat)) throw new Error('Only uncompressed WAV (PCM or 32-bit float) can be imported.');
        if (isFloat ? fmt.bitsPerSample !== 32 : ![16, 24, 32].includes(fmt.bitsPerSample)) throw new Error(`${fmt.bitsPerSample}-bit${isFloat ? ' float' : ''} WAV files are not supported.`);
        if (fmt.channels < 1 || fmt.channels > 2) throw new Error(`The file has ${fmt.channels} channels; only mono and stereo can be imported.`);
        const bytesPerFrame = fmt.channels * fmt.bitsPerSample / 8;
        const frames = Math.floor(dataSize / bytesPerFrame);
        return { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample, float: isFloat, dataOffset: p + 8, dataSize, frames, bytesPerFrame, duration: frames / fmt.sampleRate };
      }
      p += 8 + size + (size & 1);
    }
    throw new Error('No audio found in the first part of the file (the header may be unusually large).');
  }

  /**
   * Take one channel out of interleaved source bytes and write it as mono PCM at the target bit depth.
   * 24/32-bit → 16-bit is rounded with a little TPDF dither; float is clipped to full scale.
   */
  function convertChannel(src, info, channelIndex, outBits) {
    const s = asBytes(src);
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const inB = info.bitsPerSample / 8, frameB = info.bytesPerFrame;
    const frames = Math.floor(s.length / frameB);
    const outB = outBits / 8;
    const out = new Uint8Array(frames * outB);
    const max = outBits === 16 ? 32767 : 8388607;
    const dither = outBits === 16 && (info.float || info.bitsPerSample > 16);
    for (let i = 0, o = channelIndex * inB, w = 0; i < frames; i++, o += frameB, w += outB) {
      let v; // -1 … 1
      if (info.float) v = dv.getFloat32(o, true);
      else if (inB === 2) v = dv.getInt16(o, true) / 32768;
      else if (inB === 3) { let x = s[o] | (s[o + 1] << 8) | (s[o + 2] << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
      else v = dv.getInt32(o, true) / 2147483648;
      let q;
      if (!info.float && inB === outB) {
        // same bit depth: copy the sample bytes exactly
        for (let k = 0; k < outB; k++) out[w + k] = s[o + k];
        continue;
      }
      q = v * (max + 1) + (dither ? (Math.random() - Math.random()) : 0);
      q = Math.round(q);
      if (q > max) q = max; else if (q < -max - 1) q = -max - 1;
      out[w] = q & 0xff; out[w + 1] = (q >> 8) & 0xff;
      if (outB === 3) out[w + 2] = (q >> 16) & 0xff;
    }
    return out;
  }

  // ---------- other audio formats (decoded by the browser) ----------

  /** What kind of audio file this is, from its first bytes. */
  function sniffAudio(buf) {
    const b = asBytes(buf);
    const a4 = ascii(b, 0, 4);
    if (a4 === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
    if (a4 === 'fLaC') return 'flac';
    if (a4 === 'OggS') return ascii(b, 28, 8) === 'OpusHead' ? 'opus' : 'ogg';
    if (ascii(b, 4, 4) === 'ftyp') return 'm4a';
    if (a4 === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) return 'aiff';
    if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return (b[1] & 0x06) === 0 && b[0] === 0xff ? 'aac' : 'mp3';
    return 'unknown';
  }
  const LOSSLESS = new Set(['wav', 'flac', 'aiff']);

  /** FLAC STREAMINFO: sample rate, channels, bit depth, length. */
  function parseFlacInfo(buf) {
    const b = asBytes(buf);
    if (ascii(b, 0, 4) !== 'fLaC') throw new Error('This is not a FLAC file.');
    if ((b[4] & 0x7f) !== 0) throw new Error('FLAC file without STREAMINFO.');
    const p = 8 + 10; // after the 4-byte block header and min/max block and frame sizes
    const sampleRate = (b[p] << 12) | (b[p + 1] << 4) | (b[p + 2] >> 4);
    const channels = ((b[p + 2] >> 1) & 7) + 1;
    const bitsPerSample = (((b[p + 2] & 1) << 4) | (b[p + 3] >> 4)) + 1;
    const frames = (b[p + 3] & 0x0f) * 2 ** 32 + ((b[p + 4] << 24) >>> 0) + (b[p + 5] << 16) + (b[p + 6] << 8) + b[p + 7];
    return { sampleRate, channels, bitsPerSample, frames, duration: sampleRate ? frames / sampleRate : 0 };
  }

  /**
   * Float samples (-1 … 1, as the browser decodes them) to little-endian PCM.
   * exact = the floats hold whole 16/24-bit values (lossless source, no rate conversion): plain rounding,
   * which gives back the original samples. Otherwise TPDF dither when going to 16-bit.
   */
  function floatToPcm(f32, outBits, exact) {
    const outB = outBits / 8, max = outBits === 16 ? 32767 : 8388607, scale = max + 1;
    const out = new Uint8Array(f32.length * outB);
    const dither = outBits === 16 && !exact;
    for (let i = 0, w = 0; i < f32.length; i++, w += outB) {
      let q = Math.round(f32[i] * scale + (dither ? Math.random() - Math.random() : 0));
      if (q > max) q = max; else if (q < -scale) q = -scale;
      out[w] = q & 0xff; out[w + 1] = (q >> 8) & 0xff;
      if (outB === 3) out[w + 2] = (q >> 16) & 0xff;
    }
    return out;
  }

  // ---------- tempo estimate from audio ----------

  function fftMag(re, im) { // in-place radix-2 FFT, returns nothing; re/im length is a power of two
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  /**
   * Estimate the tempo of a recording (mono float samples). Spectral-flux onset envelope, then
   * autocorrelation over 50–200 BPM with a mild preference for 70–160 BPM to avoid half/double errors.
   * Returns { bpm, confidence (0–1), alternatives: [half, double] } or null when there is no clear beat.
   */
  function estimateTempo(samples, sampleRate, debug) {
    const factor = Math.max(1, Math.round(sampleRate / 11025));
    const sr = sampleRate / factor;
    const n = Math.floor(samples.length / factor);
    const x = new Float32Array(n);
    for (let i = 0, k = 0; i < n; i++) { let s = 0; for (let j = 0; j < factor; j++) s += samples[k++]; x[i] = s / factor; }
    const N = 512, hop = 128, fps = sr / hop;
    const frames = Math.floor((n - N) / hop);
    if (frames < fps * 8) return null; // less than ~8 s of audio
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(N / 2);
    const flux = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fftMag(re, im);
      let s = 0;
      for (let b = 1; b < N / 2; b++) {
        const mag = Math.log1p(100 * Math.hypot(re[b], im[b]));
        const d = mag - prev[b]; if (d > 0) s += d; prev[b] = mag;
      }
      flux[f] = s;
    }
    // remove the slow trend (local mean over ~0.4 s) and keep the rises
    const w = Math.round(fps * 0.4), env = new Float32Array(frames);
    let acc = 0;
    for (let f = 0; f < frames; f++) {
      acc += flux[f]; if (f - w >= 0) acc -= flux[f - w];
      const mean = acc / Math.min(f + 1, w);
      env[f] = Math.max(0, flux[f] - mean);
    }
    const acfAt = (lag) => { let s = 0; for (let i = 0; i + lag < frames; i++) s += env[i] * env[i + lag]; return s / (frames - lag); };
    const minLag = Math.floor(60 * fps / 200), maxLag = Math.ceil(60 * fps / 50);
    const acf = new Float32Array(Math.ceil(60 * fps / 45) * 8 + 2); // up to 8 beats at the slowest tempo
    for (let l = 1; l < acf.length; l++) acf[l] = acfAt(l);
    if (debug) return { fps, acf };
    const at = (v) => { const i = Math.floor(v), f = v - i; return i + 1 < acf.length ? acf[i] * (1 - f) + acf[i + 1] * f : 0; };
    // 1. pick the beat: strength at one and two beats, with a preference for 70–160 BPM (avoids half/double and 3:2 mistakes)
    let best = -1, coarse = 0, sum = 0, cnt = 0;
    for (let b = 50; b <= 200; b += 0.1) {
      const lag = 60 * fps / b;
      const s = (at(lag) + at(2 * lag)) / 2;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(b / 110) / 0.6, 2));
      sum += at(lag); cnt++;
      if (s * prior > best) { best = s * prior; coarse = b; }
    }
    // 2. fine-tune within ±3% using up to 8 beats, which pins the tempo down to a fraction of a BPM
    let fineBest = -1, bpm = coarse;
    for (let b = coarse * 0.97; b <= coarse * 1.03; b += 0.02) {
      const lag = 60 * fps / b;
      let s = 0; for (let k = 1; k <= 8; k++) s += at(k * lag);
      if (s > fineBest) { fineBest = s; bpm = b; }
    }
    const confidence = Math.max(0, Math.min(1, (at(60 * fps / bpm) / (sum / cnt) - 1) / 3));
    const r = (v) => Math.round(v * 10) / 10;
    return { bpm: r(bpm), confidence: Math.round(confidence * 100) / 100, alternatives: [r(bpm / 2), r(bpm * 2)].filter((v) => v >= 40 && v <= 240) };
  }

  /**
   * A plain stereo PCM WAV (RIFF, fmt, data) from float channels, with optional tag chunks after the audio.
   * 24-bit: plain rounding (plenty of resolution); 16-bit: TPDF dither. Optional gain is applied first.
   */
  function makeStereoWav(left, right, sampleRate, bits = 24, extra = new Uint8Array(0), gain = 1) {
    const B = bits / 8, frames = left.length, dataBytes = frames * 2 * B;
    const head = new Uint8Array(44), dv = new DataView(head.buffer);
    const w = (o, s) => { for (let i = 0; i < 4; i++) head[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes + extra.length, true); w(8, 'WAVE');
    w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2 * B, true); dv.setUint16(32, 2 * B, true); dv.setUint16(34, bits, true);
    w(36, 'data'); dv.setUint32(40, dataBytes, true);
    const out = new Uint8Array(44 + dataBytes + extra.length);
    out.set(head, 0);
    const max = bits === 16 ? 32767 : 8388607, scale = max + 1, dither = bits === 16;
    for (let i = 0, o = 44; i < frames; i++) {
      for (const ch of [left, right]) {
        let q = Math.round(ch[i] * gain * scale + (dither ? Math.random() - Math.random() : 0));
        if (q > max) q = max; else if (q < -scale) q = -scale;
        out[o] = q & 0xff; out[o + 1] = (q >> 8) & 0xff; if (B === 3) out[o + 2] = (q >> 16) & 0xff;
        o += B;
      }
    }
    out.set(extra, 44 + dataBytes);
    return out;
  }

  /** Simple 32-bit FNV-1a checksum, to verify large writes without keeping a copy. */
  function fnv1a(bytes, h = 0x811c9dc5) {
    const b = asBytes(bytes);
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  /** Problems found from the scan alone (no full read). */
  function cardIssues(card) {
    const issues = [];
    if (!card.cardSys) issues.push({ level: 'warn', msg: 'tascam_m.sys is missing. The Model 12 will offer to create it ("Make sys file").' });
    const cur = card.info && card.info.currentSong;
    if (cur && !card.songs.some((s) => s.folder === cur)) {
      issues.push({ level: 'warn', msg: `The current song "${cur}" doesn't exist on the card. The Model 12 may show an error at start-up.` });
    }
    for (const s of card.songs) for (const w of s.warnings) issues.push({ level: 'error', song: s.folder, msg: w });
    if (card.leftovers && card.leftovers.length) {
      issues.push({ level: 'warn', msg: `${card.leftovers.length} file(s) left behind by an interrupted change (names starting with "tmmtmp_" or "~tmm"): ${card.leftovers.slice(0, 4).join(', ')}${card.leftovers.length > 4 ? ', …' : ''}. Check that the song plays correctly, then delete them from the card with your file manager.` });
    }
    if (card.songs.length > 100) issues.push({ level: 'warn', msg: `${card.songs.length} songs: the Model 12 supports at most 100.` });
    return issues;
  }

  // ---------- duplicate ----------

  /**
   * Name for a copy: "01" appended when it fits (max 11 characters), otherwise the last two characters
   * replaced by "01"; if that name is taken, 02, 03 … (names are compared ignoring case, like the card does).
   */
  function duplicateName(name, songs) {
    const taken = new Set(songs.map((s) => s.folder.toLowerCase()));
    for (let n = 1; n < 100; n++) {
      const sfx = String(n).padStart(2, '0');
      const cand = name.length + 2 <= NAME_MAX ? name + sfx : name.slice(0, -2) + sfx;
      if (!taken.has(cand.toLowerCase()) && validateSongName(cand, songs, null).ok) return cand;
    }
    return null;
  }

  // ---------- new song ----------

  /**
   * song.sys for a new song, cloned from an existing song with the same format (the sample rate's place in
   * song.sys is not known yet, so the template must match). Reset: protect off, no marks, tempo 120,
   * flag 0x262 off, created = now. Everything else is kept from the template.
   */
  function newSongSys(template, date = new Date()) {
    const b = template.slice();
    if (b.length !== hex(MODEL.songSysSize || 2048) || String.fromCharCode(...b.subarray(0, 5)) !== 'MODEL') throw new Error('The template song.sys is not a Model 12 song file.');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    b[SONG.PROTECT] = 0;
    for (let i = 0; i < SONG.MARK_SLOTS; i++) dv.setUint32(SONG.MARKS + i * 4, 0xffffffff, true);
    b[SONG.TEMPO] = 120;
    b[SONG.FLAG_262] = 0;
    const y = Math.max(1980, date.getFullYear());
    dv.setUint16(SONG.FAT_DATE, ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(), true);
    dv.setUint16(SONG.FAT_TIME, (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), true);
    return b;
  }

  // ---------- song info (metadata.txt at the card root, written by this app; the Model 12 ignores it) ----------

  const META_FILE = 'metadata.txt'; // older format, converted to SETTINGS/*.json
  const SETTINGS_DIR = 'SETTINGS';
  const CARD_SETTINGS = '_card_settings.json'; // longer than any song name (max 11), so it can't clash

  /** A song's settings file (SETTINGS/<song>.json) from the app's in-memory section, and back. */
  function metaToSettings(folder, sec) {
    const info = {};
    for (const k of META_FIELDS) if (sec[k] != null && String(sec[k]).trim()) info[k] = String(sec[k]).trim();
    let mix = null;
    try { mix = sec.mix ? JSON.parse(sec.mix) : null; } catch (e) { mix = null; }
    const out = { app: '12card', format: 1, song: folder, info };
    if (mix) out.mix = mix;
    return out;
  }
  function settingsToMeta(json) {
    const sec = {};
    const info = (json && json.info) || {};
    for (const k of META_FIELDS) if (info[k] != null && String(info[k]).trim()) sec[k] = String(info[k]);
    if (json && json.mix) sec.mix = JSON.stringify(json.mix);
    return sec;
  }
  const META_FIELDS = ['title', 'artist', 'genre', 'year', 'bpm', 'description', 'comment'];
  const META_EXTRA = ['mix']; // the app's mixer settings for the song (JSON on one line)

  /** Parse metadata.txt: "[FOLDER]" sections with "key = value" lines. Newlines in values are stored as \n. */
  function parseMetadata(text) {
    const out = {};
    let cur = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const sec = /^\[(.*)\]$/.exec(line);
      if (sec) { cur = out[sec[1]] = out[sec[1]] || {}; continue; }
      const kv = /^([A-Za-z]+)\s*=\s?(.*)$/.exec(raw.replace(/^\s+/, ''));
      if (cur && kv && (META_FIELDS.includes(kv[1].toLowerCase()) || META_EXTRA.includes(kv[1].toLowerCase()))) {
        cur[kv[1].toLowerCase()] = kv[2].replace(/\s+$/, '').replace(/\\(n|\\)/g, (x, c) => (c === 'n' ? '\n' : '\\'));
      }
    }
    return out;
  }

  function serializeMetadata(map) {
    const lines = [
      '# Song info for 12card. The Model 12 itself ignores this file.',
      '# One [section] per song folder in MTR. Fields: title, artist, genre, year, bpm, comment; mix = the app\'s mixer settings.',
      '# [*] holds card-wide defaults (artist, mix).',
      '',
    ];
    for (const folder of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
      const m = map[folder];
      const filled = META_FIELDS.concat(META_EXTRA).filter((k) => m[k] && String(m[k]).trim());
      if (!filled.length) continue;
      lines.push(`[${folder}]`);
      for (const k of filled) lines.push(`${k} = ${String(m[k]).trim().replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n')}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ---------- tags for exported WAV files (only for exports outside the card) ----------

  function chunk(id, body) {
    const pad = body.length & 1;
    const out = new Uint8Array(8 + body.length + pad);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  }
  const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  const utf8 = (s) => new TextEncoder().encode(s);
  function utf16bom(s) { const o = new Uint8Array(2 + s.length * 2); o[0] = 0xff; o[1] = 0xfe; for (let i = 0; i < s.length; i++) { o[2 + 2 * i] = s.charCodeAt(i) & 255; o[3 + 2 * i] = s.charCodeAt(i) >> 8; } return o; }

  /**
   * Tag chunks to append after the audio: a LIST/INFO chunk (read by most players and DAWs)
   * and an "id3 " chunk with ID3v2.3 (read by Apple Music, Finder, many others).
   * Returns an empty array when there is nothing to tag.
   */
  function wavTagChunks(meta, software = '12card', cover = null) {
    const m = meta || {};
    const has = META_FIELDS.some((k) => m[k] && String(m[k]).trim()) || !!(cover && cover.bytes && cover.bytes.length);
    if (!has) return new Uint8Array(0);
    const info = [];
    const add = (id, v) => { if (v && String(v).trim()) info.push(chunk(id, concat([utf8(String(v).trim()), new Uint8Array([0])]))); };
    add('INAM', m.title); add('IART', m.artist); add('IGNR', m.genre); add('ICRD', m.year); add('ICMT', m.comment); add('ISFT', software);
    const list = chunk('LIST', concat([utf8('INFO'), ...info]));
    // ID3v2.3, text frames in UTF-16 with BOM
    const frames = [];
    const frame = (id, body) => { const f = new Uint8Array(10 + body.length); for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i); new DataView(f.buffer).setUint32(4, body.length); f.set(body, 10); frames.push(f); };
    const text = (id, v) => { if (v && String(v).trim()) frame(id, concat([new Uint8Array([1]), utf16bom(String(v).trim())])); };
    text('TIT2', m.title); text('TPE1', m.artist); text('TCON', m.genre); text('TYER', m.year);
    if (m.bpm && String(m.bpm).trim()) text('TBPM', String(Math.round(parseFloat(m.bpm))));
    if (cover && cover.bytes && cover.bytes.length) {
      // APIC: text encoding 0, MIME type, picture type 3 (front cover), empty description, image data
      frame('APIC', concat([new Uint8Array([0]), utf8(cover.mime || 'image/jpeg'), new Uint8Array([0, 3, 0]), asBytes(cover.bytes)]));
    }
    if (m.comment && String(m.comment).trim()) frame('COMM', concat([new Uint8Array([1]), utf8('eng'), utf16bom(''), new Uint8Array([0, 0]), utf16bom(String(m.comment).trim())]));
    const body = concat(frames);
    const size = body.length;
    const head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
    return concat([list, chunk('id3 ', concat([head, body]))]);
  }

  // ---------- trimming a song (cutting the same stretch off the start and end of every track) ----------

  /** Move marks for a cut: drop those outside [start, start + frames), shift the rest, sorted. */
  function shiftMarks(marks, start, frames) {
    return marks.map((m) => m - start).filter((m) => m >= 0 && m < frames).sort((a, b) => a - b);
  }

  /**
   * The header of a trimmed track: the track's own header (everything up to the audio) with only the sizes
   * changed, and the marks in its cue chunk moved with the cut, laid out the way the unit does it:
   * used slots 1…n in order (id n, LIST label "MARK_nn"), free slots id n|0xFF000000 with an empty label.
   * Tracks without marks keep their cue and LIST chunks byte for byte.
   */
  function trimmedHeader(buf, { start, frames, bytesPerFrame }) {
    const b = asBytes(buf);
    const data = findDataOffset(b);
    const h = new Uint8Array(b.subarray(0, data + 8));
    const dv = new DataView(h.buffer);
    const dataBytes = frames * bytesPerFrame;
    dv.setUint32(data + 4, dataBytes, true);
    dv.setUint32(4, h.length - 8 + dataBytes + (dataBytes & 1), true);
    let marksBefore = 0, marksAfter = 0;
    const cue = findChunk(h, 'cue ');
    if (cue && cue.size >= 4) {
      const slots = Math.min(dv.getUint32(cue.body, true), Math.floor((cue.size - 4) / 24));
      const used = [];
      for (let i = 0; i < slots; i++) {
        const o = cue.body + 4 + i * 24;
        if (!(dv.getUint32(o, true) & 0xff000000)) used.push(dv.getUint32(o + 20, true));
      }
      marksBefore = used.length;
      if (used.length) {
        const moved = shiftMarks(used, start, frames);
        marksAfter = moved.length;
        const list = findChunk(h, 'LIST');
        const adtl = list && ascii(h, list.body, 4) === 'adtl' ? list.body + 4 : -1;
        for (let i = 0; i < slots; i++) {
          const o = cue.body + 4 + i * 24, n = i + 1, on = i < moved.length;
          dv.setUint32(o, on ? n : (n | 0xff000000) >>> 0, true);
          dv.setUint32(o + 4, on ? moved[i] : 0, true);
          dv.setUint32(o + 20, on ? moved[i] : 0, true);
          // the matching label: 'labl', size 12, id, 8 bytes of text
          if (adtl > 0) {
            const l = adtl + i * 20;
            if (l + 20 <= list.body + list.size && ascii(h, l, 4) === 'labl' && dv.getUint32(l + 8, true) === n) {
              const text = on ? `MARK_${String(n).padStart(2, '0')}` : '';
              for (let k = 0; k < 8; k++) h[l + 12 + k] = k < text.length ? text.charCodeAt(k) : 0;
            }
          }
        }
      }
    }
    return { header: h, marksBefore, marksAfter };
  }

  /** song.sys after a trim: the marks moved with the cut (compacted, in order, 0xFFFFFFFF after). Null if nothing changes. */
  function trimmedSongSys(buf, start, frames) {
    const b = new Uint8Array(asBytes(buf));
    const dv = new DataView(b.buffer);
    const marks = [];
    for (let i = 0; i < SONG.MARK_SLOTS; i++) { const v = dv.getUint32(SONG.MARKS + i * 4, true); if (v !== 0xffffffff) marks.push(v); }
    if (!marks.length) return null;
    const moved = shiftMarks(marks, start, frames);
    for (let i = 0; i < SONG.MARK_SLOTS; i++) dv.setUint32(SONG.MARKS + i * 4, i < moved.length ? moved[i] : 0xffffffff, true);
    return { bytes: b, before: marks.length, after: moved.length };
  }

  const api = {
    shiftMarks, trimmedHeader, trimmedSongSys,
    makeStereoWav, estimateTempo, sniffAudio, parseFlacInfo, floatToPcm, LOSSLESS, duplicateName, newSongSys, META_FILE, SETTINGS_DIR, CARD_SETTINGS, metaToSettings, settingsToMeta, META_FIELDS, META_EXTRA, parseMetadata, serializeMetadata, wavTagChunks,
    MODEL, TRACKS, SONG, CARD, NAME_MAX, TRACK_RE, MTR, MUSIC,
    parseSongSys, parseCardSys, parseWavHeader, pcmToFloat, fatDateTime, findCardRoot, scanEntries, loadSongDetails, loadCard, readSlice, HEADER_READ_BYTES,
    validateSongName, renamedTrackFile, setCurrentSongName, cardIssues, emptyTrack,
    CHANNELS, channel, findChunk, findDataOffset, setBextDateTime, headerFromTemplate, parseAnyWav, convertChannel, fnv1a,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model12 = api;
})(typeof self !== 'undefined' ? self : this);
