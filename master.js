/*
 * master.js — mastering on the main output: a chain of building blocks described in config/mastering.js.
 *
 *   main fader → Mastering.input → [dry] ──────────────┐
 *                                → [chain → wet] ──────┴→ Mastering.output → speakers / render
 *
 * AMOUNT blends the dry and the processed signal (0 … 1). A preset is a list of blocks; each block type
 * is one small function below, so a preset that doesn't work out can be changed in the config file
 * without touching this code. Block types:
 *
 *   eq        { bands: [{ type: lowshelf|highshelf|peaking|lowpass|highpass, freq, gain, q }] }
 *   comp      { threshold, ratio, attack, release, knee, makeup }    (dB, seconds)
 *   width     { amount, monoBelow }   amount 1 = as is, 0 = mono, 1.5 = wider; bass below monoBelow Hz in mono
 *   saturate  { curve: soft|tape|tube, drive, mix }                  (drive in dB)
 *   room      { mix, seconds, damp }                                  a short generated room/plate
 *   wow       { rate, depth, flutterRate, flutterDepth }             pitch wobble, depth in ms
 *   noise     { kind: vinyl|tape|hum, level }                         (level in dBFS)
 *   gain      { db }
 *   limiter   { ceiling }                                             safety limiter at the end (dBFS)
 *
 * Also: a look-ahead peak limiter and loudness normalisation for rendered audio (the My mix download).
 */
(function (root) {
  'use strict';

  const dbToGain = (db) => Math.pow(10, db / 20);

  // ---------- building blocks: each returns { input, output, stop? } ----------

  const BLOCKS = {
    eq(ctx, p) {
      const nodes = (p.bands || []).map((b) => {
        const f = ctx.createBiquadFilter();
        f.type = b.type || 'peaking';
        f.frequency.value = b.freq || 1000;
        if (b.gain != null) f.gain.value = b.gain;
        f.Q.value = b.q != null ? b.q : (f.type === 'lowpass' || f.type === 'highpass' ? 0.707 : 1);
        return f;
      });
      if (!nodes.length) { const g = ctx.createGain(); return { input: g, output: g }; }
      nodes.reduce((a, b) => (a.connect(b), b));
      return { input: nodes[0], output: nodes[nodes.length - 1] };
    },

    comp(ctx, p) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = p.threshold != null ? p.threshold : -18;
      c.ratio.value = p.ratio || 2;
      c.attack.value = p.attack != null ? p.attack : 0.02;
      c.release.value = p.release != null ? p.release : 0.2;
      c.knee.value = p.knee != null ? p.knee : 6;
      const out = ctx.createGain();
      out.gain.value = dbToGain(p.makeup || 0);
      c.connect(out);
      return { input: c, output: out };
    },

    width(ctx, p) {
      // mid/side: M = (L+R)/2, S = (L-R)/2; S is scaled by `amount`; below monoBelow Hz the side is removed
      const amount = p.amount != null ? p.amount : 1;
      const input = ctx.createGain(), output = ctx.createChannelMerger(2);
      input.channelCountMode = 'explicit'; input.channelCount = 2;
      const split = ctx.createChannelSplitter(2);
      input.connect(split);
      const mid = ctx.createGain(), side = ctx.createGain();
      const lToM = ctx.createGain(), rToM = ctx.createGain(), lToS = ctx.createGain(), rToS = ctx.createGain();
      lToM.gain.value = 0.5; rToM.gain.value = 0.5; lToS.gain.value = 0.5; rToS.gain.value = -0.5;
      split.connect(lToM, 0).connect(mid); split.connect(rToM, 1).connect(mid);
      split.connect(lToS, 0).connect(side); split.connect(rToS, 1).connect(side);
      let s = side;
      if (p.monoBelow) {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.monoBelow; hp.Q.value = 0.707;
        s = s.connect(hp);
      }
      const sGain = ctx.createGain(); sGain.gain.value = amount;
      s.connect(sGain);
      const sNeg = ctx.createGain(); sNeg.gain.value = -1;
      // L = M + S, R = M - S
      mid.connect(output, 0, 0); sGain.connect(output, 0, 0);
      mid.connect(output, 0, 1); sGain.connect(sNeg).connect(output, 0, 1);
      return { input, output };
    },

    saturate(ctx, p) {
      const drive = dbToGain(p.drive != null ? p.drive : 6), mix = p.mix != null ? p.mix : 1;
      const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1, d = x * drive;
        let y;
        if (p.curve === 'tube') y = d >= 0 ? Math.tanh(d) : Math.tanh(d * 0.8) / 0.8 * 0.9; // a little asymmetric: even harmonics
        else if (p.curve === 'tape') y = Math.tanh(d) * 0.85 + 0.15 * (d / (1 + Math.abs(d)));
        else y = d / (1 + Math.abs(d));                                                     // soft
        // quiet parts keep their level, peaks get rounded off; the dry part is mixed in the curve itself, so the
        // oversampling filter's small delay can't make the wet and dry signal cancel each other
        curve[i] = mix * (y / drive) + (1 - mix) * x;
      }
      const sh = ctx.createWaveShaper(); sh.curve = curve; sh.oversample = '4x';
      return { input: sh, output: sh };
    },

    room(ctx, p) {
      const secs = p.seconds || 1.5, mix = p.mix != null ? p.mix : 0.15, damp = p.damp != null ? p.damp : 0.5;
      const sr = ctx.sampleRate, len = Math.max(1, Math.round(secs * sr));
      const ir = ctx.createBuffer(2, len, sr);
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          lp += (rnd() - lp) * (1 - damp * (0.3 + 0.7 * t));   // darker as it decays
          d[i] = lp * Math.pow(1 - t, 2.2) * Math.exp(-3 * t);
        }
      }
      const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = ir;
      const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain();
      wet.gain.value = mix;
      input.connect(output);
      input.connect(conv).connect(wet).connect(output);
      return { input, output };
    },

    wow(ctx, p) {
      const base = 0.01;
      const delay = ctx.createDelay(0.05); delay.delayTime.value = base;
      const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate || 0.5;
      const depth = ctx.createGain(); depth.gain.value = (p.depth || 0.3) / 1000;
      lfo.connect(depth).connect(delay.delayTime);
      const stops = [lfo];
      if (p.flutterRate) {
        const f = ctx.createOscillator(); f.frequency.value = p.flutterRate;
        const fd = ctx.createGain(); fd.gain.value = (p.flutterDepth || 0.05) / 1000;
        f.connect(fd).connect(delay.delayTime);
        f.start(); stops.push(f);
      }
      lfo.start();
      return { input: delay, output: delay, stop: () => stops.forEach((o) => { try { o.stop(); } catch (e) { /* not started */ } }) };
    },

    noise(ctx, p) {
      const sr = ctx.sampleRate, len = sr * 4;                  // a 4-second loop
      const buf = ctx.createBuffer(2, len, sr);
      let seed = 987654;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        if (p.kind === 'vinyl') {
          let rumble = 0;
          for (let i = 0; i < len; i++) { rumble += (rnd() - rumble) * 0.002; d[i] = rumble * 0.6 + rnd() * 0.02; }
          for (let k = 0; k < 90; k++) {                       // clicks and crackle
            const at = Math.floor(((rnd() + 1) / 2) * (len - 200)), amp = 0.2 + 0.8 * Math.abs(rnd()), w = 2 + Math.floor(Math.abs(rnd()) * 30);
            for (let i = 0; i < w; i++) d[at + i] += amp * rnd() * Math.exp(-i / (w / 3));
          }
        } else if (p.kind === 'hum') {
          for (let i = 0; i < len; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * 50 * t) * 0.7 + Math.sin(2 * Math.PI * 150 * t) * 0.2; }
        } else {                                               // tape hiss: brighter noise
          let prev = 0;
          for (let i = 0; i < len; i++) { const w = rnd(); d[i] = (w - prev * 0.6); prev = w; }
        }
        let pk = 0;
        for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(d[i]));
        for (let i = 0; i < len; i++) d[i] /= pk || 1;
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const lvl = ctx.createGain(); lvl.gain.value = dbToGain(p.level != null ? p.level : -60);
      const io = ctx.createGain();
      src.connect(lvl).connect(io);
      src.start();
      return { input: io, output: io, stop: () => { try { src.stop(); } catch (e) { /* not started */ } } };
    },

    gain(ctx, p) {
      const g = ctx.createGain(); g.gain.value = dbToGain(p.db || 0);
      return { input: g, output: g };
    },

    limiter(ctx, p) {
      const ceil = p.ceiling != null ? p.ceiling : -1;
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = ceil;
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.002; c.release.value = 0.12;
      // the compressor reacts a little late; a soft clipper catches what gets through, so the output stays below 0 dBFS
      const k = dbToGain(ceil), curve = new Float32Array(4096);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 4 - 2, a = Math.abs(x);   // the curve covers -2 … +2
        curve[i] = a <= k ? x : Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
      }
      const clip = ctx.createWaveShaper(); clip.curve = curve;
      const pre = ctx.createGain(); pre.gain.value = 0.5; // the curve's input runs -1 … +1, so ±2 of signal is halved going in
      c.connect(pre).connect(clip);
      return { input: c, output: clip };
    },
  };

  // ---------- the mastering section ----------

  class Mastering {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.input.connect(this.dry).connect(this.output);
      this.wet.connect(this.output);
      this.blocks = [];
      this.preset = null;
      this.set(null, 1, true);
    }

    /** Use a preset (an object from config/mastering.js, or null for off) at an amount 0…1. */
    set(preset, amount = 1, immediate = false) {
      const id = preset ? preset.id : null;
      if (id !== (this.preset && this.preset.id)) this._build(preset);
      this.preset = preset;
      const a = preset ? Math.max(0, Math.min(1, amount)) : 0;
      if (immediate) { this.dry.gain.value = 1 - a; this.wet.gain.value = a; return; } // a new graph (or a render) starts exactly here
      const t = this.ctx.currentTime;
      this.dry.gain.setTargetAtTime(1 - a, t, 0.03);
      this.wet.gain.setTargetAtTime(a, t, 0.03);
    }

    _build(preset) {
      for (const b of this.blocks) { if (b.stop) b.stop(); try { b.output.disconnect(); } catch (e) { /* fine */ } }
      try { this.input.disconnect(); } catch (e) { /* fine */ }
      this.input.connect(this.dry);
      this.blocks = [];
      if (!preset) return;
      const unknown = [];
      for (const step of preset.chain || []) {
        const make = BLOCKS[step.block];
        if (!make) { unknown.push(step.block); continue; }
        this.blocks.push(make(this.ctx, step));
      }
      if (unknown.length) console.warn(`Mastering preset "${preset.name}": unknown block(s) ${unknown.join(', ')} skipped`);
      let at = this.input;
      for (const b of this.blocks) { at.connect(b.input); at = b.output; }
      at.connect(this.wet);
    }
  }

  // ---------- rendered audio: look-ahead limiter and loudness normalisation ----------

  /**
   * Peak limiter for rendered stereo audio (in place): never above `ceiling` dBFS. The gain goes down over
   * `attackMs` before a peak (look-ahead, so nothing is clipped) and comes back up over `releaseMs`.
   * Returns the largest gain reduction in dB.
   */
  function limit(left, right, sampleRate, ceiling = -1, attackMs = 5, releaseMs = 120) {
    const c = dbToGain(ceiling), n = left.length;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      g[i] = a > c ? c / a : 1;
    }
    const up = 1 / Math.max(1, (attackMs / 1000) * sampleRate);    // fastest change per sample going down
    const rel = 1 / Math.max(1, (releaseMs / 1000) * sampleRate);  // and coming back up
    for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + up);  // reach the needed gain before the peak
    let most = 1;
    for (let i = 1; i < n; i++) {
      g[i] = Math.min(g[i], g[i - 1] + rel);
      if (g[i] < most) most = g[i];
    }
    for (let i = 0; i < n; i++) { left[i] *= g[i]; right[i] *= g[i]; }
    return 20 * Math.log10(most);
  }

  /**
   * Bring rendered stereo audio to `target` LUFS (in place), with the limiter keeping peaks at `ceiling`.
   * Returns { before, after, gainDb, limitedDb }.
   */
  function normaliseLoudness(left, right, sampleRate, target, ceiling = -1) {
    const L = root.Loudness;
    const before = L.measure([left, right], sampleRate);
    if (!isFinite(before.lufs)) return { before: before.lufs, after: before.lufs, gainDb: 0, limitedDb: 0 };
    let gainDb = target - before.lufs, limitedDb = 0;
    for (let pass = 0; pass < 2; pass++) {             // limiting lowers the loudness a little: one correction pass
      L.applyGain([left, right], gainDb);
      limitedDb = Math.min(limitedDb, limit(left, right, sampleRate, ceiling));
      const now = L.measure([left, right], sampleRate).lufs;
      gainDb = target - now;
      if (Math.abs(gainDb) < 0.2 || gainDb < 0) break;
    }
    return { before: before.lufs, after: L.measure([left, right], sampleRate).lufs, gainDb: target - before.lufs, limitedDb };
  }

  root.Master = { Mastering, BLOCKS, limit, normaliseLoudness };
})(typeof self !== 'undefined' ? self : this);
