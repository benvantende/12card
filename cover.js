/*
 * cover.js — artwork for downloaded mixes, drawn in the browser for each song.
 * The app logo (three console faders, the third one red) with the faders set to the song's own levels:
 * tracks 1–6, tracks 7–10 and the main mix on 11/12. Title, artist and year go underneath.
 * A cover.jpg in the root of the card overrides this (handled in app.js).
 */
(function (root) {
  'use strict';
  const M = root.Model12;
  const S = 1400; // the size music apps prefer
  const C = {
    bg: '#15171a', panel: '#24282d', slot: '#08090a', tick: '#3a3f46',
    greyTop: '#e4e6e9', greyBot: '#787d84', redTop: '#f07868', redBot: '#962014', capLine: '#fafafa',
    text: '#f2f3f5', muted: '#9aa1a9', faint: '#6b7178',
  };
  const FONT = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const GROUPS = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9], [10, 11]]; // track indexes: 1–6, 7–10, 11/12

  // ---------- levels ----------

  const levelCache = new Map();

  /**
   * How loud each group of tracks is, as fader positions 0 … 1.
   * Per group: the energy of its tracks in half-second blocks, then the 90th-percentile block
   * (the loud part of the song, not the average with the quiet intro). -48 dBFS = bottom, -6 dBFS = top.
   * A group with no recorded tracks sits at the bottom.
   */
  async function songLevels(song) {
    const key = `${song.folder}|${song.totalBytes}`;
    if (levelCache.has(key)) return levelCache.get(key);
    const out = [];
    for (const g of GROUPS) {
      const used = g.filter((i) => song.tracks[i] && !song.tracks[i].empty);
      if (!used.length) { out.push(0); continue; }
      let blocks = null;
      for (const i of used) {
        const b = new Uint8Array(await (await song.tracks[i].entry.getFile()).arrayBuffer());
        const h = M.parseWavHeader(b.subarray(0, 65536), b.length);
        const bps = h.bitsPerSample / 8, dv = new DataView(b.buffer, b.byteOffset + h.dataOffset);
        const per = Math.round(h.sampleRate / 2), n = Math.floor(h.frames / per);
        if (!blocks) blocks = new Float64Array(n);
        for (let k = 0; k < Math.min(n, blocks.length); k++) {
          let e = 0;
          for (let j = 0, o = k * per * bps; j < per; j += 4, o += 4 * bps) { // every 4th sample is plenty for a level
            const v = bps === 2 ? dv.getInt16(o, true) / 32768 : ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608);
            e += v * v;
          }
          blocks[k] += e / (per / 4);
        }
      }
      const db = [...(blocks || [])].map((e) => 10 * Math.log10(e + 1e-12)).filter((v) => v > -80).sort((a, b) => a - b);
      const loud = db.length ? db[Math.min(db.length - 1, Math.floor(db.length * 0.9))] : -120;
      out.push(Math.max(0.04, Math.min(1, (loud + 48) / 42)));
    }
    levelCache.set(key, out);
    return out;
  }

  // ---------- drawing ----------

  function rounded(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /** Largest font size (from max down to min) at which the text fits; returns { size, lines }. Wraps to two lines if needed. */
  function fit(ctx, text, weight, maxW, max, min) {
    for (let size = max; size >= min; size -= 2) {
      ctx.font = `${weight} ${size}px ${FONT}`;
      if (ctx.measureText(text).width <= maxW) return { size, lines: [text] };
    }
    // two lines at the smallest size, splitting at the space nearest the middle; ellipsis if still too long
    ctx.font = `${weight} ${min}px ${FONT}`;
    const words = text.split(/\s+/);
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (!best || w < best.w) best = { w, lines: [a, b] };
    }
    const lines = best ? best.lines : [text];
    return { size: min, lines: lines.map((l) => clip(ctx, l, maxW)) };
  }
  function clip(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }

  /** Draw the cover. levels: three fader positions 0 … 1. Returns the canvas. */
  function drawCover({ title = '', artist = '', year = '', levels = [0.62, 0.38, 0.7] } = {}) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
    const ctx = cv.getContext('2d');
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, S, S);
    const glow = ctx.createRadialGradient(S / 2, S * 0.36, 50, S / 2, S * 0.36, S * 0.75);
    glow.addColorStop(0, 'rgba(255,255,255,0.045)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, S, S);

    // the console panel with three faders
    const px = 270, py = 140, pw = 860, ph = 700;
    rounded(ctx, px, py, pw, ph, 64); ctx.fillStyle = C.panel; ctx.fill();
    const top = py + 110, bot = py + ph - 110;
    [0.27, 0.5, 0.73].forEach((cx, i) => {
      const x = px + pw * cx;
      for (let t = 0; t <= 10; t++) { // scale marks either side of the slot
        const y = top + (bot - top) * t / 10;
        ctx.fillStyle = t === 2 ? '#5a6068' : C.tick;
        ctx.fillRect(x - 70, y - 1.5, 34, 3); ctx.fillRect(x + 36, y - 1.5, 34, 3);
      }
      const sw = 38;
      rounded(ctx, x - sw / 2, top - 20, sw, bot - top + 40, sw / 2); ctx.fillStyle = C.slot; ctx.fill();
      const lvl = Math.max(0, Math.min(1, levels[i] ?? 0));
      const y = bot - (bot - top) * lvl;
      const cw = 150, ch = 88;
      const g = ctx.createLinearGradient(0, y - ch / 2, 0, y + ch / 2);
      const [t1, t2] = i === 2 ? [C.redTop, C.redBot] : [C.greyTop, C.greyBot];
      g.addColorStop(0, t1); g.addColorStop(1, t2);
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 10;
      rounded(ctx, x - cw / 2, y - ch / 2, cw, ch, 10); ctx.fillStyle = g; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = C.capLine; ctx.fillRect(x - cw / 2 + 6, y - 3, cw - 12, 6);
    });

    // title, artist, year
    const maxW = 1180;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const t = fit(ctx, (title || 'Untitled').trim(), 700, maxW, 128, 72);
    ctx.font = `700 ${t.size}px ${FONT}`; ctx.fillStyle = C.text;
    let y = t.lines.length > 1 ? 975 : 1025;
    for (const line of t.lines) { ctx.fillText(line, S / 2, y); y += t.size * 1.08; }
    if (artist) {
      const a = fit(ctx, artist.trim(), 500, maxW, 68, 44);
      ctx.font = `500 ${a.size}px ${FONT}`; ctx.fillStyle = C.muted;
      ctx.fillText(a.lines.join(' '), S / 2, y + 22);
      y += a.size + 22;
    }
    if (year) {
      ctx.font = `500 44px ${FONT}`; ctx.fillStyle = C.faint;
      ctx.fillText(String(year).trim(), S / 2, Math.min(S - 70, y + 70));
    }
    return cv;
  }

  /** The cover as JPEG bytes. */
  async function makeCover(opts) {
    const cv = drawCover(opts);
    const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      : await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  }

  root.Cover = { songLevels, drawCover, makeCover, SIZE: S };
})(typeof self !== 'undefined' ? self : this);
