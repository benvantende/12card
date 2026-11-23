/*
 * flac.js — a small, self-contained FLAC encoder for exported mixes (browsers can't write FLAC themselves).
 *
 * Lossless by construction: every block is written so that decoding gives back exactly the input samples
 * (checked against ffmpeg in tests/flac.test.js, including the MD5 in STREAMINFO).
 * - blocks of 4096 samples; per block the smallest of: independent, left/side, right/side and mid/side stereo
 * - per channel the best FIXED predictor (order 0–4), or CONSTANT (silence), or VERBATIM if nothing helps
 * - Rice-coded residuals with partitioned parameters (partition order 0–6)
 * - metadata: STREAMINFO (with MD5), VORBIS_COMMENT (title, artist, …) and PICTURE (front cover)
 */
(function (root) {
  'use strict';

  const BLOCK = 4096;

  // ---------- bit writer ----------
  class BitWriter {
    constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.nb = 0; }
    _grow(n) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 1024)); b.set(this.buf.subarray(0, this.pos)); this.buf = b; } }
    /** Write the low `bits` bits of an unsigned value (bits ≤ 32). */
    write(val, bits) {
      if (bits === 0) return;
      if (bits > 24) { this.write(Math.floor(val / 0x10000) & ((1 << (bits - 16)) - 1), bits - 16); this.write(val & 0xffff, 16); return; }
      this.acc = (this.acc << bits) | (val & ((1 << bits) - 1)); // acc has < 8 bits pending, so ≤ 31 bits here
      this.nb += bits;
      this._grow(4);
      while (this.nb >= 8) { this.nb -= 8; this.buf[this.pos++] = (this.acc >>> this.nb) & 0xff; }
      this.acc &= (1 << this.nb) - 1;
    }
    signed(v, bits) { this.write(v < 0 ? v + 2 ** bits : v, bits); }
    zeros(n) { while (n > 16) { this.write(0, 16); n -= 16; } this.write(0, n); }
    /** Rice code of an unsigned value with parameter k. */
    rice(u, k) {
      const q = Math.floor(u / 2 ** k);
      this.zeros(q);
      this.write(1, 1);
      if (k) this.write(k > 24 ? u % 2 ** k : u & ((1 << k) - 1), k);
    }
    align() { if (this.nb) this.write(0, 8 - this.nb); }
    bytes(from = 0) { return this.buf.subarray(from, this.pos); }
  }

  // ---------- checksums ----------
  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 0x80 ? (c << 1) ^ 0x07 : c << 1) & 0xff; CRC8[i] = c;
    let d = i << 8; for (let j = 0; j < 8; j++) d = (d & 0x8000 ? (d << 1) ^ 0x8005 : d << 1) & 0xffff; CRC16[i] = d;
  }
  const crc8 = (b) => { let c = 0; for (let i = 0; i < b.length; i++) c = CRC8[c ^ b[i]]; return c; };
  const crc16 = (b) => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ b[i]]) & 0xffff; return c; };

  /** Streaming MD5 (RFC 1321), for STREAMINFO. */
  class MD5 {
    constructor() { this.h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]); this.buf = new Uint8Array(64); this.n = 0; this.len = 0; }
    update(data) {
      let i = 0;
      this.len += data.length;
      if (this.n) { // fill a partial block first
        while (i < data.length && this.n < 64) this.buf[this.n++] = data[i++];
        if (this.n === 64) { this._block(this.buf); this.n = 0; }
      }
      for (; i + 64 <= data.length; i += 64) this._block(data.subarray(i, i + 64)); // whole blocks straight from the data
      while (i < data.length) this.buf[this.n++] = data[i++];
    }
    _block(b) {
      const X = this.X || (this.X = new Int32Array(16));
      for (let i = 0; i < 16; i++) X[i] = b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24);
      let [a, bb, c, d] = this.h;
      const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
        else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (bb | ~d); g = (7 * i) % 16; }
        const s = S[(i >> 4) * 4 + (i % 4)];
        const t = (a + f + MD5.K[i] + X[g]) | 0;
        a = d; d = c; c = bb; bb = (bb + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      this.h[0] += a; this.h[1] += bb; this.h[2] += c; this.h[3] += d;
    }
    digest() {
      const bits = this.len * 8;
      this.update(new Uint8Array([0x80]));
      while (this.n !== 56) this.update(new Uint8Array([0])); // (len keeps counting, but bits was taken before)
      const L = new Uint8Array(8);
      for (let i = 0; i < 8; i++) L[i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
      this.update(L);
      const out = new Uint8Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = (this.h[i] >>> (8 * j)) & 0xff;
      return out;
    }
  }
  MD5.K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

  // ---------- prediction and residual coding ----------
  const PRED = [
    (x, i) => x[i],
    (x, i) => x[i] - x[i - 1],
    (x, i) => x[i] - 2 * x[i - 1] + x[i - 2],
    (x, i) => x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3],
    (x, i) => x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4],
  ];

  /** Residuals of a FIXED predictor as zigzag (unsigned) values. */
  function residuals(x, order) {
    const n = x.length, u = new Float64Array(n - order), p = PRED[order];
    for (let i = order; i < n; i++) { const r = p(x, i); u[i - order] = r >= 0 ? 2 * r : -2 * r - 1; }
    return u;
  }

  /** Best partition order and Rice parameters for these residuals; returns { bits, po, ks }. */
  function planRice(u, n, order, maxK) {
    let best = null;
    for (let po = 0; po <= 6; po++) {
      const parts = 1 << po;
      if (n % parts || (n >> po) <= order) break;
      const ks = [];
      let bits = 0, at = 0;
      for (let p = 0; p < parts; p++) {
        const cnt = (n >> po) - (p === 0 ? order : 0);
        let sum = 0; for (let i = 0; i < cnt; i++) sum += u[at + i];
        at += cnt;
        let bk = 0, bb = Infinity;
        for (let k = 0; k <= maxK; k++) {
          const b = cnt * (k + 1) + Math.floor(sum / 2 ** k); // ≈ size of the Rice codes
          if (b < bb) { bb = b; bk = k; } else if (k > 0 && b > bb) break;
        }
        ks.push(bk);
        bits += bb + (maxK > 14 ? 5 : 4);
      }
      if (!best || bits < best.bits) best = { bits, po, ks };
    }
    return best;
  }

  /**
   * Quick estimate: the sum of |residual| for each FIXED order (0–4), in one pass and without allocating.
   * Returns { order, sum } for the smallest (like libFLAC, the warm-up samples are left out of the sums).
   */
  function bestOrder(x) {
    const n = x.length;
    if (n < 5) return { order: 0, sum: x.reduce((a, v) => a + Math.abs(v), 0) };
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 4; i < n; i++) {
      const a = x[i], b = x[i - 1], c = x[i - 2], d = x[i - 3], e = x[i - 4];
      s0 += Math.abs(a); s1 += Math.abs(a - b); s2 += Math.abs(a - 2 * b + c);
      s3 += Math.abs(a - 3 * b + 3 * c - d); s4 += Math.abs(a - 4 * b + 6 * c - 4 * d + e);
    }
    const sums = [s0, s1, s2, s3, s4];
    let order = 0;
    for (let k = 1; k < 5; k++) if (sums[k] < sums[order]) order = k;
    return { order, sum: sums[order] };
  }

  /** The cheapest way to code one channel of one block; returns a plan with its size in bits. */
  function planChannel(x, bps, order = bestOrder(x).order) {
    let allSame = true;
    for (let i = 1; i < x.length && allSame; i++) if (x[i] !== x[0]) allSame = false;
    if (allSame) return { type: 'const', bits: 8 + bps };
    const verbatim = { type: 'verbatim', bits: 8 + bps * x.length };
    if (order >= x.length) return verbatim;
    const maxK = bps > 16 ? 30 : 14;
    const u = residuals(x, order);
    const r = planRice(u, x.length, order, maxK);
    if (!r) return verbatim;
    const kmax = Math.max(...r.ks);
    if (kmax > 30) return verbatim;
    const bits = 8 + order * bps + 6 + r.bits;
    return bits < verbatim.bits ? { type: 'fixed', order, u, rice: r, method: kmax > 14 ? 1 : 0, bits } : verbatim;
  }

  function writeSubframe(w, x, bps, plan) {
    w.write(0, 1); // padding bit
    if (plan.type === 'const') { w.write(0, 6); w.write(0, 1); w.signed(x[0], bps); return; }
    if (plan.type === 'verbatim') { w.write(1, 6); w.write(0, 1); for (let i = 0; i < x.length; i++) w.signed(x[i], bps); return; }
    w.write(8 | plan.order, 6); w.write(0, 1);
    for (let i = 0; i < plan.order; i++) w.signed(x[i], bps);
    const { po, ks } = plan.rice;
    w.write(plan.method, 2); w.write(po, 4);
    const kbits = plan.method ? 5 : 4;
    let at = 0;
    for (let p = 0; p < ks.length; p++) {
      const cnt = (x.length >> po) - (p === 0 ? plan.order : 0), k = ks[p];
      w.write(k, kbits);
      for (let i = 0; i < cnt; i++) w.rice(plan.u[at + i], k);
      at += cnt;
    }
  }

  /** The frame number, coded like UTF-8 (1 to 6 bytes). */
  function utf8Number(w, v) {
    if (v < 0x80) { w.write(v, 8); return; }
    const n = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
    const cont = [];
    let rest = v;
    for (let i = 1; i < n; i++) { cont.unshift(0x80 | (rest & 0x3f)); rest = Math.floor(rest / 64); }
    w.write(((0xff00 >> n) & 0xff) | rest, 8); // n leading ones, a zero, then the top bits
    for (const b of cont) w.write(b, 8);
  }

  // ---------- metadata ----------
  const enc = (s) => new TextEncoder().encode(s);
  function le32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function be32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  function block(type, body, last) { return cat([new Uint8Array([(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body]); }

  function vorbisComment(tags, vendor) {
    // DATE: tags.date (the full recording date, 2025-10-17) when given, else the year
    const map = { title: 'TITLE', artist: 'ARTIST', genre: 'GENRE', [tags && tags.date ? 'date' : 'year']: 'DATE', bpm: 'BPM', description: 'DESCRIPTION', comment: 'COMMENT' };
    const list = [];
    for (const [k, key] of Object.entries(map)) {
      let v = tags && tags[k] != null ? String(tags[k]).trim() : '';
      if (k === 'bpm' && v) v = String(Math.round(parseFloat(v)));
      if (v) list.push(enc(`${key}=${v}`));
    }
    list.push(enc(`ENCODER=${vendor}`));
    return cat([le32(enc(vendor).length), enc(vendor), le32(list.length), ...list.flatMap((c) => [le32(c.length), c])]);
  }

  /** Width and height of a JPEG or PNG (0 if unknown). */
  function imageSize(b) {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return { w: 0, h: 0 };
  }

  function picture(cover) {
    const mime = enc(cover.mime || 'image/jpeg'), { w, h } = imageSize(cover.bytes);
    return cat([be32(3), be32(mime.length), mime, be32(0), be32(w), be32(h), be32(24), be32(0), be32(cover.bytes.length), cover.bytes]);
  }

  // ---------- encoder ----------
  const RATE_CODE = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
  const SIZE_CODE = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

  /**
   * Encode whole-number samples (Int32Array per channel, 1 or 2 channels) to a FLAC file.
   * tags: { title, artist, genre, year, bpm, comment }, cover: { bytes, mime }. Returns a Uint8Array.
   */
  async function encode({ channels, sampleRate, bitsPerSample, tags = null, cover = null, vendor = '12card', onProgress = () => {} }) {
    const nch = channels.length, total = channels[0].length, bps = bitsPerSample;
    if (nch < 1 || nch > 2) throw new Error('FLAC export supports mono and stereo.');
    if (!SIZE_CODE[bps]) throw new Error(`FLAC export doesn't support ${bps}-bit.`);
    const out = new BitWriter(Math.max(1 << 16, Math.ceil(total * nch * bps / 8 * 0.7)));
    const md5 = new MD5();
    let minFrame = Infinity, maxFrame = 0, frame = 0;
    const B = bps / 8, raw = new Uint8Array(BLOCK * nch * B);
    for (let start = 0; start < total; start += BLOCK, frame++) {
      const n = Math.min(BLOCK, total - start);
      const ch = channels.map((c) => c.subarray(start, start + n));
      // MD5 of the samples as little-endian signed integers, interleaved
      let o = 0;
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { const v = ch[c][i]; raw[o++] = v & 255; raw[o++] = (v >> 8) & 255; if (B === 3) raw[o++] = (v >> 16) & 255; }
      md5.update(raw.subarray(0, o));
      // choose the stereo coding
      let assign = nch - 1, subs;
      if (nch === 1) subs = [[ch[0], bps]];
      else {
        const L = ch[0], R = ch[1], S = new Int32Array(n), Mi = new Int32Array(n);
        for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; Mi[i] = (L[i] + R[i]) >> 1; }
        // choose the stereo mode on the quick estimates, then plan only the two channels that are used
        const eL = bestOrder(L), eR = bestOrder(R), eS = bestOrder(S), eM = bestOrder(Mi);
        const opts = [
          { a: 1, subs: [[L, bps, eL], [R, bps, eR]], est: eL.sum + eR.sum },
          { a: 8, subs: [[L, bps, eL], [S, bps + 1, eS]], est: eL.sum + eS.sum },
          { a: 9, subs: [[S, bps + 1, eS], [R, bps, eR]], est: eS.sum + eR.sum },
          { a: 10, subs: [[Mi, bps, eM], [S, bps + 1, eS]], est: eM.sum + eS.sum },
        ];
        const best = opts.reduce((a, b) => (b.est < a.est ? b : a));
        best.subs = best.subs.map(([x, b, e]) => [x, b, planChannel(x, b, e.order)]);
        assign = best.a; subs = best.subs;
      }
      // frame header
      const at = out.pos;
      out.write(0xfff8, 16);
      out.write(n === BLOCK ? 12 : 7, 4);
      out.write(RATE_CODE[sampleRate] || 0, 4);
      out.write(assign, 4); out.write(SIZE_CODE[bps], 3); out.write(0, 1);
      utf8Number(out, frame);
      if (n !== BLOCK) out.write(n - 1, 16);
      out.write(crc8(out.bytes(at)), 8);
      for (const [x, b, plan] of subs) writeSubframe(out, x, b, plan || planChannel(x, b));
      out.align();
      out.write(crc16(out.bytes(at)), 16);
      const size = out.pos - at;
      if (size < minFrame) minFrame = size; if (size > maxFrame) maxFrame = size;
      if (frame % 64 === 0) { onProgress(start / total); await new Promise((r) => setTimeout(r, 0)); }
    }
    onProgress(1);
    // STREAMINFO
    const si = new BitWriter(34);
    const bs = BLOCK; // like libFLAC: the configured block size (the last block may be shorter)
    si.write(bs, 16); si.write(bs, 16);
    si.write(minFrame === Infinity ? 0 : minFrame, 24); si.write(maxFrame, 24);
    si.write(sampleRate, 20); si.write(nch - 1, 3); si.write(bps - 1, 5);
    si.write(Math.floor(total / 2 ** 32), 4); si.write(total >>> 0, 32);
    const streaminfo = cat([si.bytes(), md5.digest()]);
    const blocks = [block(0, streaminfo, false), block(4, vorbisComment(tags, vendor), !(cover && cover.bytes && cover.bytes.length))];
    if (cover && cover.bytes && cover.bytes.length) blocks.push(block(6, picture(cover), true));
    return cat([enc('fLaC'), ...blocks, out.bytes()]);
  }

  root.FLAC = { encode, _test: { MD5, crc8, crc16, imageSize } };
})(typeof self !== 'undefined' ? self : this);
