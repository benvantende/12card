/*
 * player.js — streaming 12-track player with a preview mixer (Web Audio).
 *
 * Audio is read from the card in small blocks and scheduled ahead of time, so even
 * long 24-bit songs only keep a few seconds in memory.
 *
 * Model 12 layout: CH1–6 mono (TR01–06), CH7/8 and CH9/10 stereo (TR07–10),
 * TR11/12 = the MAIN MIX recording.
 */
(function (root) {
  'use strict';
  const M = root.Model12;

  const BLOCK_SECONDS = 2;      // size of each read
  const LOOKAHEAD_SECONDS = 4;  // how far ahead audio is scheduled
  const START_DELAY = 0.06;

  // channel strips and defaults come from config/card-model12.js and config/mixer.js (track numbers there count from 1)
  const CFG = root.CFG12;
  const STRIPS = CFG.model.strips.map((s) => ({ id: s.id, tracks: s.tracks.map((n) => n - 1), stereo: !!s.stereo, mixRec: !!s.mixRec }));
  const MAIN_TRACKS = CFG.model.mainMix.map((n) => n - 1);

  const DEFAULT_STRIP = Object.assign({}, CFG.mixer.stripDefaults);
  const MAIN_DEFAULT = CFG.mixer.mainFader;

  // fader 0..1 → gain; 0.75 = 0 dB, 1 = +5 dB
  const faderGain = (v) => (v <= 0 ? 0 : Math.pow(v / 0.75, 2));
  // two effects: FX 1 starts as a hall, FX 2 as a tempo delay
  const FX_DEFAULTS = CFG.mixer.effects.map((f) => {
    const d = { type: f.type, ret: f.return, mute: !!f.mute };
    if (typeof f.param === 'number') d.param = f.param; // "default" = the effect type's own default
    return d;
  });
  const SEND_KEYS = ['fx', 'fx2'];
  const fxDefaults = (n, tempo) => {
    const d = Object.assign({}, FX_DEFAULTS[n], { tempo: tempo || 120, tempoFromSong: true });
    if (d.param === undefined) d.param = root.FX.paramInfo(d.type, d.tempo).def;
    return d;
  };
  const midFreq = (v) => 100 * Math.pow(80, v); // 100 Hz … 8 kHz

  class Player {
    constructor() {
      this.ctx = null;
      this.song = null;
      this.tracks = [];          // per track: { file, dataOffset, dataSize, frames, bitsPerSample } or null
      this.sampleRate = 44100;
      this.totalFrames = 0;
      this.mode = 'multi';       // 'multi' (CH1–10 through the mixer) or 'main' (TR11/12 recording)
      this.settings = {};
      for (const s of STRIPS) this.settings[s.id] = Object.assign({}, DEFAULT_STRIP, s.mixRec ? { mute: true } : {});
      this.master = { fader: MAIN_DEFAULT };
      // the effect: type, its one parameter (0…1), FX return fader, mute, tempo (from the song unless changed)
      this.fxs = [fxDefaults(0), fxDefaults(1)]; // FX 1 and FX 2: type, its one parameter, return fader, mute, tempo
      this.mastering = { preset: null, amount: 1, loudness: null }; // preset id from config/mastering.js; loudness: LUFS for downloads
      this.playing = false;
      this.offsetSec = 0;        // position when playback started/paused
      this.t0 = 0;               // ctx time that corresponds to offsetSec
      this.gen = 0;              // bumps on every stop/seek so stale reads are dropped
      this.sources = new Set();
      this.onstate = () => {};
      this.onerror = () => {};
    }

    /** FX 1 (older code and tests use this name). */
    get fxSettings() { return this.fxs[0]; }
    set fxSettings(v) { this.fxs[0] = v; }

    // ---------- audio graph ----------

    _ensureContext(sampleRate) {
      if (this.ctx && this.ctx.sampleRate === sampleRate) return;
      if (this.ctx) this.ctx.close();
      let ctx;
      try { ctx = new AudioContext({ sampleRate, latencyHint: 'playback' }); }
      catch (e) { ctx = new AudioContext({ latencyHint: 'playback' }); } // browser resamples
      this.ctx = ctx;
      this._buildGraph();
    }

    _buildGraph() {
      const { nodes, fx, fxe } = this._graphOn(this.ctx, this.ctx.destination, true);
      this.nodes = nodes; this.fx = fx; this.fxe = fxe;
      this._applyAll();
    }

    /** The mixer on any audio context (live, or offline for rendering a mix). Meters only for the live one. */
    _graphOn(ctx, destination, meters) {
      const g = { strips: {} };
      g.master = ctx.createGain();
      // main fader → mastering → out (the meters and the clip warning read after the mastering)
      g.mastering = new root.Master.Mastering(ctx);
      g.mastering.set(this._masterPreset(), this.mastering.amount, true);
      g.master.connect(g.mastering.input);
      g.mastering.output.connect(destination);
      if (meters) {
        const split = ctx.createChannelSplitter(2);
        g.mastering.output.connect(split);
        g.meterL = ctx.createAnalyser(); g.meterR = ctx.createAnalyser();
        g.meterL.fftSize = g.meterR.fftSize = 1024;
        split.connect(g.meterL, 0); split.connect(g.meterR, 1);
      }
      const fxe = this.fxs.map((s) => new root.FX.Engine(ctx, g.master, s));
      for (const s of STRIPS) {
        const n = {};
        // sources connect to n.input (mono) or to n.merger inputs 0/1 (stereo pair)
        if (s.stereo) { n.merger = ctx.createChannelMerger(2); n.input = n.merger; }
        else { n.input = ctx.createGain(); }
        n.comp = ctx.createDynamicsCompressor();
        n.comp.knee.value = 6; n.comp.attack.value = 0.01; n.comp.release.value = 0.2;
        n.hi = ctx.createBiquadFilter(); n.hi.type = 'highshelf'; n.hi.frequency.value = 10000;
        n.mid = ctx.createBiquadFilter(); n.mid.type = 'peaking'; n.mid.Q.value = 1;
        n.lo = ctx.createBiquadFilter(); n.lo.type = 'lowshelf'; n.lo.frequency.value = 100;
        n.fader = ctx.createGain();
        n.send = ctx.createGain(); n.send2 = ctx.createGain();
        n.pan = ctx.createStereoPanner();
        n.mute = ctx.createGain();
        n.input.connect(n.comp).connect(n.hi).connect(n.mid).connect(n.lo).connect(n.fader);
        n.fader.connect(n.mute).connect(n.pan).connect(g.master);
        n.mute.connect(n.send).connect(fxe[0].input);   // post-fader FX sends; MUTE (and SOLO) cut them too
        n.mute.connect(n.send2).connect(fxe[1].input);
        if (meters) { n.meter = ctx.createAnalyser(); n.meter.fftSize = 512; n.pan.connect(n.meter); }
        g.strips[s.id] = n;
      }
      g.main = ctx.createChannelMerger(2);
      g.mainGain = ctx.createGain();
      g.main.connect(g.mainGain).connect(g.master);
      return { nodes: g, fx: fxe[0], fxe };
    }

    _applyStrip(id, g = this.nodes, ctx = this.ctx) {
      if (!g) return;
      const n = g.strips[id];
      const s = this.settings[id];
      const t = ctx.currentTime;
      n.comp.threshold.setTargetAtTime(-40 * s.comp, t, 0.02);
      n.comp.ratio.setTargetAtTime(1 + 7 * s.comp, t, 0.02);
      n.hi.gain.setTargetAtTime(s.hi, t, 0.02);
      n.mid.frequency.setTargetAtTime(midFreq(s.freq), t, 0.02);
      n.mid.gain.setTargetAtTime(s.mid, t, 0.02);
      n.lo.gain.setTargetAtTime(s.lo, t, 0.02);
      n.fader.gain.setTargetAtTime(faderGain(s.fader), t, 0.02);
      n.send.gain.setTargetAtTime(s.fx * s.fx, t, 0.02);
      n.send2.gain.setTargetAtTime(s.fx2 * s.fx2, t, 0.02);
      n.pan.pan.setTargetAtTime(s.pan, t, 0.02);
      n.mute.gain.setTargetAtTime(this._audible(id) ? 1 : 0, t, 0.01);
    }

    /** Is a strip heard in the multitrack mix (not muted, and soloed if anything is soloed)? */
    _audible(id) {
      const s = this.settings[id];
      const anySolo = STRIPS.some((x) => this.settings[x.id].solo);
      return !s.mute && (!anySolo || s.solo);
    }

    _applyAll(g = this.nodes, ctx = this.ctx) {
      for (const s of STRIPS) this._applyStrip(s.id, g, ctx);
      if (g) g.master.gain.setTargetAtTime(faderGain(this.master.fader), ctx.currentTime, 0.02);
    }

    set(id, key, value) {
      this.settings[id][key] = value;
      // solo affects every strip
      if (key === 'solo') this._applyAll(); else this._applyStrip(id);
    }

    setMaster(value) {
      this.master.fader = value;
      if (this.nodes) this.nodes.master.gain.setTargetAtTime(faderGain(value), this.ctx.currentTime, 0.02);
    }

    _masterPreset() {
      return this.mastering.preset ? (CFG.mastering.presets.find((x) => x.id === this.mastering.preset) || null) : null;
    }

    /** Mastering on the main output: key 'preset' (id or null), 'amount' (0…1) or 'loudness' (LUFS or null, downloads only). */
    setMastering(key, value) {
      this.mastering[key] = value;
      if (this.nodes) this.nodes.mastering.set(this._masterPreset(), this.mastering.amount);
    }

    /** Change a setting of FX 1 (n = 0) or FX 2 (n = 1). */
    setFx(key, value, n = 0) {
      const f = this.fxs[n];
      f[key] = value;
      if (key === 'type') f.param = root.FX.paramInfo(value, f.tempo).def;
      if (key === 'tempo') f.tempoFromSong = false;
      if (this.fxe) this.fxe[n].apply(f);
    }

    /** Effects that follow the song pick up its tempo; force = also those set by hand (the 'song' button). */
    followTempo(tempo, n = null) {
      if (!tempo) return;
      this.fxs.forEach((f, i) => {
        if (n !== null ? i !== n : !f.tempoFromSong) return;
        f.tempo = tempo; f.tempoFromSong = true;
        if (this.fxe) this.fxe[i].apply(f);
      });
    }

    resetStrip(id) { this.settings[id] = Object.assign({}, DEFAULT_STRIP, id === '11/12' ? { mute: true } : {}); this._applyAll(); }

    // ---------- the mix as data (saved per song) ----------

    /** The current mixer, FX and main fader settings, keeping only what differs from the defaults. */
    getMix() {
      const strips = {};
      for (const s of STRIPS) {
        const def = Object.assign({}, DEFAULT_STRIP, s.mixRec ? { mute: true } : {});
        const d = {};
        for (const k of Object.keys(def)) if (k !== 'solo' && this.settings[s.id][k] !== def[k]) d[k] = this.settings[s.id][k]; // solo is for listening, not saved
        if (Object.keys(d).length) strips[s.id] = d;
      }
      const [fx, fx2] = this.fxs.map((f) => {
        const o = { type: f.type, param: f.param, ret: f.ret, mute: f.mute };
        if (!f.tempoFromSong) o.tempo = f.tempo;
        return o;
      });
      const out = { v: 1, strips, master: this.master.fader, fx, fx2 };
      const m = this.mastering;
      if (m.preset || m.loudness != null) out.mastering = { preset: m.preset, amount: m.amount, loudness: m.loudness };
      return out;
    }

    /** Put a saved mix on the console (null = defaults). */
    setMix(mix) {
      for (const s of STRIPS) {
        this.settings[s.id] = Object.assign({}, DEFAULT_STRIP, s.mixRec ? { mute: true } : {}, (mix && mix.strips && mix.strips[s.id]) || {});
      }
      this.master.fader = mix && typeof mix.master === 'number' ? mix.master : MAIN_DEFAULT;
      const songTempo = this.songTempo(this.song);
      this.fxs = ['fx', 'fx2'].map((key, n) => {
        const saved = (mix && mix[key]) || {};
        const f = Object.assign(fxDefaults(n, songTempo), saved, { tempo: saved.tempo || songTempo || 120, tempoFromSong: !saved.tempo });
        if (!saved.type || saved.param === undefined) f.param = root.FX.paramInfo(f.type, f.tempo).def;
        if (this.fxe) this.fxe[n].apply(f);
        return f;
      });
      const ms = (mix && mix.mastering) || {};
      this.mastering = { preset: ms.preset || null, amount: typeof ms.amount === 'number' ? ms.amount : 1, loudness: typeof ms.loudness === 'number' ? ms.loudness : null };
      if (this.nodes) this.nodes.mastering.set(this._masterPreset(), this.mastering.amount);
      this._applyAll();
    }

    // ---------- rendering the multitrack mix (offline, faster than real time) ----------

    /**
     * Render tracks 1–10 (and 11/12 if that strip is heard) through the mixer and effect, as stereo floats.
     * Returns { left, right, sampleRate, peak }. A short lead-in lets every setting settle; it is cut off.
     */
    async renderMix(onProgress = () => {}) {
      if (!this.song || !this.totalFrames) throw new Error('No song loaded.');
      const sr = this.sampleRate, PRE = Math.round(0.25 * sr);
      const ringing = this.fxs.some((f, n) => !f.mute && f.ret > 0 && STRIPS.some((s) => this._audible(s.id) && this.settings[s.id][SEND_KEYS[n]] > 0));
      const roomy = (this._masterPreset() || { chain: [] }).chain.some((b) => b.block === 'room');
      const tail = ringing ? Math.round(6 * sr) : roomy ? Math.round(3 * sr) : Math.round(0.1 * sr);
      const length = PRE + this.totalFrames + tail;
      const ctx = new OfflineAudioContext(2, length, sr);
      const { nodes, fxe } = this._graphOn(ctx, ctx.destination, false);
      this._applyAll(nodes, ctx);
      fxe.forEach((e, n) => e.apply(this.fxs[n]));
      // feed every heard track as one buffer
      let n = 0;
      const used = STRIPS.filter((s) => this._audible(s.id)).flatMap((s) => s.tracks).filter((i) => this.tracks[i]);
      for (const i of used) {
        const t = this.tracks[i];
        const bytes = new Uint8Array(await t.file.slice(t.dataOffset, t.dataOffset + t.frames * t.bitsPerSample / 8).arrayBuffer());
        const buf = ctx.createBuffer(1, t.frames, sr);
        buf.copyToChannel(M.pcmToFloat(bytes, t.bitsPerSample, 1, 0), 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const strip = STRIPS.find((s) => s.tracks.includes(i));
        if (strip.stereo) src.connect(nodes.strips[strip.id].merger, 0, strip.tracks.indexOf(i)); else src.connect(nodes.strips[strip.id].input);
        src.start(PRE / sr);
        onProgress(0.15 * (++n / used.length), 'Reading tracks');
      }
      // progress while rendering: pause the offline clock every 5 %
      const step = length / sr / 20;
      for (let k = 1; k < 20; k++) {
        const at = k * step;
        ctx.suspend(at).then(() => { onProgress(0.15 + 0.8 * at / (length / sr), 'Mixing'); ctx.resume(); });
      }
      const out = await ctx.startRendering();
      const L = out.getChannelData(0), R = out.getChannelData(1);
      // trim: drop the lead-in, keep the song plus any effect tail that is still audible
      let end = length;
      const quiet = Math.pow(10, -90 / 20);
      while (end > PRE + this.totalFrames && Math.abs(L[end - 1]) < quiet && Math.abs(R[end - 1]) < quiet) end--;
      const left = L.slice(PRE, end), right = R.slice(PRE, end);
      let peak = 0;
      for (let k = 0; k < left.length; k++) { const a = Math.max(Math.abs(left[k]), Math.abs(right[k])); if (a > peak) peak = a; }
      onProgress(1, 'Done');
      return { left, right, sampleRate: sr, peak, tracks: used.length };
    }


    // ---------- loading ----------

    async load(song) {
      this.stop();
      this.song = song;
      this.offsetSec = 0;
      const token = this._loadToken = (this._loadToken || 0) + 1;
      const tracks = await Promise.all(song.tracks.map(async (t) => {
        if (!t || t.empty) return null;
        try {
          const file = await t.entry.getFile();
          const head = new Uint8Array(await file.slice(0, M.HEADER_READ_BYTES).arrayBuffer());
          const h = M.parseWavHeader(head, file.size);
          if (h.channels !== 1 || h.frames === 0) return null;
          return { file, dataOffset: h.dataOffset, dataSize: h.dataSize, frames: h.frames, bitsPerSample: h.bitsPerSample, sampleRate: h.sampleRate };
        } catch (e) {
          this.onerror(`TR${String(t.n).padStart(2, '0')}: ${e.message}`);
          return null;
        }
      }));
      if (token !== this._loadToken) return; // another song was opened meanwhile: that one wins
      this.tracks = tracks;
      const present = this.tracks.filter(Boolean);
      this.sampleRate = present.length ? present[0].sampleRate : song.sampleRate || 44100;
      this.totalFrames = present.reduce((a, t) => Math.max(a, t.frames), 0);
      this.mode = 'multi'; // a song always opens in Multitrack; Main mix is one click away
      // delays follow the song's tempo (BPM from Song info, else the click setting), unless changed by hand
      const songTempo = this.songTempo(song);
      this.followTempo(songTempo);
      this.onstate();
    }

    /** The song's tempo for the delays. The app replaces this to use the BPM from Song info first. */
    songTempo(song) { return song && song.sys && song.sys.tempo; }

    hasMainMix() { return MAIN_TRACKS.some((i) => this.tracks[i]); }
    get duration() { return this.totalFrames / this.sampleRate; }

    get position() {
      if (!this.playing || !this.ctx) return this.offsetSec;
      return Math.min(this.duration, this.offsetSec + Math.max(0, this.ctx.currentTime - this.t0));
    }

    setMode(mode) {
      if (mode === this.mode) return;
      const was = this.playing, pos = this.position;
      this.stop(); this.mode = mode; this.offsetSec = pos;
      if (was) this.play(); else this.onstate();
    }

    _activeTracks() {
      return (this.mode === 'main' ? MAIN_TRACKS : STRIPS.flatMap((s) => s.tracks)).filter((i) => this.tracks[i]);
    }

    // ---------- transport ----------

    async play() {
      if (!this.song || this.playing || this.totalFrames === 0) return;
      this._ensureContext(this.sampleRate);
      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (this.offsetSec >= this.duration - 0.05) this.offsetSec = 0;

      const gen = ++this.gen;
      this.playing = true;
      this.startFrame = Math.round(this.offsetSec * this.sampleRate);
      this.nextBlock = 0;
      this.blockFrames = Math.round(BLOCK_SECONDS * this.sampleRate);

      // read the first block before fixing the start time, so playback starts cleanly
      const first = await this._readBlock(0, gen);
      if (gen !== this.gen) return;
      this.t0 = this.ctx.currentTime + START_DELAY;
      this._schedule(0, first);
      this.nextBlock = 1;
      this.onstate();
      this._timer = setInterval(() => this._pump(gen), 250);
      this._pump(gen);
    }

    pause() {
      if (!this.playing) return;
      this.offsetSec = this.position;
      this._halt();
      this.onstate();
    }

    stop() { this._halt(); this.onstate(); }

    seek(sec) {
      const was = this.playing;
      this._halt();
      this.offsetSec = Math.max(0, Math.min(sec, this.duration));
      if (was) this.play(); else this.onstate();
    }

    toggle() { return this.playing ? this.pause() : this.play(); }

    _halt() {
      this.gen++;
      this.playing = false;
      clearInterval(this._timer);
      for (const s of this.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
      this.sources.clear();
    }

    async _pump(gen) {
      if (this._busy || gen !== this.gen) return;
      this._busy = true;
      try {
        while (gen === this.gen) {
          const blockStart = this.startFrame + this.nextBlock * this.blockFrames;
          if (blockStart >= this.totalFrames) {
            // everything is scheduled; stop when the end is reached
            if (this.position >= this.duration - 0.01) { this.offsetSec = this.duration; this._halt(); this.onstate(); }
            break;
          }
          const when = this.t0 + (this.nextBlock * this.blockFrames) / this.sampleRate;
          if (when > this.ctx.currentTime + LOOKAHEAD_SECONDS) break;
          const k = this.nextBlock;
          const data = await this._readBlock(k, gen);
          if (gen !== this.gen) break;
          this._schedule(k, data);
          this.nextBlock = k + 1;
        }
      } catch (e) {
        this.onerror('Playback error: ' + e.message);
        this._halt(); this.onstate();
      } finally {
        this._busy = false;
      }
    }

    async _readBlock(k, gen) {
      const start = this.startFrame + k * this.blockFrames;
      const out = new Map();
      await Promise.all(this._activeTracks().map(async (i) => {
        const t = this.tracks[i];
        if (start >= t.frames) return; // this track has already ended
        const bps = t.bitsPerSample / 8;
        const frames = Math.min(this.blockFrames, t.frames - start);
        const a = t.dataOffset + start * bps;
        const bytes = new Uint8Array(await t.file.slice(a, a + frames * bps).arrayBuffer());
        if (gen !== this.gen) return;
        out.set(i, M.pcmToFloat(bytes, t.bitsPerSample, 1, 0));
      }));
      return out;
    }

    _schedule(k, data) {
      const ctx = this.ctx;
      const when = this.t0 + (k * this.blockFrames) / this.sampleRate;
      for (const [i, samples] of data) {
        if (!samples.length) continue;
        const buf = ctx.createBuffer(1, samples.length, this.sampleRate);
        buf.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        this._connectTrack(src, i);
        src.onended = () => this.sources.delete(src);
        this.sources.add(src);
        src.start(Math.max(when, ctx.currentTime));
      }
    }

    _connectTrack(src, i) {
      const g = this.nodes;
      if (this.mode === 'main') { src.connect(g.main, 0, i - MAIN_TRACKS[0]); return; }
      const strip = STRIPS.find((s) => s.tracks.includes(i));
      const n = g.strips[strip.id];
      if (strip.stereo) src.connect(n.merger, 0, strip.tracks.indexOf(i));
      else src.connect(n.input);
    }

    // ---------- meters ----------

    _peak(analyser) {
      if (!this._meterBuf || this._meterBuf.length !== analyser.fftSize) this._meterBuf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(this._meterBuf);
      let p = 0;
      for (const v of this._meterBuf) { const a = Math.abs(v); if (a > p) p = a; }
      return p;
    }

    meters(force) {
      if (!this.nodes || !(this.playing || force)) return null;
      const strips = {};
      for (const s of STRIPS) strips[s.id] = this._peak(this.nodes.strips[s.id].meter);
      return { l: this._peak(this.nodes.meterL), r: this._peak(this.nodes.meterR), strips };
    }
  }

  /**
   * Plays a 2-mix WAV from MUSIC/ through the same audio engine (main fader + meters).
   * Has the same transport interface as Player: play/pause/toggle/seek/position/duration/playing.
   */
  class MixdownPlayer {
    constructor(player) { this.p = player; this.el = null; this.name = ''; this.onstate = () => {}; }

    async load(file, name) {
      this.unload();
      const p = this.p;
      p.stop();
      p._ensureContext(p.ctx ? p.ctx.sampleRate : 44100);
      this.url = URL.createObjectURL(file);
      const el = new Audio();
      el.preload = 'auto';
      el.src = this.url;
      this.source = p.ctx.createMediaElementSource(el);
      this.source.connect(p.nodes.master);
      for (const ev of ['play', 'pause', 'ended', 'seeked', 'loadedmetadata']) el.addEventListener(ev, () => this.onstate());
      el.addEventListener('error', () => p.onerror('Could not play this file: ' + name));
      this.el = el;
      this.name = name;
      await new Promise((res) => {
        if (el.readyState >= 1) return res();
        el.addEventListener('loadedmetadata', res, { once: true });
        el.addEventListener('error', res, { once: true });
      });
    }

    unload() {
      if (this.el) {
        this.el.pause();
        try { this.source.disconnect(); } catch (e) { /* already gone */ }
        this.el.removeAttribute('src');
        this.el.load();
      }
      if (this.url) URL.revokeObjectURL(this.url);
      this.el = null; this.url = null; this.name = '';
    }

    get active() { return !!this.el; }
    get playing() { return !!this.el && !this.el.paused && !this.el.ended; }
    get position() { return this.el ? this.el.currentTime : 0; }
    get duration() { return this.el && Number.isFinite(this.el.duration) ? this.el.duration : 0; }

    async play() {
      if (!this.el) return;
      if (this.p.ctx.state !== 'running') await this.p.ctx.resume();
      if (this.el.ended) this.el.currentTime = 0;
      try { await this.el.play(); } catch (e) { this.p.onerror('Could not play: ' + e.message); }
    }
    pause() { if (this.el) this.el.pause(); }
    seek(sec) { if (this.el) this.el.currentTime = Math.max(0, Math.min(sec, this.duration)); }
    toggle() { return this.playing ? this.pause() : this.play(); }
  }

  root.Player = Player;
  root.Player.STRIPS = STRIPS;
  root.Player.MAIN_TRACKS = MAIN_TRACKS;
  root.Player.DEFAULT_STRIP = DEFAULT_STRIP;
  root.MixdownPlayer = MixdownPlayer;
})(self);
