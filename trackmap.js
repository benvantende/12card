/*
 * trackmap.js — an overview of the song above the console: one lane per channel strip, showing where each
 * track has sound, the marks, and the play position. Click or drag to jump.
 *
 * The level outline is made without reading whole tracks: for each of a few hundred points along the song it
 * reads a short slice (1024 samples) of every track file and measures its level. That's about 2 MB per song,
 * so even long songs are drawn in a moment. Outlines are kept per song file until the file changes.
 */
(function (root) {
  'use strict';

  const POINTS = 480, WIN = 1024, FLOOR_DB = -60;
  const cache = new Map(); // key: track file name + size + modified time → Float32Array of 0…1 levels

  /**
   * cancelled(): true when another song was opened meanwhile; reading stops then. Reads go 8 at a time per
   * track, so flicking through songs never piles up thousands of file reads (that can make the browser
   * give up and leave a black window).
   */
  async function trackLevels(t, cancelled = () => false) {
    const key = `${t.file.name}|${t.file.size}|${t.file.lastModified}`;
    if (cache.has(key)) return cache.get(key);
    const B = t.bitsPerSample / 8, out = new Float32Array(POINTS);
    const readPoint = (p) => {
      const frame = Math.floor(((p + 0.5) / POINTS) * t.frames - WIN / 2);
      const start = t.dataOffset + Math.max(0, Math.min(t.frames - WIN, frame)) * B;
      return t.file.slice(start, start + WIN * B).arrayBuffer().then((buf) => {
        const b = new Uint8Array(buf), n = Math.floor(b.length / B);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const o = i * B;
          let v;
          if (B === 2) v = ((b[o] | (b[o + 1] << 8)) << 16 >> 16) / 32768;
          else if (B === 3) v = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
          else v = 0;
          sum += v * v;
        }
        const rms = n ? Math.sqrt(sum / n) : 0;
        const db = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
        out[p] = Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
      });
    };
    for (let p = 0; p < POINTS; p += 8) {
      if (cancelled()) return null;
      const batch = [];
      for (let q = p; q < Math.min(POINTS, p + 8); q++) batch.push(readPoint(q));
      await Promise.all(batch);
    }
    // each point is a short sample of the track: smooth them (peak of the neighbours, then averaged) into an outline
    const pk = out.map((v, i) => Math.max(out[i - 1] || 0, v, out[i + 1] || 0));
    const sm = pk.map((v, i) => ((pk[i - 1] ?? v) + 2 * v + (pk[i + 1] ?? v)) / 4);
    cache.set(key, sm);
    return sm;
  }

  class TrackMap {
    /** el: the container; player: the Player; strips: Player.STRIPS. */
    constructor(el, player, strips) {
      this.el = el; this.player = player; this.strips = strips;
      this.el.innerHTML = '<canvas></canvas><div class="tm-head" aria-hidden="true"></div><div class="tm-hover" aria-hidden="true"></div><div class="tm-note"></div>';
      this.canvas = el.querySelector('canvas');
      this.head = el.querySelector('.tm-head');
      this.hover = el.querySelector('.tm-hover');
      this.note = el.querySelector('.tm-note');
      this.levels = null; this.song = null; this.marks = []; this.token = 0; this.trim = null;
      this.labelW = 40;
      new ResizeObserver(() => this.draw()).observe(el);
      const timeAt = (e) => {
        const r = this.canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left - this.labelW) / (r.width - this.labelW - 6)));
        return x * this.player.duration;
      };
      let dragging = false, handle = null;
      // in trim mode the two edges of the kept part can be dragged; anywhere else still moves the play position
      const nearHandle = (e) => {
        if (!this.trim || !this.player.duration) return null;
        const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left;
        const d = (sec) => Math.abs(px - this.xAt(sec));
        const ds = d(this.trim.start), de = d(this.trim.end);
        if (Math.min(ds, de) > 8) return null;
        return ds <= de ? 'start' : 'end';
      };
      el.addEventListener('pointerdown', (e) => {
        if (!this.player.duration) return;
        dragging = true; el.setPointerCapture(e.pointerId);
        handle = nearHandle(e);
        if (handle) { this.ontrim && this.ontrim(handle, timeAt(e)); return; }
        this.player.seek(timeAt(e)); this.onseek && this.onseek();
      });
      el.addEventListener('pointermove', (e) => {
        if (!this.player.duration) return;
        const t = timeAt(e);
        el.classList.toggle('on-handle', !!(handle || (!dragging && nearHandle(e))));
        if (dragging && handle) this.ontrim && this.ontrim(handle, t);
        else if (dragging) { this.player.seek(t); this.onseek && this.onseek(); }
        const r = this.canvas.getBoundingClientRect();
        this.hover.style.left = `${Math.max(this.labelW, Math.min(r.width - 6, e.clientX - r.left))}px`;
        this.hover.textContent = this.fmt(t);
        this.hover.hidden = false;
      });
      el.addEventListener('pointerup', () => { dragging = false; handle = null; });
      el.addEventListener('pointerleave', () => { this.hover.hidden = true; });
    }

    fmt(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

    /** Show a song (after player.load). marks: in seconds. */
    async show(song, marks) {
      const token = ++this.token;
      this.song = song; this.marks = marks || []; this.levels = null;
      this.note.textContent = 'Reading the tracks…'; this.note.hidden = false;
      this.draw();
      const tracks = this.player.tracks || [];
      const cancelled = () => token !== this.token;
      const lv = [];
      for (const t of tracks) {                          // one track after the other
        if (cancelled()) return;                         // another song was opened meanwhile
        lv.push(t ? await trackLevels(t, cancelled).catch(() => null) : null);
      }
      if (cancelled()) return;
      this.levels = lv;
      this.note.hidden = true;
      this.draw();
    }

    setMarks(marks) { this.marks = marks || []; this.draw(); }

    /** Trim mode: { start, end } in seconds (the part that stays), or null. */
    setTrim(range) { this.trim = range; this.el.classList.toggle('trimming', !!range); this.draw(); }

    /** x position (in CSS pixels) of a time in seconds. */
    xAt(sec) {
      const w = this.el.clientWidth, dur = this.player.duration || 1;
      return this.labelW + (Math.max(0, Math.min(dur, sec)) / dur) * (w - 6 - this.labelW);
    }

    /** Redraw (after resize, mute/solo or mode changes). */
    draw() {
      const c = this.canvas, dpr = window.devicePixelRatio || 1;
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      c.style.width = `${w}px`; c.style.height = `${h}px`;
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const css = getComputedStyle(this.el);
      const col = (n, d) => (css.getPropertyValue(n) || d).trim();
      const green = col('--ok', '#3fb950'), blue = col('--accent', '#4ea1ff'), muted = col('--muted', '#8b949e'), line = col('--line', '#2a2f36');
      const top = 14, bottom = h - 4, x0 = this.labelW, x1 = w - 6, lanes = this.strips.length;
      const laneH = (bottom - top) / lanes;
      const P = this.player, mainMode = P.mode === 'main';
      const audible = (s) => (P._audible ? P._audible(s.id) : true);
      // time grid every 30 s (or 60 s for long songs)
      const dur = P.duration || 0;
      g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
      if (dur > 0) {
        const step = dur > 600 ? 60 : dur > 120 ? 30 : 10;
        for (let t = step; t < dur; t += step) {
          const x = x0 + (t / dur) * (x1 - x0);
          g.fillStyle = line; g.fillRect(Math.round(x), top, 1, bottom - top);
          g.fillStyle = muted; g.fillText(this.fmt(t), x + 3, 1);
        }
      }
      // marks
      g.fillStyle = col('--warn', '#d29922');
      for (const m of this.marks) {
        if (!dur || m > dur) continue;
        const x = x0 + (m / dur) * (x1 - x0);
        g.globalAlpha = 0.35; g.fillRect(Math.round(x), top, 1, bottom - top); g.globalAlpha = 1;
        g.beginPath(); g.moveTo(x - 4, 2); g.lineTo(x + 4, 2); g.lineTo(x, 9); g.closePath(); g.fill();
      }
      // lanes
      this.strips.forEach((s, i) => {
        const y = top + i * laneH, mid = y + laneH / 2;
        const lit = mainMode ? s.mixRec : (!s.mixRec || audible(s)) && audible(s);
        const colr = s.mixRec ? blue : green;
        g.font = `${Math.max(9, Math.min(11, laneH - 2))}px system-ui, sans-serif`;
        g.fillStyle = lit ? (s.mixRec ? blue : css.getPropertyValue('--text').trim() || '#e6e6e6') : muted;
        g.globalAlpha = lit ? 0.9 : 0.5;
        g.textBaseline = 'middle';
        g.fillText(s.id, 4, mid);
        g.globalAlpha = 1;
        g.fillStyle = line; g.fillRect(x0, Math.round(y + laneH) - 0.5, x1 - x0, 1);
        if (!this.levels) return;
        const lv = s.tracks.map((t) => this.levels[t]).filter(Boolean);
        if (!lv.length) return;
        const amp = laneH / 2 - 1.5;
        g.fillStyle = colr; g.globalAlpha = lit ? 0.85 : 0.22;
        g.beginPath();
        const n = POINTS;
        const frames = s.tracks.map((t) => (P.tracks[t] ? P.tracks[t].frames : 0)).reduce((a, b) => Math.max(a, b), 0);
        const span = dur ? frames / P.sampleRate / dur : 1; // a track shorter than the song ends early
        const xs = (p) => x0 + ((p + 0.5) / n) * span * (x1 - x0);
        const v = (p) => Math.max(...lv.map((a) => a[p]));
        g.moveTo(xs(0), mid);
        for (let p = 0; p < n; p++) g.lineTo(xs(p), mid - v(p) * amp);
        for (let p = n - 1; p >= 0; p--) g.lineTo(xs(p), mid + v(p) * amp);
        g.closePath(); g.fill();
        g.globalAlpha = 1;
      });
      g.textBaseline = 'top';
      // trim: dim what will be cut, mark the two edges with a handle
      if (this.trim && dur) {
        const a = this.xAt(this.trim.start), b = this.xAt(this.trim.end), red = col('--bad', '#e5534b');
        g.fillStyle = 'rgba(0, 0, 0, .55)';
        g.fillRect(x0, top, a - x0, bottom - top); g.fillRect(b, top, x1 - b, bottom - top);
        g.fillStyle = red; g.globalAlpha = 0.18;
        g.fillRect(x0, top, a - x0, bottom - top); g.fillRect(b, top, x1 - b, bottom - top);
        g.globalAlpha = 1;
        for (const [x, dir] of [[a, 1], [b, -1]]) {
          g.fillRect(Math.round(x) - 1, top, 2, bottom - top);
          g.beginPath(); g.moveTo(x, top); g.lineTo(x + dir * 9, top); g.lineTo(x, top + 12); g.closePath(); g.fill();
          g.beginPath(); g.moveTo(x, bottom); g.lineTo(x + dir * 9, bottom); g.lineTo(x, bottom - 12); g.closePath(); g.fill();
        }
      }
      this.tick(true);
    }

    /** Move the play-position line (called from the app's animation loop). */
    tick(force) {
      const P = this.player, dur = P.duration;
      if (!dur || !this.song) { this.head.hidden = true; return; }
      const w = this.el.clientWidth, x = this.labelW + (Math.min(P.position, dur) / dur) * (w - 6 - this.labelW);
      if (!force && Math.abs(x - (this._x || 0)) < 0.5) return;
      this._x = x;
      this.head.hidden = false;
      this.head.style.transform = `translateX(${x}px)`;
    }
  }

  root.TrackMap = TrackMap;
})(typeof self !== 'undefined' ? self : this);
