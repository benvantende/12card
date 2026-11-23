/*
 * fx.js — the preview effect, modelled on the Model 12's built-in effect (AUX2/FX send).
 *
 * The same 16 types as the unit, each with one PARAMETER. These are approximations built
 * from Web Audio nodes, meant to hear roughly what a type does before dialling it in on the
 * unit — not a copy of TASCAM's algorithms.
 *
 * Delay times follow the song's tempo (read from song.sys) as note values.
 */
(function (root) {
  'use strict';

  // reverb character: length (s), pre-delay (s), damping (0 bright … 1 dark), early reflections (0…1)
  const REV = {
    HALL1: { len: 2.4, pre: 0.020, damp: 0.35, er: 0.25 },
    HALL2: { len: 3.6, pre: 0.035, damp: 0.55, er: 0.15 },
    ROOM1: { len: 0.7, pre: 0.006, damp: 0.40, er: 0.55 },
    ROOM2: { len: 1.2, pre: 0.010, damp: 0.20, er: 0.45 },
    PLATE: { len: 1.8, pre: 0.000, damp: 0.05, er: 0.00 },
    STUDIO: { len: 0.5, pre: 0.004, damp: 0.30, er: 0.65 },
    LIVE: { len: 1.6, pre: 0.015, damp: 0.30, er: 0.75 },
  };

  const NOTES = [
    { label: '1/16', beats: 0.25 }, { label: '1/8', beats: 0.5 }, { label: '1/8.', beats: 0.75 },
    { label: '1/4', beats: 1 }, { label: '1/4.', beats: 1.5 }, { label: '1/2', beats: 2 },
  ];

  // kind: rev | delay | pingpong | chorus | flanger | delayrev | chorusrev
  const TYPES = [
    { id: 'HALL1', name: 'Hall 1', kind: 'rev', rev: 'HALL1' },
    { id: 'HALL2', name: 'Hall 2', kind: 'rev', rev: 'HALL2' },
    { id: 'ROOM1', name: 'Room 1', kind: 'rev', rev: 'ROOM1' },
    { id: 'ROOM2', name: 'Room 2', kind: 'rev', rev: 'ROOM2' },
    { id: 'PLATE', name: 'Plate', kind: 'rev', rev: 'PLATE' },
    { id: 'STUDIO', name: 'Studio', kind: 'rev', rev: 'STUDIO' },
    { id: 'LIVE', name: 'Live', kind: 'rev', rev: 'LIVE' },
    { id: 'DELAY1', name: 'Delay 1', kind: 'delay', feedback: 0.3 },
    { id: 'DELAY2', name: 'Delay 2', kind: 'delay', feedback: 0.55 },
    { id: 'PINGPONG', name: 'Ping Pong', kind: 'pingpong', feedback: 0.45 },
    { id: 'CHORUS', name: 'Chorus', kind: 'chorus' },
    { id: 'FLANGER', name: 'Flanger', kind: 'flanger' },
    { id: 'DELAY_HALL1', name: 'Delay + Hall 1', kind: 'delayrev', rev: 'HALL1', feedback: 0.3 },
    { id: 'DELAY_HALL2', name: 'Delay + Hall 2', kind: 'delayrev', rev: 'HALL2', feedback: 0.3 },
    { id: 'CHORUS_HALL1', name: 'Chorus + Hall 1', kind: 'chorusrev', rev: 'HALL1' },
    { id: 'CHORUS_HALL2', name: 'Chorus + Hall 2', kind: 'chorusrev', rev: 'HALL2' },
  ];
  const byId = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

  /** What the single PARAMETER means for a type: label, default (0…1), steps (0 = continuous), and a formatter. */
  function paramInfo(id, tempo) {
    const t = byId(id);
    if (t.kind === 'rev') return { label: 'DECAY', def: 0.5, steps: 0, show: (v) => decaySeconds(t, v).toFixed(1) + ' s' };
    if (t.kind === 'delay' || t.kind === 'pingpong' || t.kind === 'delayrev') {
      return { label: 'TIME', def: 0.6, steps: NOTES.length - 1, show: (v) => { const n = noteFor(v); return `${n.label} · ${Math.round(1000 * delaySeconds(v, tempo))} ms`; } };
    }
    return { label: 'RATE', def: 0.35, steps: 0, show: (v) => rateHz(t, v).toFixed(2) + ' Hz' };
  }
  const decaySeconds = (t, v) => REV[t.rev].len * (0.4 + 1.2 * v);   // v=0.5 → the type's own length
  const noteFor = (v) => NOTES[Math.round(Math.max(0, Math.min(1, v)) * (NOTES.length - 1))];
  const delaySeconds = (v, tempo) => Math.min(3.5, (60 / (tempo || 120)) * noteFor(v).beats);
  const rateHz = (t, v) => (t.kind === 'flanger' ? 0.05 * Math.pow(40, v) : 0.1 * Math.pow(50, v)); // flanger 0.05–2 Hz, chorus 0.1–5 Hz

  // ---------- building blocks ----------

  function makeIR(ctx, r, seconds) {
    const sr = ctx.sampleRate;
    const pre = Math.round(r.pre * sr);
    const len = Math.max(1, Math.round(seconds * sr));
    const buf = ctx.createBuffer(2, pre + len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0, energy = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.exp(-6.9 * t);                       // -60 dB at the end
        const a = Math.max(0.03, 1 - r.damp * (0.4 + 0.6 * t)); // darker as it decays
        y += a * ((Math.random() * 2 - 1) - y);
        d[pre + i] = y * env;
      }
      // early reflections: a few distinct taps in the first 80 ms
      for (let k = 0; k < 9; k++) {
        const at = pre + Math.round((0.004 + Math.random() * 0.076) * sr);
        if (at < d.length) d[at] += (Math.random() < 0.5 ? -1 : 1) * r.er * (0.9 - k * 0.08);
      }
      for (let i = 0; i < d.length; i++) energy += d[i] * d[i];
      const norm = 0.85 / Math.sqrt(energy || 1);             // similar loudness for every type and decay
      for (let i = 0; i < d.length; i++) d[i] *= norm;
    }
    return buf;
  }

  function reverb(ctx, revKey) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    let timer = null, lastV = null;
    const t = { rev: revKey };
    return {
      input: conv, output: conv,
      setParam(v, immediate) {
        if (v === lastV) return;
        lastV = v;
        clearTimeout(timer);
        const build = () => { conv.buffer = makeIR(ctx, REV[revKey], decaySeconds(t, v)); };
        if (immediate || !conv.buffer) build(); else timer = setTimeout(build, 120); // don't rebuild on every drag step
      },
      dispose() { clearTimeout(timer); conv.disconnect(); },
    };
  }

  function delay(ctx, feedback, tempoRef) {
    const input = ctx.createGain();
    const d = ctx.createDelay(4);
    const fb = ctx.createGain(); fb.gain.value = feedback;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 4500;
    const output = ctx.createGain();
    input.connect(d); d.connect(output); d.connect(tone).connect(fb).connect(d);
    return {
      input, output,
      setParam(v) { d.delayTime.setTargetAtTime(delaySeconds(v, tempoRef.tempo), ctx.currentTime, 0.02); },
      dispose() { [input, d, fb, tone, output].forEach((n) => n.disconnect()); },
    };
  }

  function pingpong(ctx, feedback, tempoRef) {
    const input = ctx.createGain();
    input.channelCount = 1; input.channelCountMode = 'explicit'; // mono into the left side
    const dl = ctx.createDelay(4), dr = ctx.createDelay(4);
    const fl = ctx.createGain(), fr = ctx.createGain(); fl.gain.value = 1; fr.gain.value = feedback;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5000;
    const merge = ctx.createChannelMerger(2);
    input.connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    dl.connect(fl).connect(dr);           // left echo feeds the right
    dr.connect(tone).connect(fr).connect(dl); // right echo feeds back to the left
    return {
      input, output: merge,
      setParam(v) { const s = delaySeconds(v, tempoRef.tempo); dl.delayTime.setTargetAtTime(s, ctx.currentTime, 0.02); dr.delayTime.setTargetAtTime(s, ctx.currentTime, 0.02); },
      dispose() { [input, dl, dr, fl, fr, tone, merge].forEach((n) => n.disconnect()); },
    };
  }

  function modulated(ctx, isFlanger) {
    const t = { kind: isFlanger ? 'flanger' : 'chorus' };
    const input = ctx.createGain();
    const merge = ctx.createChannelMerger(2);
    const base = isFlanger ? 0.003 : 0.018, depth = isFlanger ? 0.0025 : 0.004;
    const nodes = [input, merge];
    const lfos = [];
    for (let ch = 0; ch < 2; ch++) {
      const d = ctx.createDelay(0.1); d.delayTime.value = base;
      const lfo = ctx.createOscillator(); lfo.type = 'sine';
      const amt = ctx.createGain(); amt.gain.value = ch ? -depth : depth; // opposite phase left/right = width
      lfo.connect(amt).connect(d.delayTime);
      lfo.start();
      input.connect(d);
      d.connect(merge, 0, ch);
      if (isFlanger) { const fb = ctx.createGain(); fb.gain.value = 0.6; d.connect(fb).connect(d); nodes.push(fb); }
      lfos.push(lfo); nodes.push(d, amt);
    }
    // a little dry signal so the sweep is audible as chorus/flange rather than just vibrato
    const dry = ctx.createGain(); dry.gain.value = 0.7; input.connect(dry); dry.connect(merge, 0, 0); dry.connect(merge, 0, 1); nodes.push(dry);
    return {
      input, output: merge,
      setParam(v) { for (const l of lfos) l.frequency.setTargetAtTime(rateHz(t, v), ctx.currentTime, 0.05); },
      dispose() { lfos.forEach((l) => { try { l.stop(); } catch (e) { /* stopped */ } l.disconnect(); }); nodes.forEach((n) => n.disconnect()); },
    };
  }

  /** first → reverb, with the first effect also heard directly (like the unit's combo types). */
  function chain(ctx, first, revKey) {
    const rev = reverb(ctx, revKey);
    rev.setParam(0.5, true);
    const output = ctx.createGain();
    const direct = ctx.createGain(); direct.gain.value = 0.7;
    first.output.connect(rev.input); rev.output.connect(output);
    first.output.connect(direct).connect(output);
    return {
      input: first.input, output,
      setParam(v) { first.setParam(v); },
      dispose() { first.dispose(); rev.dispose(); direct.disconnect(); output.disconnect(); },
    };
  }

  function build(ctx, id, tempoRef) {
    const t = byId(id);
    switch (t.kind) {
      case 'rev': return reverb(ctx, t.rev);
      case 'delay': return delay(ctx, t.feedback, tempoRef);
      case 'pingpong': return pingpong(ctx, t.feedback, tempoRef);
      case 'chorus': return modulated(ctx, false);
      case 'flanger': return modulated(ctx, true);
      case 'delayrev': return chain(ctx, delay(ctx, t.feedback, tempoRef), t.rev);
      case 'chorusrev': return chain(ctx, modulated(ctx, false), t.rev);
    }
    throw new Error('Unknown effect ' + id);
  }

  /**
   * The FX bus: channel sends → effect (100% wet) → FX return (fader + mute) → destination.
   */
  class Engine {
    constructor(ctx, destination, settings) {
      this.ctx = ctx;
      this.input = ctx.createGain();      // channel sends connect here
      this.ret = ctx.createGain();        // FX return fader
      this.mute = ctx.createGain();
      this.ret.connect(this.mute).connect(destination);
      this.tempoRef = { tempo: 120 };
      this.s = {};
      this.apply(settings);
    }

    apply(s) {
      const prev = this.s;
      this.s = Object.assign({}, s);
      this.tempoRef.tempo = s.tempo || 120;
      if (!this.effect || prev.type !== s.type) {
        if (this.effect) { this.input.disconnect(); this.effect.output.disconnect(); this.effect.dispose(); }
        this.effect = build(this.ctx, s.type, this.tempoRef);
        this.input.connect(this.effect.input);
        this.effect.output.connect(this.ret);
        this.effect.setParam(s.param, true);
      } else if (prev.param !== s.param || prev.tempo !== s.tempo) {
        this.effect.setParam(s.param);
      }
      const t = this.ctx.currentTime;
      this.ret.gain.setTargetAtTime(s.ret <= 0 ? 0 : Math.pow(s.ret / 0.75, 2), t, 0.02);
      this.mute.gain.setTargetAtTime(s.mute ? 0 : 1, t, 0.01);
    }
  }

  root.FX = { TYPES, NOTES, paramInfo, Engine, byId, delaySeconds };
})(self);
