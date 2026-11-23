// Run: node tests/loudness.test.js
// Loudness meter against known values, the import normalise plan, and the export limiter / loudness normalisation.
const assert = require('assert');
const L = require('../loudness.js');
global.self = global; global.Loudness = L;
require('../master.js');
const Mst = global.Master;
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log('PASS', m); };

// EBU Tech 3341: a 1 kHz sine at -23 dBFS peak on both channels reads -23 LUFS, so -20 dBFS reads -20; one channel 3 dB less
const sr = 48000, len = sr * 10;
const sine = (amp, f = 997) => Float32Array.from({ length: len }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
let m = L.measure([sine(0.1), sine(0.1)], sr);
ok(Math.abs(m.lufs - (-20.0)) < 0.1, `stereo 997 Hz at -20 dBFS = ${m.lufs.toFixed(2)} LUFS (expected -20.0)`);
m = L.measure([sine(0.1)], sr);
ok(Math.abs(m.lufs - (-23.0)) < 0.1, `mono 997 Hz at -20 dBFS = ${m.lufs.toFixed(2)} LUFS (expected -23.0)`);
ok(Math.abs(m.peakDb - (-20)) < 0.01, `sample peak ${m.peakDb.toFixed(2)} dBFS`);
ok(L.measure([new Float32Array(len)], sr).lufs === -Infinity, 'silence: -inf LUFS');
// 44.1 kHz too (coefficients are derived per rate)
const s44 = Float32Array.from({ length: 441000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 997 * i / 44100));
ok(Math.abs(L.measure([s44, s44], 44100).lufs - (-20.0)) < 0.1, '44.1 kHz gives the same loudness');

// import plan: a loud file goes down to the target; a quiet one goes up but stops at the peak ceiling
let g = L.normaliseGain({ lufs: -8, peakDb: -0.1 }, -23, -3);
ok(Math.abs(g.gainDb + 15) < 1e-9 && !g.limitedByPeak, 'loud file: -15 dB to reach -23 LUFS');
g = L.normaliseGain({ lufs: -35, peakDb: -6 }, -23, -3);
ok(Math.abs(g.gainDb - 3) < 1e-9 && g.limitedByPeak, 'quiet file with high peaks: only +3 dB (peak ceiling)');

// limiter: never above the ceiling, quiet parts untouched
const a = sine(0.1), b = sine(0.1);
for (let i = sr * 5; i < sr * 5 + 2000; i++) { a[i] *= 15; b[i] *= 15; }   // a 1.5 (over full scale) burst
const red = Mst.limit(a, b, sr, -1);
let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(a[i]), Math.abs(b[i]));
ok(20 * Math.log10(pk) <= -1 + 1e-4, `limiter keeps peaks at -1 dBFS (peak ${(20 * Math.log10(pk)).toFixed(3)}, reduction ${red.toFixed(1)} dB)`);
ok(Math.abs(a[sr] - sine(0.1)[sr]) < 1e-7, 'limiter leaves audio far from the burst unchanged');

// loudness normalisation to -14 LUFS with a -1 dBFS ceiling
const c = sine(0.05), d = sine(0.05);
const r = Mst.normaliseLoudness(c, d, sr, -14, -1);
pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(c[i]), Math.abs(d[i]));
ok(Math.abs(r.after - (-14)) < 0.5 && 20 * Math.log10(pk) <= -1 + 1e-4, `normalised: ${r.before.toFixed(1)} → ${r.after.toFixed(1)} LUFS, peak ${(20 * Math.log10(pk)).toFixed(2)} dBFS`);
console.log(`all ${n} checks passed`);
