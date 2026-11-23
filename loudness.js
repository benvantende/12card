/*
 * loudness.js — loudness and peak measurement (ITU-R BS.1770-4 / EBU R128), and a gain plan for normalising.
 *
 * Integrated loudness in LUFS: K-weighting (high shelf + high pass), 400 ms blocks with 75% overlap,
 * an absolute gate at -70 LUFS and a relative gate 10 LU below the ungated level.
 * The filter coefficients are derived for any sample rate (the same design as libebur128).
 * No browser APIs here, so it can also be tested with Node.
 */
(function (root) {
  'use strict';

  /** K-weighting biquads for a sample rate: [{ b: [b0, b1, b2], a: [1, a1, a2] }, …]. */
  function kWeighting(fs) {
    // stage 1: high shelf (+4 dB above ~1.7 kHz, the head's effect)
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    };
    // stage 2: high pass (RLB weighting, ~38 Hz)
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    const hp = { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    return [shelf, hp];
  }

  function filter(x, { b, a }) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const o = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o;
      y[i] = o;
    }
    return y;
  }

  const toLufs = (ms) => -0.691 + 10 * Math.log10(ms);

  /**
   * Measure channels (array of Float32Array, same length) at sampleRate.
   * Returns { lufs (integrated, -Infinity for silence or < 400 ms), peak (linear sample peak), peakDb }.
   * Every channel counts with weight 1 (L, R or mono), as BS.1770 says for these.
   */
  function measure(channels, sampleRate) {
    let peak = 0;
    for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
    const [st1, st2] = kWeighting(sampleRate);
    const weighted = channels.map((ch) => filter(filter(ch, st1), st2));
    const n = channels[0] ? channels[0].length : 0;
    const block = Math.round(0.4 * sampleRate), hop = Math.round(0.1 * sampleRate);
    const powers = [];
    if (n >= block) {
      // running sums of squares per 100 ms step, so each 400 ms block is 4 steps
      const steps = Math.floor(n / hop);
      const stepSum = new Float64Array(steps);
      for (const w of weighted) {
        for (let s = 0; s < steps; s++) {
          let acc = 0;
          for (let i = s * hop, e = i + hop; i < e; i++) acc += w[i] * w[i];
          stepSum[s] += acc;
        }
      }
      for (let s = 0; s + 4 <= steps; s++) powers.push((stepSum[s] + stepSum[s + 1] + stepSum[s + 2] + stepSum[s + 3]) / (4 * hop));
    }
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const abs = powers.filter((p) => p > 0 && toLufs(p) > -70);
    if (!abs.length) return { lufs: -Infinity, peak, peakDb };
    const mean = (a) => a.reduce((t, v) => t + v, 0) / a.length;
    const rel = toLufs(mean(abs)) - 10;
    const gated = abs.filter((p) => toLufs(p) > rel);
    return { lufs: toLufs(mean(gated.length ? gated : abs)), peak, peakDb };
  }

  /**
   * Gain (dB) that brings a measured signal to `target` LUFS without its peak going above `ceiling` dBFS.
   * Returns { gainDb, limitedByPeak }.
   */
  function normaliseGain(m, target, ceiling = -1) {
    if (!isFinite(m.lufs)) return { gainDb: 0, limitedByPeak: false };
    let gainDb = target - m.lufs;
    let limitedByPeak = false;
    if (isFinite(m.peakDb) && m.peakDb + gainDb > ceiling) { gainDb = ceiling - m.peakDb; limitedByPeak = true; }
    return { gainDb, limitedByPeak };
  }

  /** Multiply channels in place by a gain in dB. */
  function applyGain(channels, gainDb) {
    const g = Math.pow(10, gainDb / 20);
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }

  const api = { kWeighting, measure, normaliseGain, applyGain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Loudness = api;
})(typeof self !== 'undefined' ? self : this);
