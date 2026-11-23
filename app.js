/*
 * app.js — UI for 12card, the TASCAM Model 12 card manager.
 */
(function () {
  'use strict';
  const M = window.Model12;
  const P = window.Player;
  const $ = (id) => document.getElementById(id);

  const state = { card: null, selected: null, tab: 'songs', search: '', sort: 'date', dir: 'desc' };
  const player = new P();
  // the song overview above the console (trackmap.js)
  const tmap = new window.TrackMap($('trackMap'), player, window.Player.STRIPS);
  const mix = new window.MixdownPlayer(player);  // mixdowns from MUSIC/ play through the same engine
  const T = () => (mix.active ? mix : player);   // whatever the transport controls right now
  window.app = { soundRange,  state, player }; // handy for debugging in the browser console

  // ---------- helpers ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hms(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
  }
  const mss = (sec) => { sec = Math.round(sec || 0); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const mb = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';
  const fmtDate = (d) => (d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  function ago(d) {
    if (!d) return '';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 60) return Math.round(s / 86400) + 'd ago';
    return fmtDate(d);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 5000);
  }
  player.onerror = toast;

  /** A notice with buttons that stays until it is dismissed. actions: [{ label, primary, run }] */
  function notice(html, actions) {
    const n = $('notice');
    n.innerHTML = `<div class="nt-text">${html}</div><div class="nt-actions">${actions.map((a, i) => `<button class="btn small${a.primary ? ' primary' : ''}" data-i="${i}">${a.label}</button>`).join('')}</div>`;
    n.hidden = false;
    n.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      n.hidden = true;
      const a = actions[+b.dataset.i];
      if (a && a.run) a.run();
    };
  }
  const TIP_KEY = 'tmm.hideOpenTip';
  function showOpenTip() {
    try { if (localStorage.getItem(TIP_KEY)) return; } catch (e) { /* no storage */ }
    notice(`${icon('info')} <span><b>Tip:</b> run <b>Check card</b> to see whether every file on the card can be changed. Files marked read-only still work, but editing them is slower.</span>`, [
      { label: 'Check card', primary: true, run: () => $('checkBtn').click() },
      { label: 'Later' },
      { label: "Don't show again", run: () => { try { localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* ignore */ } } },
    ]);
  }

  // ---------- opening a card ----------

  async function walkHandle(dir, prefix, depth, out) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      const path = prefix ? prefix + '/' + name : name;
      if (h.kind === 'directory') {
        if (depth < 4) await walkHandle(h, path, depth + 1, out);
      } else {
        const f = await h.getFile();
        out.push({ path, size: f.size, handle: h, getFile: () => h.getFile() });
      }
    }
    return out;
  }

  async function openCard() {
    if ('showDirectoryPicker' in window) {
      let dir;
      try { dir = await window.showDirectoryPicker({ id: 'model12-card', mode: 'read' }); }
      catch (e) {
        if (e.name === 'AbortError') return;          // user cancelled
        $('dirInput').click();                        // picker blocked: use the plain folder input instead
        return;
      }
      await openHandle(dir);
      if (state.card && canEdit()) { showOpenTip(); offerTrimCleanup(); }
    } else {
      $('dirInput').click(); // fallback: works in every browser, read-only
    }
  }

  /** Open a card from a directory handle (picker, or a test folder). Editing is possible this way. */
  async function openHandle(dir, keepFolder) {
    state.rootHandle = dir;
    await loadEntries(await walkHandle(dir, '', 0, []), dir.name, keepFolder);
    // find the card root inside the picked folder (it may be a copy one level down)
    state.cardRoot = null;
    if (state.card) {
      let h = dir;
      for (const part of state.card.root ? state.card.root.split('/') : []) h = await h.getDirectoryHandle(part);
      state.cardRoot = h;
    }
    renderEditState();
  }

  $('dirInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const entries = files.map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, getFile: async () => f }));
    state.rootHandle = state.cardRoot = null; // read-only: no handles to write with
    await loadEntries(entries, files[0].webkitRelativePath.split('/')[0]);
    renderEditState();
    e.target.value = '';
  });

  async function loadEntries(entries, label, keepFolder) {
    $('cardStatus').innerHTML = '<span class="dot off"></span>Reading card…';
    try {
      const card = await M.loadCard(entries);
      card.label = label;
      card.entries = entries;
      state.card = card;
      state.selected = null;
      player.stop();
      renderCard();
      const keep = keepFolder && card.songs.find((s) => s.folder === keepFolder);
      const first = keep || sortedSongs()[0];
      if (first) await selectSong(first);
      if (card.warning) toast(card.warning);
      const warn = M.cardIssues(card).filter((i) => i.level === 'warn');
      if (warn.length) toast('⚠ ' + warn[0].msg);
    } catch (err) {
      state.card = null;
      $('cardStatus').innerHTML = '<span class="dot off"></span>' + esc(err.message);
      toast(err.message);
    }
  }

  /** Re-read the card after a change (or on demand). */
  async function rescan(keepFolder) {
    if (state.rootHandle) await openHandle(state.rootHandle, keepFolder);
  }

  // ---------- song list ----------

  function sortedSongs() {
    const q = state.search.trim().toLowerCase();
    const list = state.card ? state.card.songs.filter((s) => !q || s.name.toLowerCase().includes(q)) : [];
    const by = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      date: (a, b) => ((b.sys && b.sys.created) || 0) - ((a.sys && a.sys.created) || 0),
      length: (a, b) => (b.duration || 0) - (a.duration || 0),
      size: (a, b) => b.totalBytes - a.totalBytes,
    }[state.sort];
    // each comparison above is in its natural order (newest, A–Z, longest, biggest first); the other direction flips it
    const natural = state.sort === 'name' ? 'asc' : 'desc';
    return list.sort(state.dir === natural ? by : (a, b) => by(b, a));
  }

  function usageBar(s) {
    return '<div class="usage" aria-hidden="true">' + s.tracks.map((t, i) =>
      `<i class="${!t ? 'missing' : t.empty ? '' : 'on'}${i >= 10 ? ' mix' : ''}" title="TR${String(i + 1).padStart(2, '0')}${!t ? ' missing' : t.empty ? ' empty' : ''}"></i>`).join('') + '</div>';
  }

  function renderCard() {
    const c = state.card;
    const cur = c.info && c.info.currentSong ? ` · current song on device: ${esc(c.info.currentSong)}` : '';
    const used = (c.entries || state.card.entries || []).reduce((t, e) => t + (e.size || 0), 0);
    const usedTxt = used >= 1e9 ? `${(used / 1e9).toFixed(2)} GB` : `${Math.round(used / 1e6)} MB`;
    $('cardStatus').innerHTML = `<span class="dot"></span>Card opened · ${esc(c.label || 'TASCAM_M')} · ${c.songs.length} song${c.songs.length === 1 ? '' : 's'} · <span title="Total size of all files on the card">${usedTxt} used</span>${cur}`;
    $('songCount').textContent = `(${c.songs.length})`;
    $('musicCount').textContent = `(${c.music.length})`;
    $('welcome').hidden = true;
    renderList();
    renderMusic();
  }

  const CURRENT_TIP = 'Current song: the last song loaded on the Model 12';
  const PROTECT_TIP = 'Protected: the Model 12 and this app will not change it';
  /** The pin (current song) and lock (protected) icons shown after a song's name. */
  function statusIcons(s) {
    return (s.isCurrent ? `<span class="st st-current" title="${CURRENT_TIP}">${icon('pin')}</span>` : '')
      + (s.sys && s.sys.protected ? `<span class="st st-lock" title="${PROTECT_TIP}">${icon('lock')}</span>` : '');
  }

  function renderList() {
    const ul = $('songList');
    const songs = sortedSongs();
    if (!songs.length) { ul.innerHTML = `<li class="empty-list">${state.card ? 'No songs match.' : 'No card opened.'}</li>`; return; }
    ul.innerHTML = songs.map((s) => {
      const created = s.sys && s.sys.created;
      const badges = [
        s.warnings.length ? `<span class="badge warn" title="${esc(s.warnings.join('\n'))}">!</span>` : '',
      ].join('');
      return `<li class="song-item${s === state.selected ? ' selected' : ''}" data-folder="${esc(s.folder)}" tabindex="0">
        <div class="song-name"><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>${statusIcons(s)}</div>
        <div class="badges">${badges}</div>
        <div class="song-meta" title="${s.used}/12 tracks used">${mss(s.duration)} · ${mb(s.totalBytes)} · ${esc(ago(created))}</div>
        ${usageBar(s)}
      </li>`;
    }).join('');
  }

  $('songList').addEventListener('click', (e) => {
    const li = e.target.closest('.song-item');
    if (!li) return;
    const s = state.card.songs.find((x) => x.folder === li.dataset.folder);
    if (s) selectSong(s);
  });
  $('songList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('song-item')) e.target.click();
  });

  function renderMusic() {
    const ul = $('musicList');
    const q = state.search.trim().toLowerCase();
    const files = state.card.music.filter((m) => !q || m.path.toLowerCase().includes(q));
    ul.innerHTML = files.length ? files.map((m) => `<li class="song-item" data-path="${esc(m.path)}" tabindex="0">
        <div class="song-name">${esc(m.path.replace(/^MUSIC\//, ''))}</div>
        <div class="song-meta">${mb(m.size)}</div></li>`).join('')
      : '<li class="empty-list">No files in MUSIC.</li>';
  }

  async function playMixdown(li) {
    const m = state.card.music.find((x) => x.path === li.dataset.path);
    if (!m) return;
    document.querySelectorAll('#musicList .selected').forEach((x) => x.classList.remove('selected'));
    li.classList.add('selected');
    await mix.load(await m.getFile(), m.path.replace(/^MUSIC\//, '').replace(/\.wav$/i, ''));
    renderTransport();
    renderMixer();
    await mix.play();
  }
  $('musicList').addEventListener('click', (e) => {
    const li = e.target.closest('.song-item');
    if (li && li.dataset.path) playMixdown(li);
  });
  $('musicList').addEventListener('keydown', (e) => {
    const li = e.target.closest('.song-item');
    if (e.key === 'Enter' && li && li.dataset.path) playMixdown(li);
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('songList').hidden = state.tab !== 'songs';
    $('musicList').hidden = state.tab !== 'music';
    $('sortBtn').hidden = state.tab !== 'songs';
    $('search').placeholder = state.tab === 'songs' ? 'Search songs' : 'Search mixdowns';
  }));

  $('search').addEventListener('input', (e) => { state.search = e.target.value; if (state.card) { renderList(); renderMusic(); } });
  // sorting: a small menu (sort by date, name, size or length; ascending or descending), remembered in this browser
  const SORT_NAMES = { date: ['Oldest', 'Newest'], name: ['A–Z', 'Z–A'], size: ['Smallest', 'Largest'], length: ['Shortest', 'Longest'] };
  try { const s = JSON.parse(localStorage.getItem('tmm.sort') || 'null'); if (s && SORT_NAMES[s.sort]) { state.sort = s.sort; state.dir = s.dir === 'asc' ? 'asc' : 'desc'; } } catch (e) { /* storage off */ }
  function renderSortBtn() {
    $('sortBtn').innerHTML = `${icon('sort')}<span>${SORT_NAMES[state.sort][state.dir === 'asc' ? 0 : 1]}</span>`;
    $('sortPop').querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === state.sort)));
    $('sortPop').querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dir === state.dir)));
  }
  function setSortPop(open) { $('sortPop').hidden = !open; $('sortBtn').setAttribute('aria-expanded', String(open)); }
  $('sortBtn').addEventListener('click', () => setSortPop($('sortPop').hidden));
  $('sortPop').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sort) { if (state.sort !== b.dataset.sort) state.dir = b.dataset.sort === 'name' ? 'asc' : 'desc'; state.sort = b.dataset.sort; }
    if (b.dataset.dir) state.dir = b.dataset.dir;
    try { localStorage.setItem('tmm.sort', JSON.stringify({ sort: state.sort, dir: state.dir })); } catch (err) { /* storage off */ }
    renderSortBtn(); renderList();
  });
  document.addEventListener('pointerdown', (e) => { if (!$('sortPop').hidden && !e.target.closest('.sort-wrap')) setSortPop(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sortPop').hidden) setSortPop(false); });
  renderSortBtn();

  // ---------- selected song ----------

  let selectToken = 0;
  async function selectSong(s) {
    // clicking quickly through songs: only the last one clicked finishes loading
    const token = ++selectToken;
    await flushMix(); // save the previous song's mix first
    if (token !== selectToken) return;
    state.selected = s;
    if (trim.on) endTrim();
    mix.unload();
    document.querySelectorAll('#musicList .selected').forEach((x) => x.classList.remove('selected'));
    renderList();
    renderInfo();
    await player.load(s);
    if (token !== selectToken || state.selected !== s) return;
    loadSongMix(s);
    renderMixer();
    renderTransport();
    renderFx();
    $('trackMap').hidden = false;
    tmap.show(s, markTimes());
  }

  // ---------- mixes saved per song (SETTINGS/<song>.json, "mix") ----------
  // The console's settings are saved for each song a moment after you change them; a song without its own mix
  // opens with the factory settings.
  const mixSave = { timer: 0, folder: null, quiet: false, asked: false, source: 'factory', state: '' };
  const parseMix = (folder) => { try { return JSON.parse((metaOf(folder) || {}).mix || 'null'); } catch (e) { return null; } };
  function loadSongMix(s) {
    const own = parseMix(s.folder);
    mixSave.quiet = true;
    try { player.setMix(own || null); } finally { mixSave.quiet = false; }
    mixSave.source = own ? 'song' : 'factory';
    mixSave.state = own ? 'saved' : '';
    // snapshots belong to one mixing session: a song opened (again) starts without them
    if (snaps.folder !== s.folder) { snaps.folder = s.folder; snaps.slots = [null, null, null]; snaps.start = JSON.stringify(player.getMix()); }
  }

  // ---------- snapshots: three quick memories of the console to compare and go back to, plus the mix as it was when the song opened ----------
  const snaps = { folder: null, slots: [null, null, null], start: null };
  const mixNow = () => JSON.stringify(player.getMix());
  function renderSnaps() {
    const now = mixNow();
    snaps.slots.forEach((m, i) => {
      const b = $('snap' + i);
      if (!b) return;
      b.classList.toggle('filled', !!m);
      b.classList.toggle('current', !!m && m === now);
      b.title = m ? `Snapshot ${i + 1}: click to go back to it${m === now ? ' (the console is on it now)' : ''}. Shift+click or right-click: take it again from the console.`
        : `Snapshot ${i + 1}: click to remember the console as it is now`;
    });
    const s = $('snapStart');
    if (s) { s.classList.toggle('current', snaps.start === now); s.title = `The mix as it was when you opened this song${snaps.start === now ? ' (the console is on it now)' : ': click to go back to it'}`; }
  }
  function applySnap(json) {
    player.setMix(JSON.parse(json));
    renderMixer(); renderFx(); tmap.draw();
    mixChanged();
    renderSnaps();
  }
  function snapClick(i, retake) {
    if (i === 'start') { if (snaps.start) { applySnap(snaps.start); toast('Back to the mix as it was when you opened the song.'); } return; }
    if (!snaps.slots[i] || retake) { snaps.slots[i] = mixNow(); renderSnaps(); toast(`Snapshot ${i + 1} taken.`); return; }
    applySnap(snaps.slots[i]);
    toast(`Snapshot ${i + 1}.`);
  }
  ['set', 'setMaster', 'setFx', 'setMastering', 'resetStrip'].forEach((k) => {
    const f = player[k].bind(player);
    player[k] = (...args) => {
      const r = f(...args); mixChanged();
      if ((k === 'set' && (args[1] === 'mute' || args[1] === 'solo')) || k === 'resetStrip') tmap.draw(); // the overview dims what you don't hear
      return r;
    };
  });
  function mixChanged() {
    if (!mixSave.quiet) requestAnimationFrame(renderSnaps);
    if (mixSave.quiet || !state.selected || !canEdit() || mix.active) return;
    // the first change asks once for permission to write (this runs inside the click or drag)
    if (!mixSave.asked && state.rootHandle) {
      mixSave.asked = true;
      state.rootHandle.queryPermission({ mode: 'readwrite' }).then((p) => (p === 'granted' ? p : state.rootHandle.requestPermission({ mode: 'readwrite' }))).catch(() => {});
    }
    mixSave.folder = state.selected.folder;
    mixSave.source = 'song';
    setMixState('saving');
    clearTimeout(mixSave.timer);
    mixSave.timer = setTimeout(flushMix, 1500);
  }
  async function flushMix() {
    clearTimeout(mixSave.timer);
    const folder = mixSave.folder;
    if (!folder) return;
    mixSave.folder = null;
    const ok = await writeMix(folder, JSON.stringify(player.getMix()));
    if (state.selected && state.selected.folder === folder) setMixState(ok ? 'saved' : 'unsaved');
  }
  /** Store (or with null, remove) a song's mix in its settings file, without the busy screen. */
  async function writeMix(folder, json) {
    if (!state.cardRoot) return false;
    if (busy) { await new Promise((r) => setTimeout(r, 500)); if (busy) { mixSave.folder = folder; mixSave.timer = setTimeout(flushMix, 1500); return false; } }
    try {
      if ((await state.rootHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') return false;
      const map = JSON.parse(JSON.stringify(state.card.meta || {}));
      const sec = map[folder] || {};
      if (json) sec.mix = json; else delete sec.mix;
      if (Object.keys(sec).length) map[folder] = sec; else delete map[folder];
      await migrateIfNeeded();
      await window.CardIO.writeMetadata(state.cardRoot, map, state.card.meta);
      state.card.meta = map;
      return true;
    } catch (e) { console.warn('saving the mix failed', e); return false; }
  }
  /** The save icon in the Multitrack bar: flickers red while saving, green once the song's mix is stored. */
  function setMixState(st) {
    mixSave.state = st;
    const el = $('mixSaveIcon');
    if (!el) return;
    el.className = `vb-icon mix-save ${st || 'idle'}`;
    el.title = st === 'saving' ? 'Saving the mix…' : st === 'unsaved' ? 'The mix could not be saved (no write access to the card)'
      : st === 'saved' ? `The mix is saved with the song (SETTINGS/${state.selected ? state.selected.folder : ''}.json)` : 'Factory settings: change something and it is saved with the song';
  }
  $('viewBar').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.snap[data-snap]');
    if (b && b.dataset.snap !== 'start') { e.preventDefault(); snapClick(+b.dataset.snap, true); }
  });
  $('viewBar').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !state.selected) return;
    if (b.dataset.snap) { snapClick(b.dataset.snap === 'start' ? 'start' : +b.dataset.snap, e.shiftKey); return; }
    await flushMix();
    const s = state.selected;
    if (b.id === 'mixReset') {
      const before = (metaOf(s.folder) || {}).mix || null;
      if (before && !(await writeMix(s.folder, null))) { alertBox('Not saved', 'The mix could not be reset on the card.'); return; }
      if (before) pushHistory({ kind: 'mix', folder: s.folder, before, after: null });
      loadSongMix(s); renderMixer(); renderFx();
      toast('The console is back on the factory settings for this song. ↶ brings your mix back.');
    }
    updateMixHint();
  });

  /** How a channel is named in the dropdowns: Track 1 … Track 12, Tracks 7/8, Tracks 9/10, Master 11/12. */
  const channelLabel = (c) => (c.id === '11/12' ? 'Master 11/12' : c.tracks.length === 2 ? `Tracks ${c.id}` : `Track ${c.id}`);

  // ---------- song info box (metadata.txt) ----------
  const metaOf = (folder) => (state.card && state.card.meta && state.card.meta[folder]) || {};
  /** The song's tempo: BPM from Song info if set, else the Model 12's click setting from song.sys. */
  const songBpm = (s) => { const v = parseFloat(metaOf(s.folder).bpm); return v > 0 ? v : null; };
  const songTempo = (s) => (s && (songBpm(s) || (s.sys && s.sys.tempo))) || null;
  player.songTempo = songTempo;
  /** Artists or genres used on this card, most used first (from the songs and the card's own list). */
  function choices(field) {
    const count = new Map();
    for (const sec of Object.values((state.card && state.card.meta) || {})) {
      const v = (sec[field] || '').trim();
      if (v) count.set(v, (count.get(v) || 0) + 1);
    }
    const listed = ((state.card && state.card.cardSettings && state.card.cardSettings[field === 'artist' ? 'artists' : 'genres']) || []);
    for (const v of listed) if (v && !count.has(v)) count.set(v, 0);
    return [...count.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([v]) => v);
  }
  const mostUsed = (field) => choices(field)[0] || '';
  /** The value shown and exported for a song: its own, else the card's most used. */
  const effective = (folder, field) => (metaOf(folder)[field] || '').trim() || mostUsed(field);
  let infoOpen = false; // the song info floats over the console, so it starts closed

  /** One box: a bar like the Multitrack bar (always visible) that folds open to the details and the song info fields. */
  function infoPanel(s, fmt) {
    const sys = s.sys || {}, m = metaOf(s.folder);
    const dis = canEdit() ? '' : ' disabled';
    const artist = effective(s.folder, 'artist');
    // artist and genre: the song's own, or the most used one on the card filled in (saved when you click Save)
    const pre = (k) => m[k] || ((k === 'artist' || k === 'genre') ? mostUsed(k) : '');
    const f = (k, label, ph, extra = '') => `<label class="mf mf-${k}"><span>${label}</span><input id="meta_${k}" data-k="${k}" value="${esc(pre(k))}" placeholder="${esc(ph)}"${extra}${dis}></label>`;
    const sum = [
      `Title <b>${esc(m.title || s.name)}</b>`,
      artist ? `Artist <b>${esc(artist)}</b>` : '',
      `Created <b>${esc(fmtDate(sys.created))}</b>`,
      `Size <b>${mb(s.totalBytes)}</b>`,
      songBpm(s) ? `Tempo <b>${fmtBpm(songBpm(s))} BPM</b>` : `Click <b>${sys.tempo || '—'} BPM</b>`,
    ].filter(Boolean).join('<i>·</i>');
    return `<section id="infoPanel" class="info-panel${infoOpen ? ' open' : ''}">
      <div class="ip-bar" role="button" tabindex="0" aria-expanded="${infoOpen}" title="${infoOpen ? 'Fold away' : 'Show all details and edit the song info'}">
        ${icon('info')}<b>Song info</b>
        <span class="ip-sum">${sum}</span>
        <small id="metaState"></small>
        <button type="submit" form="metaForm" id="metaSave" class="ip-save" disabled title="Save the song info" aria-label="Save the song info">${icon('save')}</button>
        <span class="ip-chev">${icon('chevronDown')}</span>
      </div>
      <div class="ip-body">
        <ul class="facts">
          <li>Format <b>${fmt}</b></li>
          <li title="The tempo the song is played at: the BPM in Song info (used by the delay effects and in downloads)">Tempo <b>${songBpm(s) ? `${fmtBpm(songBpm(s))} BPM` : '—'}</b></li>
          <li title="The metronome (click) tempo set on the Model 12 for this song. The unit doesn't store the tempo you play at; that's the BPM. Saving a BPM also sets the click to it.">Click <b>${sys.tempo || '—'} BPM</b></li>
          <li title="Marks set on the Model 12">Marks <b>${sys.marks ? sys.marks.length : 0}</b></li>
          <li title="Tracks that hold audio, of 12">Tracks <b>${s.used} of 12</b>${usageBar(s)}</li>
          <li>Length <b>${mss(s.duration)}</b></li>
        </ul>
        <form id="metaForm" class="meta-box" autocomplete="off" title="Song info is kept in SETTINGS/${esc(s.folder)}.json on the card. The Model 12 ignores it.">
          <div class="mb-fields">
            ${f('title', 'Title', s.name)}
            ${f('artist', 'Artist', '', ' list="artistChoices"')}
            ${f('genre', 'Genre', '', ' list="genreChoices"')}
            <div class="mb-pair">
              ${f('year', 'Year', String(sys.created ? sys.created.getFullYear() : new Date().getFullYear()), ' inputmode="numeric" maxlength="4"')}
              <label class="mf mf-bpm"><span>BPM <button type="button" id="bpmDetect" class="linkish" title="Estimate the tempo from the recorded audio">detect</button></span><input id="meta_bpm" data-k="bpm" value="${esc(m.bpm || '')}" placeholder="${sys.tempo ? `click ${sys.tempo}` : ''}" inputmode="decimal" maxlength="6"${dis}></label>
            </div>
          </div>
          <datalist id="artistChoices">${choices('artist').map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
          <datalist id="genreChoices">${choices('genre').map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
          <div class="mb-texts">
            <label class="mf mf-description"><span>Description</span><textarea id="meta_description" data-k="description" placeholder="What the song is about, how it was made…"${dis}>${esc(m.description || '')}</textarea></label>
            <label class="mf mf-comment"><span>Comment</span><textarea id="meta_comment" data-k="comment" placeholder="Notes"${dis}>${esc(m.comment || '')}</textarea></label>
          </div>
        </form>
      </div>
    </section>`;
  }
  const fmtBpm = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

  /** Read a song's audio as mono floats: the main mix on 11/12 if there is one, otherwise tracks 1–10 summed. */
  async function songAudio(s) {
    const mixTracks = [10, 11].filter((i) => s.tracks[i] && !s.tracks[i].empty);
    const use = mixTracks.length ? mixTracks : s.tracks.slice(0, 10).map((t, i) => (t && !t.empty ? i : -1)).filter((i) => i >= 0);
    if (!use.length) return null;
    let out = null, rate = 44100;
    for (const i of use) {
      const b = new Uint8Array(await (await s.tracks[i].entry.getFile()).arrayBuffer());
      const h = window.Model12.parseWavHeader(b.subarray(0, 65536), b.length);
      rate = h.sampleRate;
      const bps = h.bitsPerSample / 8, dv = new DataView(b.buffer, b.byteOffset + h.dataOffset);
      if (!out) out = new Float32Array(h.frames);
      const n = Math.min(out.length, h.frames);
      for (let k = 0, o = 0; k < n; k++, o += bps) out[k] += bps === 2 ? dv.getInt16(o, true) / 32768 : ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608);
    }
    return { samples: out, rate, source: mixTracks.length ? 'the main mix on 11/12' : 'tracks 1–10' };
  }
  $('songInfo').addEventListener('click', async (e) => {
    if (e.target.id !== 'bpmDetect') return;
    const s = state.selected;
    showBusy('Listening for the beat…');
    try {
      await new Promise((r) => setTimeout(r, 30)); // let the busy screen paint
      const a = await songAudio(s);
      if (!a) { alertBox('No audio', 'This song has no recorded tracks to listen to.'); return; }
      const est = window.Model12.estimateTempo(a.samples, a.rate);
      if (!est) { alertBox('Too short', 'The recording is too short to estimate a tempo (at least 8 seconds needed).'); return; }
      $('meta_bpm').value = fmtBpm(est.bpm);
      $('meta_bpm').dispatchEvent(new Event('input', { bubbles: true }));
      const alt = est.alternatives.map(fmtBpm).join(' or ');
      toast(`Estimated ${fmtBpm(est.bpm)} BPM from ${a.source}${est.confidence < 0.3 ? ' (no very clear beat)' : ''}. ${alt ? `If it feels off, try ${alt}. ` : ''}Click Save to keep it.`);
    } catch (err) { alertBox('Tempo detection failed', err.message || String(err)); }
    finally { hideBusy(); }
  });

  function setInfoOpen(open) {
    infoOpen = open;
    const p = $('infoPanel');
    if (!p) return;
    p.classList.toggle('open', open);
    const bar = p.querySelector('.ip-bar');
    bar.setAttribute('aria-expanded', String(open));
    bar.title = open ? 'Fold away' : 'Show all details and edit the song info';
  }
  $('songInfo').addEventListener('click', (e) => {
    const bar = e.target.closest('.ip-bar');
    if (!bar || e.target.closest('#metaSave')) return;
    setInfoOpen(!infoOpen);
  });
  // a click elsewhere or Escape folds it away again, unless there are unsaved changes in it
  document.addEventListener('pointerdown', (e) => {
    if (!infoOpen || e.target.closest('#infoPanel, dialog, .toast')) return;
    if (state.selected && $('meta_title') && metaDirty()) return;
    setInfoOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && infoOpen && !document.querySelector('dialog[open]') && !(state.selected && $('meta_title') && metaDirty())) setInfoOpen(false);
  });
  $('songInfo').addEventListener('keydown', (e) => {
    if (e.target.classList && e.target.classList.contains('ip-bar') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setInfoOpen(!infoOpen); }
  });
  const readMetaForm = () => Object.fromEntries(window.Model12.META_FIELDS.map((k) => [k, ($('meta_' + k) || {}).value || '']));
  function metaDirty() {
    const cur = readMetaForm(), saved = metaOf(state.selected.folder);
    return window.Model12.META_FIELDS.some((k) => {
      const c = (cur[k] || '').trim(), sv = (saved[k] || '').trim();
      if (!sv && (k === 'artist' || k === 'genre') && c === mostUsed(k)) return false; // the filled-in suggestion alone isn't a change
      return c !== sv;
    });
  }
  $('songInfo').addEventListener('input', (e) => {
    if (!e.target.closest('#metaForm')) return;
    const d = metaDirty();
    $('metaSave').disabled = !d;
    $('metaState').textContent = d ? 'not saved' : '';
  });
  $('songInfo').addEventListener('keydown', (e) => {
    if (e.target.closest('#metaForm') && e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT')) { e.preventDefault(); $('metaForm').requestSubmit(); }
  });
  $('songInfo').addEventListener('submit', async (e) => {
    if (e.target.id !== 'metaForm') return;
    e.preventDefault();
    if (!metaDirty()) return;
    const folder = state.selected.folder;
    const before = { ...metaOf(folder) }, after = readMetaForm();
    const s = state.selected;
    // the BPM also becomes the Model 12's click tempo (song.sys), as a whole number
    const bpm = Math.round(parseFloat(after.bpm));
    const clickFrom = s.sys && s.sys.tempo;
    const click = after.bpm && bpm >= 20 && bpm <= 250 && bpm !== clickFrom && s.sys && !s.sys.protected ? { from: clickFrom, to: bpm } : null;
    if (await saveMeta(folder, after)) {
      let extra = '';
      if (click && (await setClick(folder, click.to))) extra = ` The Model 12's click tempo is now ${click.to} BPM.`;
      else if (after.bpm && s.sys && s.sys.protected && bpm !== clickFrom) extra = ' (The song is protected, so its click tempo on the unit was left alone.)';
      pushHistory({ kind: 'meta', folder, before, after, click: click && extra.includes('click tempo is now') ? click : null });
      await rememberChoices(after);
      toast(`Song info of "${folder}" saved.${extra}`);
    }
  });

  /** Set the song's click tempo in song.sys (one byte, like the unit's own setting). */
  async function setClick(folder, bpm) {
    const r = await runOp(`Setting the click tempo of "${folder}" to ${bpm} BPM`, (log) => window.CardIO.setClickTempo(state.cardRoot, state.card, folder, bpm, log), folder, folder);
    syncTempo();
    return r;
  }
  /** Delays that follow the song pick up its current tempo (BPM, or else the click tempo). */
  function syncTempo() {
    const t = state.selected && songTempo(state.selected);
    player.followTempo(t);
    renderFx();
  }
  /** New artists and genres go on the card's list, so they're offered next time. */
  async function rememberChoices(values) {
    const cs = state.card.cardSettings || (state.card.cardSettings = { artists: [], genres: [] });
    let changed = false;
    for (const [field, key] of [['artist', 'artists'], ['genre', 'genres']]) {
      const v = (values[field] || '').trim();
      cs[key] = cs[key] || [];
      if (v && !cs[key].includes(v)) { cs[key].push(v); changed = true; }
    }
    if (changed) { try { await window.CardIO.writeCardSettings(state.cardRoot, cs); } catch (e) { console.warn('card settings', e); } }
  }

  /** metadata.txt (the older format) is converted to SETTINGS/*.json on the first write, then removed. */
  async function migrateIfNeeded() {
    if (!state.card || !state.card.metaEntry) return;
    await window.CardIO.migrateMetadata(state.cardRoot, state.card.meta, state.card.cardSettings || { artists: [], genres: [] });
    state.card.metaEntry = null;
    toast('Song info moved from metadata.txt to the SETTINGS folder (one file per song).');
  }

  /** Write one song's info (or move/remove it) and keep state.card.meta in step. */
  async function saveMeta(folder, values, renameTo = null) {
    if (busy) return false;
    try {
      if (!(await ensureWritePermission())) throw new Error('No permission to write to the card.');
      const map = JSON.parse(JSON.stringify(state.card.meta || {}));
      if (renameTo !== null) { if (!map[folder]) return true; map[renameTo] = map[folder]; delete map[folder]; }
      else if (values === null) { if (!map[folder]) return true; delete map[folder]; } // forget everything, the mix too
      else {
        const keep = Object.fromEntries(window.Model12.META_EXTRA.filter((k) => map[folder] && map[folder][k] && !(values && k in values)).map((k) => [k, map[folder][k]])); // e.g. the saved mix
        const clean = Object.assign(keep, Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v)));
        if (Object.keys(clean).length) map[folder] = clean; else delete map[folder];
      }
      await migrateIfNeeded();
      await window.CardIO.writeMetadata(state.cardRoot, map, state.card.meta);
      state.card.meta = map;
      if (state.selected && [folder, renameTo].includes(state.selected.folder)) {
        renderInfo(); renderTransport();
        const t = songTempo(state.selected);
        player.followTempo(t);
        renderFx();
      }
      return true;
    } catch (err) {
      alertBox('Saving song info failed', `${err.message || err}\n\nNothing else on the card was changed.`);
      return false;
    }
  }

  function protectBtn(s) {
    const on = !!(s.sys && s.sys.protected);
    const blocked = !canEdit() ? renameBlocker({ warnings: [] }) : !s.sys ? 'song.sys is missing.' : '';
    const title = on ? 'Remove the protection, so the song can be changed again' : 'Protect this song, like SONG PROTECT on the unit: nothing can change it until you unprotect it';
    return `<button id="protectBtn" class="act-btn${on ? ' on' : ''}" aria-label="${on ? 'Unprotect' : 'Protect'}" ${blocked ? `disabled title="${esc(blocked)}"` : `title="${esc(title)}"`}>${icon(on ? 'lockOpen' : 'lock')}<span>${on ? 'Unprotect' : 'Protect'}</span></button>`;
  }

  function actionBtn(id, ic, label, title, s, readOnlyOk, copyOk) {
    const nothing = readOnlyOk && s.tracks.every((t) => !t || t.empty);
    const blocked = copyOk ? (!canEdit() ? renameBlocker({ warnings: [] }) : s.warnings.length ? 'This song has problems; run Check card first.' : '')
      : readOnlyOk ? (nothing ? 'This song has no recorded tracks to export.' : '') : renameBlocker(s);
    return `<button id="${id}" class="act-btn" aria-label="${esc(label)}" ${blocked ? `disabled title="${esc(blocked)}"` : `title="${esc(title)}"`}>${icon(ic)}<span>${label}</span></button>`;
  }

  function renderInfo() {
    const s = state.selected, sys = s.sys || {};
    const fmt = s.sampleRate ? `${s.sampleRate / 1000} kHz / ${s.bitsPerSample}-bit` : '—';
    $('songInfo').className = 'song-info show';
    $('songInfo').innerHTML = `
      <div class="song-head">
        <h2><span class="nm${renameBlocker(s) ? '' : ' editable'}" id="songTitle" title="${esc(renameBlocker(s) || 'Click to rename this song on the card')}">${esc(s.name)}</span>${statusIcons(s)}</h2><div id="titleErrors" class="title-errors" hidden></div>
        <div class="song-actions" role="toolbar" aria-label="Song actions">
          ${actionBtn('dupBtn', 'copyPlus', 'Duplicate', 'Make a complete copy of this song to work on, so the original stays as it is', s, false, true)}
          ${actionBtn('tracksBtn', 'arrowLeftRight', 'Swap / copy', 'Swap or copy tracks on the card, e.g. 11/12 with 7/8 (TRACK SWAP)', s)}
          ${actionBtn('clearBtn', 'eraser', 'Clear', 'Empty tracks on the card (TRACK CLEAR)', s)}
          ${actionBtn('trimBtn', 'scissors', 'Trim', 'Cut silence (or anything) off the start and end of the song: all tracks at the same spot, in the Model 12\'s own format', s)}
          ${actionBtn('importBtn', 'importFile', 'Import', 'Put an audio file (WAV, FLAC, MP3, M4A, OGG, Opus) on an empty track or into a new song (TRACK IMPORT)', s)}
          ${protectBtn(s)}
          ${actionBtn('exportBtn', 'exportFile', 'Export mix', 'Make a stereo WAV: the recorded mix on 11/12 (STEREO MIX EXPORT), or your mix in the app', s, true)}
          ${actionBtn('deleteBtn', 'trash', 'Delete', 'Delete this song from the card for good (asks you to type DELETE)', s)}
        </div>
      </div>
      ${infoPanel(s, fmt)}
      ${s.warnings.length ? `<div class="warnings">⚠ ${s.warnings.map(esc).join(' · ')}</div>` : ''}`;
    fitActions();
  }

  /** The song buttons show icons only when their labels don't fit next to the title; labels come back when there's room. */
  function fitActions() {
    const bar = document.querySelector('#songInfo .song-actions');
    if (!bar) return;
    const head = bar.parentElement, title = head.querySelector('h2');
    bar.classList.remove('compact');
    const btns = [...bar.children], gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const need = btns.reduce((t, b) => t + b.offsetWidth, 0) + gap * Math.max(0, btns.length - 1); // with labels, one line
    const titleNeed = Math.min(title.scrollWidth, 170);        // keep room for (the start of) the song name
    bar.classList.toggle('compact', need > head.clientWidth - titleNeed - 16);
  }
  new ResizeObserver(() => fitActions()).observe(document.querySelector('.desk-top'));

  // ---------- the main faders sit on the same line as the channel faders ----------
  let alignQueued = false;
  function alignFaders() {
    alignQueued = false;
    const side = document.querySelector('.desk-side'), mixer = $('mixer');
    const strip = mixer.querySelector('.strip .fader-wrap'), main = $('masterFader').parentElement;
    side.style.paddingBottom = ''; mixer.style.marginTop = '';
    if (!strip || !mixer.classList.contains('show') || getComputedStyle(side).gridColumn === '1') return; // narrow screens: stacked, nothing to line up
    const d = main.getBoundingClientRect().bottom - strip.getBoundingClientRect().bottom;
    if (d > 0.5) side.style.paddingBottom = `${d}px`;          // the main faders sit lower: lift them
    else if (d < -0.5) mixer.style.marginTop = `${-d}px`;      // the channel faders sit lower: move the console down
  }
  function queueAlign() { if (!alignQueued) { alignQueued = true; requestAnimationFrame(alignFaders); } }
  const alignObs = new ResizeObserver(queueAlign);
  alignObs.observe(document.querySelector('.desk'));
  alignObs.observe($('mixer'));
  alignObs.observe(document.querySelector('.desk-side .fx-box'));
  alignObs.observe($('masterPanel'));
  window.addEventListener('resize', queueAlign);


  // ---------- editing: rename, undo/redo ----------

  const canEdit = () => !!(state.cardRoot && 'showDirectoryPicker' in window && window.FileSystemFileHandle && FileSystemFileHandle.prototype.move);
  const history = { undo: [], redo: [] };
  let backupConfirmed = false;
  let busy = false;

  function renameBlocker(s) {
    if (!canEdit()) {
      if (navigator.brave && !('showDirectoryPicker' in window)) return 'Renaming needs folder write access: turn on brave://flags/#file-system-access-api, restart Brave and open the card again.';
      if (!('showDirectoryPicker' in window)) return 'Renaming needs a Chromium browser (Chrome, Edge, Vivaldi, or Brave with the file-system-access flag).';
      return 'Open the card with "Open SD card…" to rename.';
    }
    if (s.sys && s.sys.protected) return 'This song is protected. Click Unprotect first (or unprotect it on the Model 12).';
    if (s.warnings.length) return 'This song has problems (see the warning). Run "Check card" before changing it.';
    return '';
  }

  function renderEditState() {
    const editable = canEdit();
    // only shown when nothing can be changed (Firefox, Safari, Brave without the flag, or no card open yet)
    $('modeBadge').hidden = editable || !state.card;
    $('modeBadge').textContent = 'Read-only';
    $('modeBadge').title = renameBlocker({ warnings: [] }) || 'This browser cannot change files on the card';
    $('undoBtn').disabled = busy || !editable || !history.undo.length;
    $('redoBtn').disabled = busy || !editable || !history.redo.length;
    $('undoBtn').title = history.undo.length ? `Undo ${describe(history.undo.at(-1))}` : 'Nothing to undo';
    $('redoBtn').title = history.redo.length ? `Redo ${describe(history.redo.at(-1))}` : 'Nothing to redo';
    $('checkBtn').disabled = busy || !state.card;
  }

  async function ensureWritePermission() {
    const opts = { mode: 'readwrite' };
    if ((await state.rootHandle.queryPermission(opts)) === 'granted') return true;
    return (await state.rootHandle.requestPermission(opts)) === 'granted';
  }

  /** Run one rename on the card, then re-read the card. Returns true on success. */
  /**
   * Run one change on the card with the busy screen, then re-read the card.
   * Returns the operation's result, or null if it failed (the error is shown).
   */
  async function runOp(title, op, keepOk, keepFail) {
    if (busy) return null;
    busy = true; renderEditState();
    player.stop();
    mix.unload();
    const log = [];
    let result = null, ok = false;
    showBusy(`${title}…`);
    try {
      if (!(await ensureWritePermission())) throw new Error('No permission to write to the card.');
      await window.CardIO.probeWritable(state.cardRoot); // a locked or read-only card stops here, before anything changes
      let lastUi = 0;
      result = await op((m) => log.push(m), (done, total, what) => {
        const now = performance.now();
        if (now - lastUi < 150) return;
        lastUi = now;
        showBusy(`${title}: ${what} (${Math.round(100 * done / total)}%)`);
      });
      console.info(`[${title}]\n` + log.join('\n'));
      ok = true;
    } catch (err) {
      console.warn(`[${title} failed]\n` + log.join('\n'), err);
      const raw = err.message || String(err);
      const msg = window.CardIO.isReadOnly(err) && !(err instanceof window.CardIO.CardError) ? `${window.CardIO.READ_ONLY_CARD}\n\n(${raw})`
        : /Failed to execute '[a-zA-Z]+' on '[a-zA-Z]+'\s*$/.test(raw) || /Failed to execute '[a-zA-Z]+' on '[a-zA-Z]+':?\s*$/.test(raw) ? `${raw}: ${err.name || 'unknown error'}. The browser gave no reason; nothing was changed. If this keeps happening, run "Check card" and check that the card is not locked or read-only.`
        : raw;
      alertBox(`${title} failed`, msg);
    } finally {
      busy = false;
      hideBusy();
      await rescan(ok ? keepOk : keepFail);
    }
    return ok ? (result || true) : null;
  }

  async function doRename(from, to, label) {
    const ok = await runOp(`${label} "${from}" → "${to}"`, (log, progress) => window.CardIO.renameSong(state.cardRoot, state.card, from, to, log, progress), to, from);
    if (ok && state.card.meta && state.card.meta[from]) await saveMeta(from, null, to); // the song info follows the new name
    return ok;
  }

  // History entries: { kind: 'rename', from, to } or { kind: 'copy', folder, srcId, dstId, backup }
  function describe(h) {
    if (h.kind === 'copy') return `copy ${h.srcId} → ${h.dstId} in "${h.folder}"`;
    if (h.kind === 'clear') return `clear ${h.ids.join(', ')} in "${h.folder}"`;
    if (h.kind === 'swap') return `swap ${h.aId} ⇄ ${h.bId} in "${h.folder}"`;
    if (h.kind === 'import') return `import onto ${h.dstId} in "${h.folder}"`;
    if (h.kind === 'export') return `export ${h.files.map((f) => f.name).join(', ')}`;
    if (h.kind === 'meta') return `song info of "${h.folder}"`;
    if (h.kind === 'mix') return `reset mix of "${h.folder}"`;
    if (h.kind === 'newsong') return `new song "${h.folder}" with ${h.label.replace(/^MUSIC\//, '')}`;
    if (h.kind === 'protect') return `${h.on ? 'protect' : 'unprotect'} "${h.folder}"`;
    if (h.kind === 'dup') return `duplicate "${h.from}" → "${h.to}"`;
    if (h.kind === 'trim') return `trim of "${h.folder}"`;
    return `rename "${h.from}" → "${h.to}"`;
  }
  // a rename changes the folder name that copy entries refer to
  function followRename(from, to) {
    for (const h of [...history.undo, ...history.redo]) if (h.folder === from) h.folder = to;
  }

  async function applyEntry(h, direction) {
    if (h.kind === 'trim') {
      return !!(await runOp(`${direction === 'undo' ? 'Undo: putting back the untrimmed' : 'Redo: trimming'} "${h.folder}"`,
        (log) => window.CardIO.swapTrim(state.cardRoot, h, direction, log), h.folder, h.folder));
    }
    if (h.kind === 'meta') {
      const ok = await saveMeta(h.folder, direction === 'undo' ? h.before : h.after);
      if (ok && h.click) await setClick(h.folder, direction === 'undo' ? h.click.from : h.click.to);
      return ok;
    }
    if (h.kind === 'mix') {
      const ok = await writeMix(h.folder, direction === 'undo' ? h.before : h.after);
      if (ok && state.selected) { loadSongMix(state.selected); renderMixer(); renderFx(); updateMixHint(); }
      return ok;
    }
    if (h.kind === 'newsong') {
      if (direction === 'redo') return createAndImport(h);
      return !!(await runOp(`Undo: removing the new song "${h.folder}"`, (log) => window.CardIO.removeSong(state.cardRoot, h.folder, h.files, log), h.from, h.folder));
    }
    if (h.kind === 'protect') {
      const on = direction === 'undo' ? !h.on : h.on;
      return !!(await runOp(`${direction === 'undo' ? 'Undo' : 'Redo'}: ${on ? 'protecting' : 'unprotecting'} "${h.folder}"`,
        (log) => window.CardIO.setProtected(state.cardRoot, state.card, h.folder, on, log), h.folder, h.folder));
    }
    if (h.kind === 'dup') {
      if (direction === 'undo') {
        const ok = !!(await runOp(`Undo: removing the copy "${h.to}"`, (log) => window.CardIO.removeSong(state.cardRoot, h.to, h.files, log), h.from, h.to));
        if (ok && Object.keys(metaOf(h.to)).length) await saveMeta(h.to, null);
        return ok;
      }
      const r = await runOp(`Redo: duplicating "${h.from}" → "${h.to}"`, (log, progress) => window.CardIO.duplicateSong(state.cardRoot, state.card, h.from, h.to, log, progress), h.to, h.from);
      if (r && Object.keys(metaOf(h.from)).length) await saveMeta(h.to, { ...metaOf(h.from) });
      return !!r;
    }
    if (h.kind === 'rename') {
      const [from, to] = direction === 'undo' ? [h.to, h.from] : [h.from, h.to];
      const ok = await doRename(from, to, direction === 'undo' ? 'Undo:' : 'Redo:');
      if (ok) followRename(from, to);
      return !!ok;
    }
    if (h.kind === 'swap') {
      return !!(await runOp(`${direction === 'undo' ? 'Undo' : 'Redo'}: swapping ${h.aId} ⇄ ${h.bId} in "${h.folder}"`,
        (log, progress) => window.CardIO.swapTracks(state.cardRoot, state.card, h.folder, h.aId, h.bId, log, progress), h.folder, h.folder));
    }
    if (h.kind === 'import') {
      if (direction === 'undo') {
        return !!(await runOp(`Undo: emptying ${h.dstId} in "${h.folder}"`,
          (log, progress) => window.CardIO.restoreTracks(state.cardRoot, state.card, h.folder, h.backup, log, progress), h.folder, h.folder));
      }
      const ri = await runOp(`Redo: importing onto ${h.dstId} in "${h.folder}"`,
        (log, progress) => window.CardIO.importTrack(state.cardRoot, state.card, h.folder, h.file, h.dstId, log, progress, { gainDb: h.gainDb }), h.folder, h.folder);
      if (ri) h.backup = ri.backup;
      return !!ri;
    }
    if (h.kind === 'export') {
      if (direction === 'undo') {
        return !!(await runOp(`Undo: export of "${h.folder}"`, () => window.CardIO.restoreExport(state.cardRoot, h.files), h.folder, h.folder));
      }
      const rx = await runOp(`Redo: exporting "${h.folder}"`,
        (log, progress) => window.CardIO.exportMixToCard(state.cardRoot, state.card, h.folder, log, progress), h.folder, h.folder);
      if (rx) h.files = rx.files;
      return !!rx;
    }
    if (h.kind === 'clear') {
      if (direction === 'undo') {
        return !!(await runOp(`Undo: putting ${h.ids.join(', ')} back in "${h.folder}"`,
          (log, progress) => window.CardIO.restoreTracks(state.cardRoot, state.card, h.folder, h.backup, log, progress), h.folder, h.folder));
      }
      const rc = await runOp(`Redo: clearing ${h.ids.join(', ')} in "${h.folder}"`,
        (log, progress) => window.CardIO.clearTracks(state.cardRoot, state.card, h.folder, h.ids, log, progress), h.folder, h.folder);
      if (rc) h.backup = rc.backup;
      return !!rc;
    }
    if (direction === 'undo') {
      return !!(await runOp(`Undo: putting the old ${h.dstId} back in "${h.folder}"`,
        (log, progress) => window.CardIO.restoreTracks(state.cardRoot, state.card, h.folder, h.backup, log, progress), h.folder, h.folder));
    }
    const r = await runOp(`Redo: copying ${h.srcId} → ${h.dstId} in "${h.folder}"`,
      (log, progress) => window.CardIO.copyTracks(state.cardRoot, state.card, h.folder, h.srcId, h.dstId, log, progress), h.folder, h.folder);
    if (r) h.backup = r.backup;
    return !!r;
  }

  /** New song + import as one step; if the import fails, the new song is removed again. */
  async function createAndImport(h) {
    const c = await runOp(`Creating the song "${h.folder}"`,
      (log) => window.CardIO.createSong(state.cardRoot, state.card, h.folder, h.template, log), h.folder, h.from);
    if (!c) return false;
    h.files = c.files;
    const r = await runOp(`Importing ${h.label.replace(/^MUSIC\//, '')} → ${h.dstId} in "${h.folder}"`,
      (log, progress) => window.CardIO.importTrack(state.cardRoot, state.card, h.folder, h.file, h.dstId, log, progress, { gainDb: h.gainDb }), h.folder, h.folder);
    if (!r) {
      await runOp(`Removing the new song "${h.folder}" again`, (log) => window.CardIO.removeSong(state.cardRoot, h.folder, h.files, log), h.from, h.folder);
      return false;
    }
    return true;
  }

  async function toggleProtect() {
    const s = state.selected;
    const on = !(s.sys && s.sys.protected);
    const r = await runOp(`${on ? 'Protecting' : 'Unprotecting'} "${s.folder}"`,
      (log) => window.CardIO.setProtected(state.cardRoot, state.card, s.folder, on, log), s.folder, s.folder);
    if (r && r.changed) {
      pushHistory({ kind: 'protect', folder: s.folder, on });
      toast(on ? `"${s.folder}" is protected. Nothing can change it until you unprotect it.` : `"${s.folder}" can be changed again.`);
    }
  }

  function pushHistory(entry) {
    history.undo.push(entry);
    history.redo.length = 0;
    renderEditState();
  }

  // rename dialog
  const dlg = $('renameDlg');
  $('songInfo').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled || !state.selected) return;
    if (btn.id === 'tracksBtn') return openTracksDialog();
    if (btn.id === 'clearBtn') return openClearDialog();
    if (btn.id === 'trimBtn') return startTrim();
    if (btn.id === 'importBtn') return openImportDialog();
    if (btn.id === 'exportBtn') return openExportDialog();
    if (btn.id === 'protectBtn') return toggleProtect();
    if (btn.id === 'dupBtn') return duplicateSelected();
    if (btn.id === 'deleteBtn') return openDeleteDialog();
  });

  // rename: click the song's title to edit it in place
  $('songInfo').addEventListener('click', (e) => {
    const t = e.target.closest('#songTitle.editable');
    if (!t || t.isContentEditable || busy) return;
    t.contentEditable = 'plaintext-only';
    t.classList.add('editing');
    t.focus();
    document.getSelection().selectAllChildren(t);
  });
  function titleCheck(t) {
    const name = t.textContent;
    const v = M.validateSongName(name, state.card.songs, state.selected.folder);
    const box = $('titleErrors');
    const msgs = name === state.selected.folder ? [] : v.errors;
    box.hidden = !msgs.length;
    box.textContent = msgs.join(' ');
    t.classList.toggle('invalid', !!msgs.length);
    return v;
  }
  function endTitleEdit(t, restore) {
    t.contentEditable = 'false';
    t.classList.remove('editing', 'invalid');
    if (restore) t.textContent = state.selected.folder;
    $('titleErrors').hidden = true;
  }
  $('songInfo').addEventListener('input', (e) => { if (e.target.id === 'songTitle') titleCheck(e.target); });
  $('songInfo').addEventListener('keydown', async (e) => {
    const t = e.target;
    if (t.id !== 'songTitle' || !t.isContentEditable) return;
    if (e.key === 'Escape') { e.preventDefault(); endTitleEdit(t, true); t.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const to = t.textContent; // leading/trailing spaces are caught by the name rules
    if (to === state.selected.folder) { endTitleEdit(t, true); t.blur(); return; }
    if (!titleCheck(t).ok) return;
    if (!backupConfirmed) { endTitleEdit(t, true); openRenameDialog(to); return; } // first time: confirm the backup once
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); endTitleEdit(t, true); return; }
    endTitleEdit(t, false);
    await renameTo(state.selected.folder, to);
  });
  $('songInfo').addEventListener('focusout', (e) => { const t = e.target; if (t.id === 'songTitle' && t.isContentEditable) endTitleEdit(t, true); });
  async function renameTo(from, to) {
    if (await doRename(from, to, 'Renaming')) {
      followRename(from, to);
      pushHistory({ kind: 'rename', from, to });
      toast(`Renamed "${from}" → "${to}". Undo with ↶.`);
    } else renderInfo();
  }
  function openRenameDialog(name) {
    $('renameInput').value = name || state.selected.folder;
    $('renameInput').maxLength = 40; // let people type, then explain the 11-char limit
    $('backupRow').hidden = backupConfirmed;
    $('backupCheck').checked = backupConfirmed;
    validateRename();
    dlg.showModal();
    $('renameInput').select();
  }

  function validateRename() {
    const s = state.selected;
    const name = $('renameInput').value;
    const v = M.validateSongName(name, state.card.songs, s.folder);
    const notes = [];
    if (v.caseOnly) notes.push('Only upper/lower case changes. The Model 12 refuses this ("File Error"), so the app does it in two steps.');
    if (s.isCurrent) notes.push('This is the current song on the Model 12. Its name in the card settings is updated too.');
    notes.push('Like on the unit, the mixdown in MUSIC keeps its old name.');
    $('renameCount').textContent = `${name.length}/${M.NAME_MAX}`;
    $('renameCount').classList.toggle('over', name.length > M.NAME_MAX);
    $('renameErrors').innerHTML = v.errors.map((e) => `<li>${esc(e)}</li>`).join('');
    $('renameNotes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    $('renameOk').disabled = !v.ok || !$('backupCheck').checked;
    return v;
  }
  $('renameInput').addEventListener('input', validateRename);
  $('backupCheck').addEventListener('change', validateRename);
  $('renameCancel').addEventListener('click', () => dlg.close());
  $('renameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = validateRename();
    if (!v.ok) return;
    // ask for write permission straight away, while the click still counts as a user action
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    backupConfirmed = true;
    dlg.close();
    await renameTo(state.selected.folder, $('renameInput').value);
  });

  // duplicate: a full, verified copy of the song (and its settings) under a new name
  async function duplicateSelected() {
    const s = state.selected, from = s.folder;
    const to = M.duplicateName(from, state.card.songs);
    if (!to) { alertBox('No free name', `Couldn't find a free name for a copy of "${from}".`); return; }
    const go = await choose('Duplicate song',
      `This makes a complete copy of "${from}" on the card, called "${to}": all 12 tracks, the song's own settings on the Model 12 (marks, click tempo) and its song info and mix in this app.\n\n`
      + `Edit, swap, clear or record over the copy as much as you like: the original stays exactly as it is, so nothing gets lost.\n\n`
      + `The copy takes ${mb(s.totalBytes)} on the card.${s.sys && s.sys.protected ? ' The copy is not protected, so you can edit it.' : ''}`,
      [{ label: 'Cancel', value: false }, { label: `Duplicate as "${to}"`, value: true, primary: true }]);
    if (!go) return;
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    const r = await runOp(`Duplicating "${from}" → "${to}"`, (log, progress) => window.CardIO.duplicateSong(state.cardRoot, state.card, from, to, log, progress), to, from);
    if (!r) return;
    const sec = metaOf(from);
    if (Object.keys(sec).length) await saveMeta(to, { ...sec });
    pushHistory({ kind: 'dup', from, to, files: r.files });
    toast(`Duplicated "${from}" as "${to}". Undo with ↶ removes the copy.`);
  }

  // delete a song: no undo, so it asks you to type DELETE
  function openDeleteDialog() {
    const s = state.selected;
    const others = state.card.songs.filter((x) => x !== s);
    const music = state.card.music.filter((m) => m.path.replace(/^MUSIC\//, '').toUpperCase().startsWith(s.folder.toUpperCase() + '_')).length;
    $('delMsg').innerHTML = `This deletes <b>${esc(s.folder)}</b> from the card: all 12 tracks (${mb(s.totalBytes)}), its settings on the Model 12 and its song info and mix in this app.`
      + `<br><br><b>This can't be undone</b>; ↶ won't bring it back. Make sure you have a copy if you might need it again.`
      + (music ? `<br><br>Its mixdown${music > 1 ? 's' : ''} in MUSIC stay${music > 1 ? '' : 's'} on the card.` : '')
      + (s.isCurrent && others.length ? `<br><br>It is the current song on the Model 12; the unit will open <b>${esc(nextCurrentAfter(s).folder)}</b> instead.` : '');
    $('delConfirm').value = '';
    $('delOk').disabled = true;
    $('deleteDlg').showModal();
    $('delConfirm').focus();
  }
  /** After deleting the current song, the unit opens the newest remaining song. */
  function nextCurrentAfter(s) {
    const others = state.card.songs.filter((x) => x !== s);
    const t = (x) => (x.sys && x.sys.created ? x.sys.created.getTime() : 0);
    return others.sort((a, b) => t(b) - t(a))[0] || null;
  }
  $('delConfirm').addEventListener('input', () => { $('delOk').disabled = $('delConfirm').value.trim() !== 'DELETE'; });
  $('delCancel').addEventListener('click', () => $('deleteDlg').close());
  $('deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('delConfirm').value.trim() !== 'DELETE') return;
    $('deleteDlg').close();
    const s = state.selected, name = s.folder;
    const next = s.isCurrent ? nextCurrentAfter(s) : null;
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    const r = await runOp(`Deleting "${name}"`, (log) => window.CardIO.deleteSong(state.cardRoot, state.card, name, next && next.folder, log), next ? next.folder : null, null);
    if (!r) return;
    if (Object.keys(metaOf(name)).length) await saveMeta(name, null);
    // the deleted song can't come back, so undo/redo entries that point at it are dropped
    const touches = (h) => [h.folder, h.from, h.to].includes(name);
    history.undo = history.undo.filter((h) => !touches(h)); history.redo = history.redo.filter((h) => !touches(h));
    renderEditState();
    toast(`Deleted "${name}" (${r.files} files).`);
  });

  // copy tracks dialog (e.g. 11/12 onto 7/8)
  const tdlg = $('tracksDlg');
  function openTracksDialog() {
    const opts = window.CardIO.CHANNELS.map((c) => `<option value="${c.id}">${channelLabel(c)}</option>`).join('');
    $('trkSrc').innerHTML = opts;
    $('trkDst').innerHTML = opts;
    $('trkSrc').value = '11/12';
    $('trkDst').value = '7/8';
    tdlg.querySelector('input[name="trkMode"][value="swap"]').checked = true;
    $('trkBackupRow').hidden = backupConfirmed;
    $('trkBackupCheck').checked = backupConfirmed;
    validateTracks();
    tdlg.showModal();
  }
  const trkMode = () => tdlg.querySelector('input[name="trkMode"]:checked').value;
  function validateTracks() {
    const s = state.selected;
    const src = $('trkSrc').value, dst = $('trkDst').value, mode = trkMode();
    const errors = [], notes = [];
    try { window.CardIO.planCopy(s, src, dst); } catch (err) { errors.push(err.message); }
    const chan = (id) => window.CardIO.CHANNELS.find((c) => c.id === id);
    const isEmpty = (id) => chan(id).tracks.every((n) => !s.tracks[n - 1] || s.tracks[n - 1].empty);
    $('trkArrow').textContent = mode === 'swap' ? '⇄' : '→';
    $('trkSrcLabel').firstChild.textContent = mode === 'swap' ? 'Swap ' : 'Copy ';
    $('trkDstLabel').firstChild.textContent = mode === 'swap' ? 'with ' : 'onto ';
    $('trkOk').textContent = mode === 'swap' ? 'Swap on card' : 'Copy on card';
    if (!errors.length) {
      if (mode === 'swap') {
        notes.push(`${src} and ${dst} trade places, like TRACK SWAP on the Model 12. Nothing is lost; ↶ swaps them back.`);
        if (src === '11/12' || dst === '11/12') notes.push('Tip for a bounce: after swapping, clear the other tracks. Your next mixdown records over 11/12 as usual.');
      } else {
        if (isEmpty(src)) notes.push(`${src} is empty, so ${dst} would become empty too.`);
        notes.push(isEmpty(dst) ? `${dst} is empty now.` : `The audio now on ${dst} is replaced. It's kept until you close the app, so ↶ can put it back.`);
        notes.push(`${src} keeps its audio.`);
      }
    }
    $('trkErrors').innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join('');
    $('trkNotes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    $('trkOk').disabled = !!errors.length || !$('trkBackupCheck').checked;
    return !errors.length;
  }
  $('trkSrc').addEventListener('change', validateTracks);
  $('trkDst').addEventListener('change', validateTracks);
  tdlg.querySelectorAll('input[name="trkMode"]').forEach((r) => r.addEventListener('change', validateTracks));
  $('trkBackupCheck').addEventListener('change', validateTracks);
  $('trkCancel').addEventListener('click', () => tdlg.close());
  $('trkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateTracks()) return;
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    backupConfirmed = true;
    tdlg.close();
    const folder = state.selected.folder, srcId = $('trkSrc').value, dstId = $('trkDst').value;
    if (trkMode() === 'swap') {
      const r = await runOp(`Swapping ${srcId} ⇄ ${dstId} in "${folder}"`,
        (log, progress) => window.CardIO.swapTracks(state.cardRoot, state.card, folder, srcId, dstId, log, progress), folder, folder);
      if (r) { pushHistory({ kind: 'swap', folder, aId: srcId, bId: dstId }); toast(`${srcId} and ${dstId} swapped. Undo with ↶.`); }
      return;
    }
    const r = await runOp(`Copying ${srcId} → ${dstId} in "${folder}"`,
      (log, progress) => window.CardIO.copyTracks(state.cardRoot, state.card, folder, srcId, dstId, log, progress), folder, folder);
    if (r) {
      pushHistory({ kind: 'copy', folder, srcId, dstId, backup: r.backup });
      toast(`${srcId} copied onto ${dstId}. Undo with ↶.`);
    }
  });

  // clear tracks dialog
  const cdlgClear = $('clearDlg');
  function openClearDialog() {
    const s = state.selected;
    $('clrList').innerHTML = window.CardIO.CHANNELS.filter((c) => c.tracks.length === 1).map((c) => {
      const n = c.tracks[0];
      const used = s.tracks[n - 1] && !s.tracks[n - 1].empty;
      const tag = n >= 11 ? 'mix rec' : n >= 7 ? `pair ${n % 2 ? `${n}/${n + 1}` : `${n - 1}/${n}`}` : '';
      return `<label class="clr-item${used ? '' : ' empty'}"><input type="checkbox" value="${c.id}" ${used ? '' : 'disabled'}> ${c.id}${used ? (tag ? ` <small>${tag}</small>` : '') : ' <small>empty</small>'}</label>`;
    }).join('');
    $('clrBackupRow').hidden = backupConfirmed;
    $('clrBackupCheck').checked = backupConfirmed;
    validateClear();
    cdlgClear.showModal();
  }
  const clearChoice = () => [...$('clrList').querySelectorAll('input:checked')].map((i) => i.value);
  function validateClear() {
    const ids = clearChoice();
    const s = state.selected;
    const mb = ids.flatMap((id) => window.CardIO.CHANNELS.find((c) => c.id === id).tracks)
      .reduce((a, n) => a + (s.tracks[n - 1] ? s.tracks[n - 1].size : 0), 0) / 1048576;
    $('clrNotes').innerHTML = ids.length
      ? `<li>Track ${ids.join(', ')} will be emptied, like TRACK CLEAR on the Model 12.</li><li>The old audio (${mb.toFixed(0)} MB) is kept until you close the app, so ↶ can put it back.</li>`
      : '<li>Tick the tracks to empty.</li>';
    $('clrOk').disabled = !ids.length || !$('clrBackupCheck').checked;
  }
  $('clrList').addEventListener('change', validateClear);
  $('clrBackupCheck').addEventListener('change', validateClear);
  $('clrAll').addEventListener('click', () => {
    const keepIds = $('clrKeep').value ? window.CardIO.CHANNELS.find((c) => c.id === $('clrKeep').value).tracks.map(String) : [];
    $('clrList').querySelectorAll('input:not(:disabled)').forEach((i) => { i.checked = !keepIds.includes(i.value); });
    validateClear();
  });
  $('clrCancel').addEventListener('click', () => cdlgClear.close());
  $('clrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = clearChoice();
    if (!ids.length) return;
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    backupConfirmed = true;
    cdlgClear.close();
    const folder = state.selected.folder;
    const r = await runOp(`Clearing ${ids.join(', ')} in "${folder}"`,
      (log, progress) => window.CardIO.clearTracks(state.cardRoot, state.card, folder, ids, log, progress), folder, folder);
    if (r) {
      pushHistory({ kind: 'clear', folder, ids, backup: r.backup });
      toast(`Cleared track ${ids.join(', ')}. Undo with ↶.`);
    }
  });

  // ---------- trim song: set the part to keep on the overview, then cut every track at the same spot ----------
  const trim = { on: false, start: 0, end: 0, total: 0, rate: 0, folder: null };
  const fmtTime = (sec) => { const m = Math.floor(sec / 60), r = sec - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
  function parseTime(txt) {
    const t = String(txt).trim().replace(',', '.');
    const m = /^(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(t);
    return m ? (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]) : null;
  }
  function renderTrim() {
    const bar = $('trimBar');
    bar.hidden = !trim.on;
    if ($('trimBtn')) $('trimBtn').classList.toggle('on', trim.on);
    tmap.setTrim(trim.on ? { start: trim.start / trim.rate, end: trim.end / trim.rate } : null);
    if (!trim.on) return;
    bar.querySelector('.tb-title').textContent = `Trim "${trim.folder}"`;
    if (document.activeElement !== $('trimStart')) { $('trimStart').value = fmtTime(trim.start / trim.rate); $('trimStart').classList.remove('bad'); }
    if (document.activeElement !== $('trimEnd')) { $('trimEnd').value = fmtTime(trim.end / trim.rate); $('trimEnd').classList.remove('bad'); }
    const cutA = trim.start / trim.rate, cutB = (trim.total - trim.end) / trim.rate;
    const nothing = trim.start === 0 && trim.end >= trim.total;
    $('trimInfo').textContent = nothing ? 'Drag the edges in the overview, type the times, or use Find silence.'
      : `Keeps ${fmtTime((trim.end - trim.start) / trim.rate)} · cuts ${cutA.toFixed(2)} s + ${cutB.toFixed(2)} s`;
    $('trimInfo').title = nothing ? '' : `The song becomes ${fmtTime((trim.end - trim.start) / trim.rate)} long (now ${fmtTime(trim.total / trim.rate)}): ${cutA.toFixed(2)} s off the start, ${cutB.toFixed(2)} s off the end`;
    $('trimGo').disabled = nothing || trim.end - trim.start < trim.rate * 0.1;
  }
  function setTrimEdge(which, sec) {
    const f = Math.round(Math.max(0, Math.min(trim.total, sec * trim.rate)));
    const gap = Math.round(trim.rate * 0.1);
    if (which === 'start') trim.start = Math.min(f, trim.end - gap);
    else trim.end = Math.max(f, trim.start + gap);
    trim.start = Math.max(0, trim.start); trim.end = Math.min(trim.total, trim.end);
    renderTrim();
  }
  tmap.ontrim = (which, sec) => setTrimEdge(which, sec);
  async function findSilence() {
    const s = state.selected;
    $('trimInfo').textContent = 'Listening for the first and last sound…';
    $('trimFind').disabled = true;
    try {
      const r = await window.CardIO.findSound(s);
      if (!trim.on || state.selected !== s) return;
      trim.total = r.frames; trim.rate = r.rate;
      if (r.silent) { toast('No sound louder than −60 dBFS on any track: set the edges yourself.'); renderTrim(); return; }
      trim.start = r.start; trim.end = r.end;
      renderTrim();
      if (trim.start === 0 && trim.end >= trim.total) toast('No silence to cut at the start or end.');
    } catch (err) { if (trim.on) $('trimInfo').textContent = `Could not read the tracks: ${err.message || err}`; }
    finally { $('trimFind').disabled = false; }
  }
  function startTrim() {
    const s = state.selected;
    if (!s || !player.duration) return;
    if (trim.on && trim.folder === s.folder) return endTrim();
    const rate = s.sampleRate || player.sampleRate;
    Object.assign(trim, { on: true, folder: s.folder, rate, total: Math.round(player.duration * rate), start: 0 });
    trim.end = trim.total;
    renderTrim();
    findSilence();
  }
  function endTrim() { trim.on = false; renderTrim(); }
  $('trimCancel').addEventListener('click', endTrim);
  $('trimFind').addEventListener('click', findSilence);
  $('trimSetStart').addEventListener('click', () => setTrimEdge('start', player.position));
  $('trimSetEnd').addEventListener('click', () => setTrimEdge('end', player.position));
  for (const [id, which] of [['trimStart', 'start'], ['trimEnd', 'end']]) {
    const inp = $(id);
    const apply = () => { const v = parseTime(inp.value); inp.classList.toggle('bad', v === null); if (v !== null) setTrimEdge(which, v); };
    inp.addEventListener('change', () => { apply(); renderTrim(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); inp.blur(); renderTrim(); } });
    inp.addEventListener('blur', () => renderTrim());
  }
  // [ and ] set the edges at the play position while trimming
  document.addEventListener('keydown', (e) => {
    if (!trim.on || e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
    if (e.key === '[') { e.preventDefault(); setTrimEdge('start', player.position); }
    else if (e.key === ']') { e.preventDefault(); setTrimEdge('end', player.position); }
  });

  const trimDlgEl = $('trimDlg');
  let trimPlan = null;
  $('trimGo').addEventListener('click', async () => {
    const s = state.selected;
    if (!trim.on || !s) return;
    try { trimPlan = await window.CardIO.planTrim(s, trim.start, trim.end); }
    catch (err) { alertBox('Can\'t trim this song', err.message || String(err)); return; }
    const p = trimPlan, sec = (f) => (f / p.rate).toFixed(2);
    const mb = (b) => (b / 1048576).toFixed(0);
    const short = p.items.filter((it) => it.h.frames < p.end);
    const extra = p.items.filter((it) => it.extra > 0);
    const empty = s.tracks.filter((t) => t && t.empty).length;
    $('trimNotes').innerHTML = [
      `<li>Keeps ${fmtTime(p.start / p.rate)} – ${fmtTime(p.end / p.rate)}: <b>${sec(p.start)} s</b> off the start and <b>${sec(p.total - p.end)} s</b> off the end. The song becomes ${fmtTime((p.end - p.start) / p.rate)} long.</li>`,
      `<li>${p.items.length} track${p.items.length === 1 ? '' : 's'} with audio (${p.items.map((it) => 'TR' + String(it.n).padStart(2, '0')).join(', ')}) are cut at exactly the same sample, ${s.bitsPerSample}-bit as recorded.${empty ? ` The ${empty} empty track${empty === 1 ? ' stays' : 's stay'} as ${empty === 1 ? 'it is' : 'they are'}.` : ''}</li>`,
      short.length ? `<li>${short.map((it) => 'TR' + String(it.n).padStart(2, '0')).join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter than the song, so ${short.length === 1 ? 'it ends' : 'they end'} earlier, as before.</li>` : '',
      p.marks ? `<li>Marks: ${p.marks.after === p.marks.before ? `all ${p.marks.before} move with the music` : `${p.marks.after} of ${p.marks.before} move with the music; ${p.marks.before - p.marks.after} in the cut part ${p.marks.before - p.marks.after === 1 ? 'is' : 'are'} removed`}.</li>` : '',
      extra.length ? `<li>${extra.map((it) => 'TR' + String(it.n).padStart(2, '0')).join(', ')} ${extra.length === 1 ? 'has' : 'have'} extra data after the audio that the Model 12 doesn't write; it is left out.</li>` : '',
      `<li>The new tracks are written first (about ${mb(p.newBytes)} MB of free space needed) and checked; only then are they swapped in. The original tracks (${mb(p.oldBytes)} MB) are moved to SETTINGS/${window.CardIO.TRIM_DIR} on the card, so ↶ can put them back. 12card offers to delete them the next time you open the card.</li>`,
    ].join('');
    $('trimBackupRow').hidden = backupConfirmed;
    $('trimBackupCheck').checked = backupConfirmed;
    $('trimOk').disabled = !backupConfirmed;
    trimDlgEl.showModal();
  });
  $('trimBackupCheck').addEventListener('change', () => { $('trimOk').disabled = !$('trimBackupCheck').checked; });
  $('trimDlgCancel').addEventListener('click', () => trimDlgEl.close());
  $('trimForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = trimPlan;
    if (!p || !$('trimBackupCheck').checked) return;
    backupConfirmed = true;
    trimDlgEl.close();
    const folder = state.selected.folder;
    endTrim();
    const r = await runOp(`Trimming "${folder}"`,
      (log, progress) => window.CardIO.trimSong(state.cardRoot, state.card, folder, p.start, p.end, log, progress), folder, folder);
    if (r) {
      pushHistory({ kind: 'trim', folder, stamp: r.stamp, files: r.files, sysOld: r.sysOld, sysNew: r.sysNew });
      toast(`Trimmed "${folder}": ${r.tracks} track${r.tracks === 1 ? '' : 's'} cut${r.marks ? `, marks moved (${r.marks.after} of ${r.marks.before} kept)` : ''}. Undo with ↶.`);
    }
  });

  /** After opening a card: originals kept from earlier trims can be deleted to free the space. */
  async function offerTrimCleanup() {
    if (!state.card || !canEdit() || history.undo.concat(history.redo).some((h) => h.kind === 'trim')) return;
    const root = state.card.root ? state.card.root + '/' : '';
    const re = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${window.Model12.SETTINGS_DIR}/${window.CardIO.TRIM_DIR}/([^/]+)/`, 'i');
    const kept = state.card.entries.filter((e) => re.test(e.path));
    if (!kept.length) return;
    const songs = [...new Set(kept.map((e) => re.exec(e.path)[1].replace(/^\d{8}-\d{6}_/, '')))];
    const mb = kept.reduce((a, e) => a + (e.size || 0), 0) / 1048576;
    const ans = await choose('Originals kept from trimming',
      `The untrimmed tracks of ${songs.map((x) => `"${x}"`).join(', ')} are still on the card (${mb.toFixed(0)} MB, in SETTINGS/${window.CardIO.TRIM_DIR}). They were kept so a trim could be undone; ↶ can't reach them any more after closing 12card.\n\nDelete them to free the space?`,
      [{ label: 'Keep for now', value: false }, { label: 'Delete them', value: true, primary: true }]);
    if (!ans) return;
    await runOp('Deleting the kept originals', () => window.CardIO.deleteTrimBackups(state.cardRoot), state.selected && state.selected.folder, state.selected && state.selected.folder);
  }

  Object.assign(window.app, { history, offerTrimCleanup, trimState: trim });

  // import dialog (like TRACK IMPORT on the unit, plus files from this computer)
  const idlg = $('importDlg');
  const imp = { file: null, info: null, label: '', loud: null };
  const NORM = window.CFG12.mastering.importNormalise; // target level for imported audio
  const intoNew = () => idlg.querySelector('input[name="impInto"]:checked').value === 'new';
  /** The song the import goes into: the selected one, or a not-yet-existing new one (all tracks empty). */
  function importTarget() {
    const s = state.selected;
    if (!intoNew()) return { song: s };
    // settings come from a song at the file's own rate if there is one (no conversion needed), else from this song
    const rate = imp.info && imp.info.sampleRate ? imp.info.sampleRate : s.sampleRate;
    const usable = (x) => x && x.songSys && !x.warnings.length && x.tracks.every(Boolean);
    const tpls = window.CardIO.templatesFor(state.card, rate);
    const tpl = tpls.find((t) => t === s) || tpls[0] || (usable(s) ? s : null) || state.card.songs.find(usable) || null;
    const name = $('impNewName').value;
    const song = { folder: name, name, warnings: [], sys: {}, sampleRate: tpl ? tpl.sampleRate : rate, bitsPerSample: tpl ? tpl.bitsPerSample : s.bitsPerSample, tracks: Array.from({ length: 12 }, () => ({ empty: true })) };
    return { song, tpl, name };
  }
  function suggestSongName(label) {
    const base = (label || 'New song').replace(/^.*\//, '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9 !#$%&'()+,\-;=@[\]^_`{}~]/g, '_').trim() || 'New song';
    const taken = (n) => state.card.songs.some((x) => x.folder.toLowerCase() === n.toLowerCase());
    let n = base.slice(0, 11).trim().replace(/\.+$/, '');
    for (let i = 2; taken(n) && i < 100; i++) n = base.slice(0, 11 - String(i).length - 1).trim() + ' ' + i;
    return n;
  }
  function renderImportTargets(force) {
    const t = importTarget();
    const prev = $('impDst').value;
    $('impDst').innerHTML = window.CardIO.CHANNELS.map((c) => {
      const free = c.tracks.every((n) => t.song.tracks[n - 1] && t.song.tracks[n - 1].empty);
      return `<option value="${c.id}" ${free ? '' : 'disabled'}>${channelLabel(c)}${free ? '' : ' – not empty'}</option>`;
    }).join('');
    if (prev && !$('impDst').querySelector(`option[value="${CSS.escape(prev)}"]:disabled`)) $('impDst').value = prev;
    suggestTarget(force);
  }
  function suggestTarget(force) {
    if (!imp.info) return;
    const { song } = importTarget();
    const cur = window.CardIO.CHANNELS.find((c) => c.id === $('impDst').value);
    if (!force && cur && cur.tracks.length === imp.info.channels && cur.tracks.every((n) => song.tracks[n - 1] && song.tracks[n - 1].empty)) return;
    // stereo into a new song: 7/8 is the natural place to play along with; otherwise the first free fit
    const fit = window.CardIO.CHANNELS.find((c) => c.tracks.length === imp.info.channels && c.tracks.every((n) => song.tracks[n - 1] && song.tracks[n - 1].empty));
    if (fit) $('impDst').value = fit.id;
  }
  function openImportDialog() {
    const s = state.selected;
    $('impMusic').innerHTML = '<option value="">Choose a file in MUSIC…</option>' +
      state.card.music.map((m) => `<option value="${esc(m.path)}">${esc(m.path.replace(/^MUSIC\//, ''))}</option>`).join('');
    imp.file = null; imp.info = null; imp.label = '';
    $('impFile').value = '';
    $('impSongName').textContent = `"${s.folder}"`;
    idlg.querySelector('input[name="impInto"][value="song"]').checked = true;
    $('impNewRow').hidden = true;
    $('impNewName').value = '';
    renderImportTargets();
    $('impBackupRow').hidden = backupConfirmed;
    $('impBackupCheck').checked = backupConfirmed;
    validateImport();
    idlg.showModal();
  }
  async function pickImportSource(file, label) {
    imp.file = file; imp.label = label; imp.info = null; imp.error = null; imp.loud = null;
    $('impNormRow').hidden = true;
    if (file) {
      $('impInfo').textContent = 'Reading the file…';
      $('impOk').disabled = true;
      try { imp.info = await window.CardIO.inspectAudio(file); } catch (err) { imp.error = err.message; }
      if (imp.info && imp.file === file) {
        $('impInfo').textContent = 'Measuring the loudness…';
        try {
          const loud = await window.CardIO.measureLoudness(file, importTarget().song.sampleRate || imp.info.sampleRate || 48000);
          if (imp.file === file) { imp.loud = loud; showNormalise(true); }
        } catch (err) { /* the import itself reports unreadable files */ }
      }
    }
    if (intoNew() && !$('impNewName').dataset.edited) $('impNewName').value = suggestSongName(label);
    renderImportTargets(true);
    validateImport();
  }
  /** The "normalise" option: shows the file's loudness and the level change; ticked when the file is loud. */
  function normaliseGain() {
    return imp.loud ? window.Loudness.normaliseGain(imp.loud, NORM.target, NORM.peakCeiling) : { gainDb: 0 };
  }
  function showNormalise(setDefault) {
    const m = imp.loud;
    if (!m || !isFinite(m.lufs)) { $('impNormRow').hidden = true; $('impNorm').checked = false; return; }
    const g = normaliseGain();
    const loud = m.lufs > NORM.suggestAbove;
    if (setDefault) $('impNorm').checked = loud;
    const db = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
    $('impNormText').innerHTML = `<b>Normalise the level</b> to ${db(NORM.target)} LUFS: ${db(g.gainDb)} dB`
      + `<small>This file: ${db(m.lufs)} LUFS, peaks at ${db(m.peakDb)} dBFS.${loud ? ' That is much louder than tracks recorded on the Model 12.' : ''}`
      + `${g.limitedByPeak ? ` Raised only as far as its peaks allow (${db(NORM.peakCeiling)} dBFS).` : ''}</small>`;
    $('impNormRow').hidden = false;
  }
  $('impMusic').addEventListener('change', async (e) => {
    $('impFile').value = '';
    const m = state.card.music.find((x) => x.path === e.target.value);
    await pickImportSource(m ? await m.getFile() : null, m ? m.path : '');
  });
  $('impFile').addEventListener('change', async (e) => {
    $('impMusic').value = '';
    const f = e.target.files[0];
    await pickImportSource(f || null, f ? f.name : '');
  });
  idlg.addEventListener('change', (e) => {
    if (e.target.name !== 'impInto') return;
    $('impNewRow').hidden = !intoNew();
    if (intoNew() && !$('impNewName').value) { $('impNewName').value = suggestSongName(imp.label); delete $('impNewName').dataset.edited; }
    renderImportTargets(true);
    validateImport();
  });
  $('impNewName').addEventListener('input', () => { $('impNewName').dataset.edited = '1'; validateImport(); });
  function validateImport() {
    const t = importTarget(), s = t.song, info = imp.info;
    const errors = [], notes = [];
    if (imp.error) errors.push(imp.error);
    if (intoNew()) {
      const v = window.Model12.validateSongName(t.name, state.card.songs, null);
      errors.push(...v.errors);
      if (state.card.songs.length >= 100) errors.push('The card already has 100 songs, the Model 12 maximum.');
      if (info && !t.tpl) errors.push('There is no song on the card to copy the settings from. Create one song on the Model 12 first.');
      else if (t.tpl) notes.push(`New song MTR/${t.name || '…'}: 12 empty tracks at ${t.tpl.sampleRate / 1000} kHz / ${t.tpl.bitsPerSample}-bit, settings copied from "${t.tpl.folder}" (click 120, no marks, not protected).`);
    }
    if (info) {
      const parts = [(info.format || 'wav').toUpperCase(), info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels} channels`];
      if (info.sampleRate) parts.push(`${info.sampleRate / 1000} kHz`);
      if (info.bitsPerSample) parts.push(`${info.bitsPerSample}-bit${info.float ? ' float' : ''}`);
      parts.push(mss(info.duration));
      $('impInfo').textContent = parts.join(' · ');
      try { window.CardIO.planImport(s, info, $('impDst').value); } catch (err) { errors.push(err.message); }
      if (!errors.length) {
        if ($('impNorm').checked && imp.loud) notes.push(`The level changes by ${normaliseGain().gainDb.toFixed(1)} dB, so the audio is converted rather than copied exactly.`);
        if (info.sampleRate && info.sampleRate !== s.sampleRate) notes.push(`Converted from ${info.sampleRate / 1000} kHz to ${s.sampleRate / 1000} kHz to match the song. (The Model 12 itself only imports files at the song's rate.)`);
        else if (!info.sampleRate) notes.push(`Decoded at the song's ${s.sampleRate / 1000} kHz.`);
        if (!info.lossless) notes.push(`${info.format.toUpperCase()} is a lossy format: the track is only as good as the file. Use WAV or FLAC for the best quality.`);
        else if (!$('impNorm').checked && info.format !== 'wav' && info.sampleRate === s.sampleRate && info.bitsPerSample <= s.bitsPerSample) notes.push(`${info.format.toUpperCase()} is lossless: the samples arrive exactly as recorded.`);
        if (info.lossless && (info.float || info.bitsPerSample > s.bitsPerSample || (info.format === 'wav' && info.bitsPerSample !== s.bitsPerSample))) notes.push(`Converted to ${s.bitsPerSample}-bit to match the song, like the unit does.`);
        notes.push(intoNew() ? '↶ removes the new song again.' : '↶ empties the track(s) again.');
      }
    } else $('impInfo').textContent = imp.error ? '' : 'No file chosen yet.';
    $('impErrors').innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join('');
    $('impNotes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    $('impOk').disabled = !info || !!errors.length || !$('impBackupCheck').checked;
    return info && !errors.length;
  }
  $('impDst').addEventListener('change', validateImport);
  $('impNorm').addEventListener('change', validateImport);
  $('impBackupCheck').addEventListener('change', validateImport);
  $('impCancel').addEventListener('click', () => idlg.close());
  $('impForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateImport()) return;
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    backupConfirmed = true;
    idlg.close();
    const folder = state.selected.folder, dstId = $('impDst').value, file = imp.file, label = imp.label;
    const gainDb = $('impNorm').checked && imp.loud ? Math.round(normaliseGain().gainDb * 100) / 100 : 0;
    if (intoNew()) {
      const { name, tpl } = importTarget();
      const h = { kind: 'newsong', folder: name, from: folder, template: tpl.folder, dstId, file, label, gainDb };
      if (await createAndImport(h)) {
        pushHistory(h);
        toast(`Created "${name}" with ${label.replace(/^MUSIC\//, '')} on ${dstId}. Undo with ↶ removes the song.`);
      }
      return;
    }
    const r = await runOp(`Importing ${label.replace(/^MUSIC\//, '')} → ${dstId} in "${folder}"`,
      (log, progress) => window.CardIO.importTrack(state.cardRoot, state.card, folder, file, dstId, log, progress, { gainDb }), folder, folder);
    if (r) {
      pushHistory({ kind: 'import', folder, dstId, file, label, backup: r.backup, gainDb });
      toast(`Imported onto ${dstId}${r.resampled && r.fromRate ? ` (converted from ${r.fromRate / 1000} kHz)` : ''}${gainDb ? `, level ${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB` : ''}. Undo with ↶.`);
    }
  });

  // export dialog (like STEREO MIX EXPORT on the unit, or as a download)
  const xdlg = $('exportDlg');
  function openExportDialog() {
    const s = state.selected;
    let files = [], error = '';
    try { files = window.CardIO.exportPlan(s); } catch (err) { error = err.message; }
    const exists = files.filter((f) => state.card.music.some((m) => m.path === 'MUSIC/' + f.name));
    $('expFiles').textContent = files.map((f) => f.name).join(', ');
    $('expErrors').innerHTML = error ? `<li>${esc(error)}</li>` : '';
    const canCard = canEdit() && !error;
    xstate.files = files; xstate.error = error; xstate.canCard = canCard; xstate.song = s;
    $('expCardNote').textContent = !canEdit() ? 'Needs the card opened with editing on.' : exists.length ? `${exists.map((f) => f.name).join(', ')} already exists and will be replaced, like on the unit (↶ puts it back).` : 'Like STEREO MIX EXPORT on the Model 12.';
    const recOk = !error;
    xdlg.querySelector('input[name="expSrc"][value="rec"]').disabled = !recOk;
    xdlg.querySelector(`input[name="expSrc"][value="${recOk ? 'rec' : 'app'}"]`).checked = true;
    xdlg.querySelector(`input[name="expTo"][value="${canCard ? 'card' : 'download'}"]`).checked = true;
    syncExpSrc();
    const m = metaOf(s.folder);
    $('expMeta_title').value = m.title || s.name;
    $('expMeta_artist').value = effective(s.folder, 'artist');
    $('expMeta_genre').value = effective(s.folder, 'genre');
    const rec = s.sys && s.sys.created;
    $('expMeta_year').value = m.year || String(rec ? rec.getFullYear() : new Date().getFullYear());
    $('expMeta_bpm').value = m.bpm || '';
    $('expMeta_description').value = m.description || '';
    try { $('expTrim').checked = localStorage.getItem('tmm.trim') !== '0'; } catch (e) { $('expTrim').checked = true; }
    $('expMeta_comment').value = m.comment || '';
    // artwork: cover.jpg (or .png) in the card root overrides the cover made for the song
    const cov = state.card.coverEntry;
    $('expCoverLabel').querySelector('b').textContent = cov ? `${cov.path.split('/').pop()} from the card` : 'made for this song';
    $('expCoverNone').hidden = !!cov;
    $('expCover').checked = true;
    coverState.bytes = null; coverState.song = s;
    if (cov) cov.getFile().then((f) => showCover(URL.createObjectURL(f))).catch(() => showCover(DEFAULT_COVER));
    else showCover(DEFAULT_COVER);
    $('expMetaSave').disabled = !canEdit();
    $('expMetaSave').checked = canEdit();
    syncExpMeta();
    xdlg.showModal();
  }
  const xstate = { files: [], error: '', canCard: false, song: null };
  const expSrc = () => xdlg.querySelector('input[name="expSrc"]:checked').value;
  // downloads are always FLAC; the card always gets WAV, like the unit's own export
  xdlg.addEventListener('change', (e) => { if (e.target.name === 'expTo') syncExpSrc(); });
  /** The download's file name for the chosen source and format. */
  function downloadName(folder) {
    return expSrc() === 'app' ? `${folder}_MIX_APP.flac` : `${folder}_2-MIX_01.flac`;
  }
  function saveBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  /** Float samples to whole numbers at this bit depth (with gain, clipped at full scale). */
  function toInts(f32, bits, gain) {
    const max = 2 ** (bits - 1) - 1, out = new Int32Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const q = Math.round(f32[i] * gain * (max + 1)); out[i] = q > max ? max : q < -max - 1 ? -max - 1 : q; }
    return out;
  }
  /**
   * Where the music starts and ends: the first and last sample louder than 48 dB below the loudest one
   * (the Model 12's own noise stays below that). Keeps 0.25 s before and 1 s after, for the attack and the tail.
   * Returns [start, end) in samples. Works on floats or whole numbers.
   */
  function soundRange(channels, sampleRate, full = 1) {
    const n = channels[0].length;
    let peak = 0;
    for (const c of channels) for (let i = 0; i < n; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
    if (!peak) return [0, n];
    const thr = Math.max(peak * Math.pow(10, -48 / 20), full * Math.pow(10, -80 / 20));
    let first = n, last = -1;
    for (const c of channels) {
      for (let i = 0; i < first; i++) if (Math.abs(c[i]) > thr) { first = i; break; }
      for (let i = n - 1; i > last; i--) if (Math.abs(c[i]) > thr) { last = i; break; }
    }
    if (last < first) return [0, n];
    return [Math.max(0, first - Math.round(0.25 * sampleRate)), Math.min(n, last + 1 + Math.round(1 * sampleRate))];
  }
  const trimNote = (r, n, sr) => (r[0] > 0 || r[1] < n ? ` · silence trimmed (${(r[0] / sr).toFixed(1)} s at the start, ${((n - r[1]) / sr).toFixed(1)} s at the end)` : '');

  /** The recorded main mix (11/12) as whole-number samples, exactly as on the card. */
  async function mainMixInts(s) {
    const chans = [];
    let info = null;
    for (const i of [10, 11]) {
      const b = new Uint8Array(await (await s.tracks[i].entry.getFile()).arrayBuffer());
      const h = window.Model12.parseWavHeader(b.subarray(0, 65536), b.length);
      info = h;
      const B = h.bitsPerSample / 8, dv = new DataView(b.buffer, b.byteOffset + h.dataOffset), x = new Int32Array(h.frames);
      for (let k = 0, o = 0; k < h.frames; k++, o += B) x[k] = B === 2 ? dv.getInt16(o, true) : (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16));
      chans.push(x);
    }
    const n = Math.min(chans[0].length, chans[1].length);
    return { channels: chans.map((c) => c.subarray(0, n)), sampleRate: info.sampleRate, bitsPerSample: info.bitsPerSample };
  }
  /** Recorded mix (card or download) or my mix (download only): set the file name, choices and errors. */
  function syncExpSrc() {
    const app = expSrc() === 'app';
    const s = xstate.song;
    const cardInput = xdlg.querySelector('input[name="expTo"][value="card"]');
    cardInput.disabled = app || !xstate.canCard;
    if (cardInput.disabled) xdlg.querySelector('input[name="expTo"][value="download"]').checked = true;
    let err = '';
    const download = xdlg.querySelector('input[name="expTo"]:checked').value === 'download';
    if (app) {
      const heard = s.tracks.slice(0, 10).some((t) => t && !t.empty);
      if (!heard) err = 'Tracks 1–10 are empty: there is nothing to mix.';
      $('expFiles').textContent = downloadName(s.folder);
      $('expFileNote').textContent = ' · FLAC, 24-bit · made with the console settings and effect you hear now';
    } else {
      err = xstate.error;
      $('expFiles').textContent = download ? downloadName(s.folder) : xstate.files.map((f) => f.name).join(', ');
      $('expFileNote').textContent = download ? ` · FLAC, ${s.bitsPerSample}-bit, the exact samples of 11/12` : '';
    }
    $('expErrors').innerHTML = err ? `<li>${esc(err)}</li>` : '';
    $('expOk').disabled = !!err;
    if (xdlg.open) syncExpMeta();
  }
  xdlg.addEventListener('change', (e) => { if (e.target.name === 'expSrc') syncExpSrc(); });

  /** A small question with buttons; resolves with the chosen value (or null when closed). */
  function choose(title, msg, buttons) {
    return new Promise((resolve) => {
      const d = $('choiceDlg');
      $('choiceTitle').textContent = title; $('choiceMsg').textContent = msg;
      $('choiceButtons').innerHTML = buttons.map((b, i) => `<button type="button" class="btn${b.primary ? ' primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('');
      $('choiceButtons').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; d.close(); resolve(buttons[+b.dataset.i].value); };
      d.onclose = () => resolve(null);
      d.showModal();
    });
  }
  const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const fmtDb = (v) => (v === -Infinity ? '−∞' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);

  /** Render the console mix and download it (never written to the card). */
  async function exportAppMix(folder, tags) {
    const s = xstate.song;
    showBusy('Mixing…');
    let r;
    try {
      r = await player.renderMix((f, what) => showBusy(`${what}… ${Math.round(100 * f)}%`));
    } catch (err) { hideBusy(); alertBox('Mixing failed', err.message || String(err)); return; }
    let gain = 1, loudNote = '';
    const target = player.mastering.loudness;
    if (target != null) {
      // loudness normalisation (MASTERING → LOUDNESS): gain to the target, a look-ahead limiter keeps the peaks at the ceiling
      showBusy('Setting the loudness…');
      await new Promise((res) => setTimeout(res, 30));
      const n = window.Master.normaliseLoudness(r.left, r.right, r.sampleRate, target, MCFG.loudnessCeiling);
      r.peak = 0;
      for (let k = 0; k < r.left.length; k++) r.peak = Math.max(r.peak, Math.abs(r.left[k]), Math.abs(r.right[k]));
      loudNote = ` · ${fmtDb(n.after)} LUFS (was ${fmtDb(n.before)})${n.limitedDb < -0.1 ? `, limiter up to ${fmtDb(n.limitedDb)} dB` : ''}`;
    }
    hideBusy();
    const peakDb = dbfs(r.peak);
    if (r.peak > 1) {
      const ans = await choose('The mix would clip', `Your mix peaks at ${fmtDb(peakDb)} dBFS, above full scale, so the loudest moments would be cut off.\n\nBring the whole mix down to −1 dBFS? Nothing else changes.`, [
        { label: 'Cancel', value: null }, { label: 'Keep (clips)', value: 'keep' }, { label: 'Lower to −1 dBFS', value: 'lower', primary: true },
      ]);
      if (!ans) return;
      if (ans === 'lower') gain = Math.pow(10, -1 / 20) / r.peak;
    }
    showBusy('Writing the file…');
    try {
      await new Promise((res) => setTimeout(res, 30));
      const name = downloadName(folder);
      let L = r.left, R = r.right, trimmed = '';
      if (tags.trim) {
        const rg = soundRange([L, R], r.sampleRate);
        trimmed = trimNote(rg, L.length, r.sampleRate);
        L = L.subarray(rg[0], rg[1]); R = R.subarray(rg[0], rg[1]);
      }
      const bytes = await window.FLAC.encode({
        channels: [toInts(L, 24, gain), toInts(R, 24, gain)], sampleRate: r.sampleRate, bitsPerSample: 24,
        tags, cover: tags.cover || null, onProgress: (f) => showBusy(`Making the FLAC file… ${Math.round(100 * f)}%`),
      });
      saveBytes(bytes, name, 'audio/flac');
      const finalPeak = dbfs(Math.min(r.peak * gain, 1));
      toast(`Downloaded ${name} · peak ${fmtDb(finalPeak)} dBFS${loudNote}${gain !== 1 ? ' (lowered to avoid clipping)' : ''}${trimmed}.`);
    } catch (err) { alertBox('Export failed', err.message || String(err)); }
    finally { hideBusy(); }
  }

  const DEFAULT_COVER = 'icons/cover.jpg'; // fallback if a cover can't be drawn; a cover.jpg in the card root overrides both
  const coverState = { bytes: null, song: null, timer: 0, run: 0 };
  function showCover(url) {
    const img = $('expCoverImg');
    if (img.dataset.url && img.dataset.url !== url) URL.revokeObjectURL(img.dataset.url);
    if (url.startsWith('blob:')) img.dataset.url = url; else delete img.dataset.url;
    img.src = url;
  }
  /** Draw the song's cover with the info currently in the export dialog (levels are cached per song). */
  async function renderSongCover() {
    if (state.card.coverEntry || !window.Cover || $('expMeta').hidden) return null;
    const run = ++coverState.run, s = coverState.song;
    $('expCoverImg').classList.add('busy');
    try {
      const levels = await window.Cover.songLevels(s);
      const bytes = await window.Cover.makeCover({
        title: $('expMeta_title').value || s.name, artist: $('expMeta_artist').value, year: $('expMeta_year').value, levels,
      });
      if (run !== coverState.run) return coverState.bytes; // a newer draw has started
      coverState.bytes = bytes;
      showCover(URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })));
      return bytes;
    } catch (e) {
      console.warn('cover', e);
      return null;
    } finally { if (run === coverState.run) $('expCoverImg').classList.remove('busy'); }
  }
  function syncExpMeta() {
    $('expMeta').hidden = xdlg.querySelector('input[name="expTo"]:checked').value !== 'download';
    $('expTrimRow').hidden = $('expMeta').hidden; // card exports stay exactly like the unit's
    if (!$('expMeta').hidden && !coverState.bytes) renderSongCover();
  }
  // redraw the cover while the title, artist or year is edited
  ['expMeta_title', 'expMeta_artist', 'expMeta_year'].forEach((id) => $(id).addEventListener('input', () => {
    coverState.bytes = null;
    clearTimeout(coverState.timer);
    coverState.timer = setTimeout(renderSongCover, 250);
  }));
  $('expCoverImg').addEventListener('click', () => { const u = $('expCoverImg').src; if (u) window.open(u, '_blank'); });
  xdlg.addEventListener('change', (e) => { if (e.target.name === 'expTo') syncExpMeta(); });
  $('expCancel').addEventListener('click', () => xdlg.close());
  $('expForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const where = xdlg.querySelector('input[name="expTo"]:checked').value;
    const src = expSrc();
    const folder = state.selected.folder;
    xdlg.close();
    if (where === 'download') {
      const tags = Object.fromEntries(window.Model12.META_FIELDS.map((k) => [k, $('expMeta_' + k).value.trim()]));
      // DATE: the recording date (when the song was made on the Model 12), as long as the year agrees with it
      const rec = state.selected.sys && state.selected.sys.created;
      const iso = rec ? `${rec.getFullYear()}-${String(rec.getMonth() + 1).padStart(2, '0')}-${String(rec.getDate()).padStart(2, '0')}` : '';
      const tagDate = iso && (!tags.year || tags.year === iso.slice(0, 4)) ? iso : tags.year;
      if ($('expMetaSave').checked && canEdit()) {
        const before = { ...metaOf(folder) };
        // the title box is pre-filled with the song name: don't store that as a title
        const toStore = { ...tags, title: tags.title === state.selected.name && !before.title ? '' : tags.title };
        const changed = window.Model12.META_FIELDS.some((k) => (before[k] || '') !== toStore[k]);
        if (changed && (await saveMeta(folder, toStore))) pushHistory({ kind: 'meta', folder, before, after: toStore });
      }
      tags.date = tagDate;
      tags.trim = $('expTrim').checked;
      try { localStorage.setItem('tmm.trim', tags.trim ? '1' : '0'); } catch (err) { /* storage off */ }
      if ($('expCover').checked) {
        const cov = state.card.coverEntry;
        try {
          if (cov) tags.cover = { bytes: new Uint8Array(await (await cov.getFile()).arrayBuffer()), mime: /\.png$/i.test(cov.path) ? 'image/png' : 'image/jpeg' };
          else {
            clearTimeout(coverState.timer);
            const made = coverState.bytes || (await renderSongCover());
            tags.cover = { bytes: made || new Uint8Array(await (await fetch(DEFAULT_COVER)).arrayBuffer()), mime: 'image/jpeg' };
          }
        } catch (e) { toast('The cover image could not be read; exporting without it.'); }
      }
      if (src === 'app') { await exportAppMix(folder, tags); return; }
      showBusy('Making the FLAC file…');
      try {
        const m = await mainMixInts(state.selected);
        let trimmed = '';
        if (tags.trim) {
          const n = m.channels[0].length, rg = soundRange(m.channels, m.sampleRate, 2 ** (m.bitsPerSample - 1));
          trimmed = trimNote(rg, n, m.sampleRate);
          m.channels = m.channels.map((c) => c.subarray(rg[0], rg[1]));   // cut only: the samples that stay are exactly the card's
        }
        const bytes = await window.FLAC.encode(Object.assign(m, { tags, cover: tags.cover || null, onProgress: (f) => showBusy(`Making the FLAC file… ${Math.round(100 * f)}%`) }));
        const name = downloadName(folder);
        saveBytes(bytes, name, 'audio/flac');
        toast(`Downloaded ${name}${trimmed}.`);
      } catch (err) { alertBox('Export failed', err.message || String(err)); }
      finally { hideBusy(); }
      return;
    }
    if (!(await ensureWritePermission())) { alertBox('No permission', 'The browser did not allow writing to the card.'); return; }
    const r = await runOp(`Exporting the stereo mix of "${folder}" to MUSIC`,
      (log, progress) => window.CardIO.exportMixToCard(state.cardRoot, state.card, folder, log, progress), folder, folder);
    if (r) {
      pushHistory({ kind: 'export', folder, files: r.files });
      toast(`Saved ${r.files.map((f) => 'MUSIC/' + f.name).join(', ')}. Undo with ↶.`);
    }
  });

  $('undoBtn').addEventListener('click', async () => {
    const h = history.undo.at(-1);
    if (!h || !(await ensureWritePermission())) return;
    if (await applyEntry(h, 'undo')) {
      history.redo.push(history.undo.pop());
      renderEditState();
      toast(`Undone: ${describe(h)}.`);
    }
  });
  $('redoBtn').addEventListener('click', async () => {
    const h = history.redo.at(-1);
    if (!h || !(await ensureWritePermission())) return;
    if (await applyEntry(h, 'redo')) {
      history.undo.push(history.redo.pop());
      renderEditState();
      toast(`Redone: ${describe(h)}.`);
    }
  });

  // ---------- check card (read every byte) ----------

  let checkAbort = null;
  $('checkBtn').addEventListener('click', async () => {
    if (!state.card || busy) return;
    const cdlg = $('checkDlg');
    $('checkResult').innerHTML = '';
    $('checkBar').style.width = '0%';
    $('checkFile').textContent = 'Starting…';
    $('checkClose').textContent = 'Cancel';
    // ask for write access now (needs the click); without it the write check is skipped
    let canWrite = false;
    if (canEdit() && state.rootHandle) {
      try { canWrite = await ensureWritePermission(); } catch (e) { canWrite = false; }
    }
    cdlg.showModal();
    player.stop();
    busy = true; renderEditState();
    checkAbort = new AbortController();
    const t0 = performance.now();
    let last = 0;
    const res = await window.CardIO.checkAllFiles(state.card.entries, (done, total, path) => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      $('checkBar').style.width = (100 * done / total).toFixed(1) + '%';
      $('checkFile').textContent = `${mb(done)} of ${mb(total)} · ${path}`;
    }, checkAbort.signal);
    let wr = null;
    if (canWrite && !res.aborted) {
      $('checkFile').textContent = 'Checking which files can be changed…';
      wr = await window.CardIO.checkWritable(state.card.entries, state.cardRoot, (i, n, path) => {
        const now = performance.now();
        if (now - last < 100) return;
        last = now;
        $('checkFile').textContent = `Write check ${i} of ${n} · ${path}`;
      });
    }
    busy = false; renderEditState();
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    $('checkBar').style.width = res.aborted ? $('checkBar').style.width : '100%';
    $('checkFile').textContent = res.aborted ? 'Cancelled.' : `Read ${res.files} files, ${mb(res.total)} in ${secs} s.`;
    const issues = M.cardIssues(state.card);
    const items = [
      ...res.bad.map((b) => `<li class="bad">✗ <b>${esc(b.path)}</b>: could not be read (${esc(b.error)})</li>`),
      ...issues.map((i) => `<li class="${i.level === 'error' ? 'bad' : 'warn'}">⚠ ${i.song ? `<b>${esc(i.song)}</b>: ` : ''}${esc(i.msg)}</li>`),
      ...writeItems(wr),
    ];
    $('checkResult').innerHTML = res.aborted ? '' : items.length
      ? `<p>${res.bad.length ? '<b>Some files could not be read. The card may be failing: copy everything off it and stop recording on it.</b>' : 'All files could be read, but there are some things to look at:'}</p><ul>${items.join('')}</ul>`
      : '<p class="good">✓ Every file on the card could be read and the songs look complete.</p>';
    $('checkClose').textContent = 'Close';
  });
  function writeItems(wr) {
    if (!wr) return [];
    if (wr.cardReadOnly) return [`<li class="bad">⚠ ${esc((wr.reason || window.CardIO.READ_ONLY_CARD).replace(', so nothing was changed', ''))}</li>`];
    const out = [];
    const songs = new Map(); const loose = [];
    for (const r of wr.readOnly) { if (r.song) songs.set(r.song, (songs.get(r.song) || 0) + 1); else loose.push(r.path); }
    if (songs.size || loose.length) {
      const list = [...songs].map(([s, n]) => `<b>${esc(s)}</b> (${n} file${n > 1 ? 's' : ''})`).concat(loose.map((p) => `<b>${esc(p)}</b>`)).join(', ');
      out.push(`<li class="warn">⚠ Marked read-only: ${list}. Editing still works (the app writes a new file and replaces the old one), but it is slower. `
        + `This is a file attribute, usually left over from copying the card; it is not the Model 12's song protection. To clear it: `
        + `Linux <code>find /path/to/card -type f -exec chmod u+w {} +</code>, macOS Finder → Get Info → untick Locked, Windows Properties → untick Read-only.</li>`);
    }
    for (const o of wr.other) out.push(`<li class="warn">⚠ <b>${esc(o.path)}</b> could not be opened for writing (${esc(o.error)}).</li>`);
    return out;
  }
  $('checkClose').addEventListener('click', () => {
    if (checkAbort && busy) checkAbort.abort();
    else $('checkDlg').close();
  });

  // ---------- small modal helpers ----------

  // the "working…" screen; if nothing moves for 30 s (a card that dropped off, for instance) it offers a way out
  // instead of leaving a dark window
  const busyWatch = { last: 0, timer: 0 };
  function showBusy(msg) {
    $('busyMsg').textContent = msg; $('busy').hidden = false;
    busyWatch.last = performance.now(); $('busyStuck').hidden = true;
    if (!busyWatch.timer) busyWatch.timer = setInterval(() => {
      if ($('busy').hidden) { clearInterval(busyWatch.timer); busyWatch.timer = 0; return; }
      if (performance.now() - busyWatch.last > 30000) $('busyStuck').hidden = false;
    }, 2000);
  }
  function hideBusy() { $('busy').hidden = true; $('busyStuck').hidden = true; }
  $('busyReload').addEventListener('click', () => location.reload());
  function alertBox(title, msg) {
    $('alertTitle').textContent = title;
    $('alertMsg').textContent = msg;
    $('alertDlg').showModal();
  }
  $('alertOk').addEventListener('click', () => $('alertDlg').close());

  // block closing the tab while something is being written
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

  // show the player display only once everything is loaded and painted (no dark frame while the app window opens)
  (function revealLcd() {
    let shown = false;
    const show = () => { if (shown) return; shown = true; $('lcd').classList.remove('booting'); };
    const whenLoaded = document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => window.addEventListener('load', r, { once: true }));
    Promise.all([whenLoaded, document.fonts ? document.fonts.ready : null])
      .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) // two frames: painted
      .then(show, show);
    setTimeout(show, 4000); // never leave it hidden
  })();

  Object.assign(window.app, { openHandle, rescan, history, showOpenTip, openRenameDialog });

  // ---------- mixer ----------

  // the knob rows come from config/mixer.js; "show" picks one of these built-in displays
  const KNOB_SHOW = { freq: (v) => Math.round(100 * Math.pow(80, v)) + ' Hz' };
  const KNOBS = window.CFG12.mixer.knobs.map((k) => ({ key: k.key, label: k.label, cls: k.class, min: k.min, max: k.max, def: k.default, unit: k.unit, show: KNOB_SHOW[k.show] }));

  function knobTitle(k, v) {
    if (k.show) return `${k.label}: ${k.show(v)}`;
    if (k.unit) return `${k.label}: ${v > 0 ? '+' : ''}${v.toFixed(1)}${k.unit}`;
    if (k.key === 'pan') return `${k.label}: ${Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)}`;
    return `${k.label}: ${Math.round(v * 100)}%`;
  }

  function renderMixer() {
    queueAlign();
    const mixer = $('mixer');
    mixer.className = 'mixer show' + (player.mode === 'main' || mix.active ? ' main-mode' : '');
    updateMixHint();
    mixer.innerHTML = P.STRIPS.map((st) => {
      const set = player.settings[st.id];
      const has = st.tracks.some((i) => player.tracks[i]);
      const knobs = KNOBS.map((k) => {
        const label = k.key === 'pan' && st.stereo ? 'BAL' : k.label;
        return `<div class="knob-wrap"><div class="knob ${k.cls}" tabindex="0" role="slider" data-strip="${st.id}" data-key="${k.key}" data-label="${label}"
          aria-label="${label} ${st.id}"></div><div class="knob-label">${label}</div></div>`;
      }).join('');
      // a strip that can't change what you hear is switched off: in Main mix (the recording plays as it is) and for empty tracks
      const off = player.mode === 'main' || mix.active || !has;
      const why = player.mode === 'main' || mix.active ? 'Main mix plays the recording on 11/12 as it is: the console is off. Switch to Multitrack to mix.' : !has ? 'Empty track: nothing to mix' : st.mixRec ? 'Tracks 11/12: usually the recorded main mix. Muted at the start so it does not double channels 1–10.' : '';
      return `<div class="strip${has ? '' : ' empty'}${off ? ' off' : ''}${st.mixRec ? ' mixrec' : ''}" data-strip="${st.id}" ${off ? 'inert' : ''} ${why ? `title="${esc(why)}"` : ''}>
        <h3>${st.id}</h3>
        ${knobs}
        <button class="sw mute${set.mute ? ' on' : ''}" data-strip="${st.id}" data-key="mute">MUTE</button>
        <div class="fader-row">
          <div class="fader-wrap"><input class="fader" type="range" min="0" max="1" step="0.001" value="${set.fader}" data-strip="${st.id}" data-key="fader" aria-label="Fader ${st.id}"></div>
          <div class="strip-meter"><i data-meter="${st.id}"></i></div>
        </div>
        <div class="led${has ? ' on' : ''}" title="${has ? 'Track has audio' : 'Empty track'}"></div>
        <button class="sw solo${set.solo ? ' on' : ''}" data-strip="${st.id}" data-key="solo">SOLO</button>
      </div>`;
    }).join('');
    mixer.querySelectorAll('.knob').forEach(updateKnob);
  }

  function knobDef(key) { return KNOBS.find((k) => k.key === key); }

  function updateKnob(el) {
    const k = knobDef(el.dataset.key);
    const v = player.settings[el.dataset.strip][k.key];
    const t = (v - k.min) / (k.max - k.min);
    el.style.setProperty('--rot', (-135 + 270 * t) + 'deg');
    el.setAttribute('aria-valuenow', v.toFixed(2));
    el.setAttribute('aria-valuetext', knobTitle(k, v));
    if (readout.el === el) showReadout(el);
  }

  function setKnob(el, v) {
    const k = knobDef(el.dataset.key);
    v = Math.max(k.min, Math.min(k.max, v));
    if (k.key === 'pan' && Math.abs(v) < 0.03) v = 0; // snap to centre
    player.set(el.dataset.strip, k.key, v);
    updateKnob(el);
    if (k.key === 'fx' || k.key === 'fx2') renderFx();
  }

  // knob dragging (vertical)
  let drag = null;
  $('mixer').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.knob');
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    drag = { el, y: e.clientY, v: player.settings[el.dataset.strip][el.dataset.key] };
  });
  $('mixer').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = knobDef(drag.el.dataset.key);
    const range = k.max - k.min;
    setKnob(drag.el, drag.v + ((drag.y - e.clientY) / (e.shiftKey ? 600 : 150)) * range);
  });
  $('mixer').addEventListener('pointerup', () => (drag = null));
  $('mixer').addEventListener('wheel', (e) => {
    const el = e.target.closest('.knob');
    if (!el) return;
    e.preventDefault();
    const k = knobDef(el.dataset.key);
    setKnob(el, player.settings[el.dataset.strip][k.key] - Math.sign(e.deltaY) * (k.max - k.min) / 40);
  }, { passive: false });
  $('mixer').addEventListener('dblclick', (e) => {
    const el = e.target.closest('.knob');
    if (el) setKnob(el, knobDef(el.dataset.key).def);
  });
  $('mixer').addEventListener('keydown', (e) => {
    const el = e.target.closest('.knob');
    if (!el) return;
    const k = knobDef(el.dataset.key);
    const step = (k.max - k.min) / 40 * (e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0);
    if (step) { e.preventDefault(); setKnob(el, player.settings[el.dataset.strip][k.key] + step); }
  });

  $('mixer').addEventListener('input', (e) => {
    if (e.target.classList.contains('fader')) { player.set(e.target.dataset.strip, 'fader', parseFloat(e.target.value)); showReadout(e.target); }
  });
  $('mixer').addEventListener('click', (e) => {
    const b = e.target.closest('.sw');
    if (!b) return;
    const id = b.dataset.strip, key = b.dataset.key;
    player.set(id, key, !player.settings[id][key]);
    b.classList.toggle('on', player.settings[id][key]);
  });

  // ---------- value display for knobs and faders: a small backlit readout, like a mixing desk's ----------
  const readout = { el: null, busy: false, box: document.createElement('div') };
  readout.box.className = 'readout'; readout.box.hidden = true;
  readout.box.setAttribute('aria-hidden', 'true');
  document.body.appendChild(readout.box);
  const faderDb = (v) => (v <= 0.0005 ? '−∞ dB' : `${(() => { const d = 40 * Math.log10(v / 0.75); return (d > 0.05 ? '+' : d < -0.05 ? '−' : '') + Math.abs(d).toFixed(1); })()} dB`);
  /** What a control is and its value: [name, value]. */
  function readoutText(el) {
    if (el.classList.contains('knob')) {
      const k = knobDef(el.dataset.key), v = player.settings[el.dataset.strip][k.key];
      return [`CH ${el.dataset.strip} · ${el.dataset.label}`, knobTitle(k, v).replace(/^[^:]*:\s*/, '')];
    }
    if (el.dataset.key === 'fader') return [`CH ${el.dataset.strip} · FADER`, faderDb(player.settings[el.dataset.strip].fader)];
    if (el.id === 'masterFader') return ['MAIN', faderDb(player.master.fader)];
    if (el.dataset.fx != null && el.classList.contains('fx-fader')) return [`FX ${+el.dataset.fx + 1} RETURN`, faderDb(player.fxs[+el.dataset.fx].ret)];
    return null;
  }
  function showReadout(el) {
    const t = readoutText(el);
    if (!t) return;
    readout.el = el;
    readout.box.innerHTML = `<small>${esc(t[0])}</small><b>${esc(t[1])}</b>`;
    readout.box.hidden = false;
    const r = el.getBoundingClientRect(), b = readout.box.getBoundingClientRect();
    // knobs: above the knob; faders: next to the fader cap
    let x = r.left + r.width / 2 - b.width / 2, y = r.top - b.height - 8;
    if (el.type === 'range') {
      const v = parseFloat(el.value), cap = r.bottom - v * r.height;   // vertical faders: value 1 is at the top
      x = r.right + 6; y = cap - b.height / 2;
      if (x + b.width > innerWidth - 4) x = r.left - b.width - 6;
    }
    readout.box.style.transform = `translate(${Math.round(Math.max(4, Math.min(innerWidth - b.width - 4, x)))}px, ${Math.round(Math.max(4, y))}px)`;
  }
  function hideReadout(el) { if (readout.busy || (el && readout.el !== el)) return; readout.box.hidden = true; readout.el = null; }
  const readoutTarget = (e) => e.target.closest && e.target.closest('.knob, .fader, #masterFader, .fx-fader');
  document.addEventListener('pointerover', (e) => { const el = readoutTarget(e); if (el && !readout.busy) showReadout(el); });
  document.addEventListener('pointerout', (e) => { const el = readoutTarget(e); if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideReadout(el); });
  // while you turn or slide, it stays up (even when the pointer leaves the control)
  document.addEventListener('pointerdown', (e) => { const el = readoutTarget(e); if (el) { readout.busy = true; showReadout(el); } });
  document.addEventListener('pointerup', (e) => {
    if (!readout.busy) return;
    readout.busy = false;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (!(over && readout.el && readout.el.contains(over))) hideReadout();
  });
  document.addEventListener('focusin', (e) => { const el = readoutTarget(e); if (el) showReadout(el); });
  document.addEventListener('focusout', (e) => { const el = readoutTarget(e); if (el) hideReadout(el); });
  document.addEventListener('wheel', (e) => { const el = readoutTarget(e); if (el) requestAnimationFrame(() => showReadout(el)); }, { passive: true });
  document.addEventListener('scroll', () => { if (readout.el && !readout.busy) hideReadout(); }, true);


  // ---------- effect (FX) ----------

  const FX = window.FX;
  const FXP = ['fx', 'fx2'];                 // element id prefix of FX 1 and FX 2
  const SENDS = ['fx', 'fx2'];               // the channel knob that feeds each effect
  for (const p of FXP) $(p + 'Type').innerHTML = FX.TYPES.map((t, i) => `<option value="${t.id}">${i + 1}. ${esc(t.name)}</option>`).join('');

  function renderFx() {
    renderMastering();
    const st = songTempo(state.selected);
    FXP.forEach((p, n) => {
      const s = player.fxs[n];
      const info = FX.paramInfo(s.type, s.tempo);
      $(p + 'Type').value = s.type;
      $(p + 'ParamLabel').textContent = info.label;
      $(p + 'Param').step = info.steps ? String(1 / info.steps) : '0.001';
      $(p + 'Param').value = s.param;
      $(p + 'ParamValue').textContent = info.show(s.param);
      $(p + 'TempoRow').style.visibility = info.label === 'TIME' ? '' : 'hidden'; // keeps its space, so the box never changes height
      $(p + 'Tempo').value = s.tempo;
      $(p + 'TempoReset').disabled = s.tempoFromSong || !st;
      $(p + 'TempoReset').textContent = st ? `song (${fmtBpm(st)})` : 'song';
      $(p + 'Fader').value = s.ret;
      $(p + 'Mute').classList.toggle('on', s.mute);
      $('fxBox').classList.toggle('dim', player.mode === 'main');
      $('fxBox').inert = player.mode === 'main';   // the effects only work in Multitrack
      $('fxTab' + n).classList.toggle('in-use', window.Player.STRIPS.some((x) => player.settings[x.id][SENDS[n]] > 0.01));
    });
    $('fxBox').classList.toggle('in-use', [0, 1].some((n) => $('fxTab' + n).classList.contains('in-use')));
    showFxTab(fxTab);
  }

  // ---------- mastering on the main output (presets in config/mastering.js) ----------
  const MCFG = window.CFG12.mastering;
  $('mstPreset').innerHTML = '<option value="">Off</option>' + MCFG.presets.map((p) => `<option value="${esc(p.id)}" title="${esc(p.description || '')}">${esc(p.name)}</option>`).join('');
  $('mstLoud').innerHTML = MCFG.loudnessTargets.map((t) => `<option value="${t.lufs == null ? '' : t.lufs}">${esc(t.label)}</option>`).join('');
  function renderMastering() {
    const m = player.mastering;
    const p = m.preset && MCFG.presets.find((x) => x.id === m.preset);
    $('mstPreset').value = p ? p.id : '';
    $('mstAmount').value = m.amount;
    $('mstAmount').disabled = !p;
    $('mstAmountValue').textContent = p ? `${Math.round(m.amount * 100)}%` : '';
    $('mstDesc').textContent = p ? p.description || '' : 'No mastering: the main output as it is.';
    $('mstDesc').title = $('mstDesc').textContent;
    $('mstLoud').value = m.loudness == null ? '' : String(m.loudness);
    $('masterPanel').classList.toggle('in-use', !!p);
  }
  $('mstPreset').addEventListener('change', (e) => { player.setMastering('preset', e.target.value || null); renderMastering(); });
  $('mstAmount').addEventListener('input', (e) => { player.setMastering('amount', parseFloat(e.target.value)); renderMastering(); });
  $('mstLoud').addEventListener('change', (e) => { player.setMastering('loudness', e.target.value === '' ? null : parseFloat(e.target.value)); renderMastering(); });

  // FX 1 and FX 2 share one box with tabs; the open tab is remembered in this browser
  let fxTab = 0;
  try { fxTab = localStorage.getItem('tmm.fxTab') === '1' ? 1 : 0; } catch (e) { /* storage off */ }
  function showFxTab(n) {
    fxTab = n;
    FXP.forEach((p, i) => { $(p + 'Panel').hidden = i !== n; $('fxTab' + i).classList.toggle('active', i === n); $('fxTab' + i).setAttribute('aria-selected', String(i === n)); });
  }
  [0, 1].forEach((n) => $('fxTab' + n).addEventListener('click', () => {
    showFxTab(n);
    try { localStorage.setItem('tmm.fxTab', String(n)); } catch (e) { /* storage off */ }
  }));

  function fxChange(n, key, value) {
    player.setFx(key, value, n);
    if (player.mode === 'main') setMode('multi'); // the effects are only heard in multitrack
    renderFx();
  }
  FXP.forEach((p, n) => {
    $(p + 'Type').addEventListener('change', (e) => fxChange(n, 'type', e.target.value));
    $(p + 'Param').addEventListener('input', (e) => fxChange(n, 'param', parseFloat(e.target.value)));
    $(p + 'Tempo').addEventListener('change', (e) => {
      const v = Math.max(30, Math.min(300, Math.round((parseFloat(e.target.value) || 120) * 10) / 10));
      fxChange(n, 'tempo', v);
    });
    $(p + 'TempoReset').addEventListener('click', () => {
      const t = songTempo(state.selected);
      if (!t) return;
      player.followTempo(t, n);
      renderFx();
    });
    $(p + 'Fader').addEventListener('input', (e) => { fxChange(n, 'ret', parseFloat(e.target.value)); showReadout(e.target); });
    $(p + 'Mute').addEventListener('click', () => fxChange(n, 'mute', !player.fxs[n].mute));
  });

  // ---------- transport ----------

  function setMode(mode) {
    player.setMode(mode);
    tmap.draw();
    renderMixer();
    renderTransport();
    renderFx();
  }
  // the mode buttons also bring you back from a mixdown to the song
  async function chooseMode(mode) {
    if (mix.active && state.selected) await selectSong(state.selected);
    setMode(mode);
  }
  $('modeMain').addEventListener('click', () => chooseMode('main'));
  $('modeMulti').addEventListener('click', () => chooseMode('multi'));

  /** Header above the console: always there, same height, says what you're listening to. */
  function updateMixHint() {
    const v = $('viewBar');
    let ic, title, sub;
    if (mix.active) { ic = 'disc'; title = 'Mixdown'; sub = `${esc(mix.name)} from the MUSIC folder · the console is not in use`; }
    else if (player.mode === 'main') { ic = 'waveform'; title = 'Main mix'; sub = 'The recorded mix on tracks 11/12 · the console is not in use'; }
    else { ic = 'sliders'; title = 'Multitrack'; sub = 'Channels 1–10 through the preview console · 11/12 has its own strip'; }
    const actions = !mix.active && player.mode === 'multi' && state.selected
      ? `<span class="vb-snaps" role="group" aria-label="Snapshots">${[0, 1, 2].map((i) => `<button type="button" class="vb-icon snap" id="snap${i}" data-snap="${i}" aria-label="Snapshot ${i + 1}">${icon('camera')}<i>${i + 1}</i></button>`).join('')}<button type="button" class="vb-icon snap start" id="snapStart" data-snap="start" aria-label="The mix when the song was opened">${icon('flag')}</button></span><span class="vb-mix"><span id="mixSaveIcon" class="vb-icon mix-save idle">${icon('save')}</span>${canEdit() ? `<button type="button" class="vb-icon" id="mixReset" title="Reset the console to the factory settings for this song (↶ undoes it)">${icon('rotateCcw')}</button>` : ''}</span>` : '';
    v.innerHTML = `${icon(ic)}<b>${title}</b><span>${sub}</span>${actions}`;
    if (actions) { setMixState(mixSave.state); renderSnaps(); }
    v.dataset.view = mix.active ? 'mixdown' : player.mode;
  }

  /** Song name on the display: scrolls back and forth when it is wider than the display. */
  function setLcdName(text) {
    const el = $('lcdName');
    if (el.dataset.text !== text) {
      el.dataset.text = text;
      el.innerHTML = `<span class="lcd-scroll">${esc(text)}</span>`;
    }
    fitLcdName();
  }
  function fitLcdName() {
    const el = $('lcdName'), inner = el.firstElementChild;
    if (!inner) return;
    const over = Math.ceil(inner.scrollWidth - el.clientWidth);
    const scroll = over > 2 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('scrolling', over > 2);
    if (inner.__over === (scroll ? over : 0)) return; // same text and width: keep the running scroll
    inner.__over = scroll ? over : 0;
    inner.getAnimations().forEach((x) => x.cancel());
    if (!scroll) return;
    // calm: rest 4 s at the start, glide at 15 px per second, rest 2.5 s at the end, glide back
    const REST_START = 4000, REST_END = 2500, glide = Math.max(1500, (over / 15) * 1000);
    const total = REST_START + glide + REST_END + glide;
    const at = (ms) => ms / total;
    inner.animate([
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(0)', offset: at(REST_START), easing: 'ease-in-out' },
      { transform: `translateX(-${over}px)`, offset: at(REST_START + glide) },
      { transform: `translateX(-${over}px)`, offset: at(REST_START + glide + REST_END), easing: 'ease-in-out' },
      { transform: 'translateX(0)', offset: 1 },
    ], { duration: total, iterations: Infinity });
  }
  window.addEventListener('resize', () => fitLcdName());

  function renderTransport() {
    const s = state.selected;
    const has = mix.active || (!!s && player.totalFrames > 0);
    $('playBtn').disabled = !has;
    $('seek').disabled = !has;
    // the song's title from Song info when there is one, else its name on the card
    const title = s && (metaOf(s.folder).title || '').trim();
    setLcdName(mix.active ? mix.name : s ? title || s.name : '—');
    $('lcdName').title = !mix.active && s && title ? `${title} (MTR/${s.folder})` : '';
    $('lcdMode').textContent = mix.active ? 'MIXDOWN' : !s ? '' : player.mode === 'main' ? 'MAIN MIX' : 'MULTI';
    const fmtSong = mix.active ? null : s;
    $('lcdFmt').textContent = fmtSong && fmtSong.sampleRate ? `${fmtSong.sampleRate / 1000}k/${fmtSong.bitsPerSample}` : mix.active ? 'STEREO' : '';
    $('lcdDur').textContent = hms(T().duration);
    $('modeMain').disabled = !mix.active && !player.hasMainMix();
    $('modeMulti').disabled = !state.selected;
    $('modeMain').classList.toggle('active', !mix.active && player.mode === 'main');
    $('modeMulti').classList.toggle('active', !mix.active && player.mode === 'multi');
    const marks = (!mix.active && s && s.sys && s.sys.marks) || [];
    const dur = player.totalFrames || 1;
    $('markLayer').innerHTML = marks.filter((m) => m < dur).map((m) => `<i style="left:${(m / dur) * 100}%" title="Mark ${hms(m / player.sampleRate)}"></i>`).join('');
    updateTime();
  }

  function updateTime() {
    const t = T();
    const pos = t.position, dur = t.duration;
    $('lcdPos').textContent = hms(pos);
    $('lcdDur').textContent = hms(dur);
    const tag = '';
    $('lcdState').textContent = (!state.selected && !mix.active) ? '■ NO SONG' : (t.playing ? '▶ PLAY' : pos > 0 && pos < dur - 0.05 ? '❚❚ PAUSE' : '■ READY') + tag;
    if ($('playBtn').dataset.state !== String(t.playing)) {
      $('playBtn').dataset.state = String(t.playing);
      $('playBtn').innerHTML = icon(t.playing ? 'pause' : 'play');
      $('playBtn').classList.toggle('playing', !!t.playing);
      $('playBtn').setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
    }
    if (!seeking) $('seek').value = dur ? pos / dur : 0;
  }

  player.onstate = () => updateTime();
  mix.onstate = () => updateTime();

  $('playBtn').addEventListener('click', () => T().toggle());
  // double-click: the two clicks cancel out, then back to the start
  $('playBtn').addEventListener('dblclick', () => { T().seek(0); tmap.tick(true); });
  $('startBtn').addEventListener('click', () => { T().seek(0); tmap.tick(true); });
  $('endBtn').addEventListener('click', () => { const t = T(); t.seek(Math.max(0, t.duration - 0.05)); tmap.tick(true); });
  let seeking = false;
  $('seek').addEventListener('input', () => { seeking = true; $('lcdPos').textContent = hms(parseFloat($('seek').value) * T().duration); });
  $('seek').addEventListener('change', () => { seeking = false; T().seek(parseFloat($('seek').value) * T().duration); });

  function markTimes() {
    const s = state.selected;
    return ((s && s.sys && s.sys.marks) || []).map((m) => m / player.sampleRate);
  }

  // ---------- the overview by keyboard: Home/End, ←/→ 1 s, Shift 10 s, Ctrl (⌘) to the previous/next mark ----------
  $('trackMap').tabIndex = 0;
  $('trackMap').setAttribute('role', 'slider');
  $('trackMap').setAttribute('aria-label', 'Song overview (T): Home, End, arrows to move, Ctrl+arrows to marks');
  // T puts the keyboard on the overview without touching the play position (clicking it would move it); Escape lets go
  document.addEventListener('keydown', (e) => {
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey && !$('trackMap').hidden
      && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && !e.target.isContentEditable && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('trackMap').focus();
    } else if (e.key === 'Escape' && document.activeElement === $('trackMap')) $('trackMap').blur();
  });
  $('trackMap').addEventListener('keydown', (e) => {
    const t = T(), dur = t.duration;
    if (!dur) return;
    const go = (sec) => { t.seek(Math.max(0, Math.min(dur - 0.05, sec))); tmap.tick(true); };
    const marks = markTimes();
    if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(dur);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.ctrlKey || e.metaKey) {
        const pos = t.position;
        const m = dir < 0 ? marks.filter((x) => x < pos - 0.25).pop() : marks.find((x) => x > pos + 0.05);
        go(m != null ? m : dir < 0 ? 0 : dur);
      } else go(t.position + dir * (e.shiftKey ? 10 : 1));
    } else return;
    e.preventDefault();
  });
  $('prevBtn').addEventListener('click', () => {
    if (mix.active) return mix.seek(0);
    const pos = player.position - 1; // small grace so a double tap goes further back
    const prev = markTimes().filter((t) => t < pos).pop();
    player.seek(prev || 0);
  });
  $('nextBtn').addEventListener('click', () => {
    if (mix.active) return;
    const next = markTimes().find((t) => t > player.position + 0.1);
    if (next != null) player.seek(next);
  });

  $('masterFader').addEventListener('input', (e) => { player.setMaster(parseFloat(e.target.value)); showReadout(e.target); });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) && !e.target.isContentEditable && !e.target.classList.contains('knob')) {
      e.preventDefault();
      if (!$('playBtn').disabled) T().toggle();
    }
  });

  // meters + clock
  const level = (p) => Math.max(0, Math.min(1, (20 * Math.log10(p || 1e-6) + 48) / 48)); // -48 dB … 0 dB
  // clipping on the main output: how far over 0 dBFS, held a few seconds; it flashes faster the more it clips
  const clip = { over: 0, last: 0, shown: '' };
  function showClip(m) {
    const now = performance.now();
    const peak = m ? Math.max(m.l, m.r) : 0;
    if (peak > 1) { clip.over = Math.max(clip.over, 20 * Math.log10(peak)); clip.last = now; }
    if (clip.over && now - clip.last > 4000) clip.over = 0;
    const el = $('clipInd');
    const txt = clip.over ? `${clip.over < 0.1 ? '<0.1' : clip.over.toFixed(1)} dB` : '';
    if (txt === clip.shown) return;
    clip.shown = txt;
    el.hidden = !txt;
    if (!txt) return;
    el.innerHTML = `<span>${txt}</span>${icon('alert')}`;
    el.style.setProperty('--blink', Math.max(0.15, Math.min(1.2, 1.2 - clip.over * 0.18)).toFixed(2) + 's');
    el.title = `The main output went ${txt} over 0 dBFS (clipping) in the last few seconds. Lower the MAIN fader or the channels. Click to clear.`;
  }
  $('clipInd').addEventListener('click', () => { clip.over = 0; clip.last = 0; });
  function frame() {
    if (!mix.active) tmap.tick();
    const m = player.meters(mix.playing);
    showClip(m);
    $('meterL').style.height = (m ? level(m.l) * 100 : 0) + '%';
    $('meterR').style.height = (m ? level(m.r) * 100 : 0) + '%';
    document.querySelectorAll('[data-meter]').forEach((el) => {
      el.style.height = (m ? level(m.strips[el.dataset.meter]) * 100 : 0) + '%';
    });
    if (T().playing) updateTime();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- all faders: mouse wheel, double-click to 0 dB, a light and a small snap at 0 dB ----------
  const ZERO_DB = 0.75, SNAP = 0.012, WHEEL_STEP = 0.01; // 75 wheel steps from the bottom land exactly on 0 dB; Shift = 5× faster
  function setFader(el, v) {
    el.value = Math.min(1, Math.max(0, v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function flashZero(el) {
    const w = el.closest('.fader-wrap');
    if (!w) return;
    w.classList.remove('zero-flash');
    void w.offsetWidth; // restart the animation
    w.classList.add('zero-flash');
  }
  let dragging = null;
  document.addEventListener('pointerdown', (e) => { if (e.target instanceof HTMLInputElement && e.target.classList.contains('fader')) dragging = e.target; }, true);
  document.addEventListener('pointerup', () => { dragging = null; }, true);
  // snap and light up while dragging: listen before the mixer's own handlers
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.classList.contains('fader')) return;
    const v = parseFloat(el.value), prev = parseFloat(el.dataset.prev ?? v);
    el.dataset.prev = v;
    if (dragging === el && Math.abs(v - ZERO_DB) < SNAP && v !== ZERO_DB) el.value = ZERO_DB; // snap only while dragging
    const now = parseFloat(el.value);
    if (now === ZERO_DB && prev !== ZERO_DB) flashZero(el);
  }, true);
  document.addEventListener('wheel', (e) => {
    const el = e.target.closest && e.target.closest('.fader-wrap');
    const f = el && el.querySelector('input.fader');
    const d = e.deltaY || e.deltaX; // Shift + wheel can arrive as sideways scrolling
    if (!f || f.disabled || !d) return;
    e.preventDefault();
    const dir = d < 0 ? 1 : -1;
    const v = Math.round(parseFloat(f.value) / WHEEL_STEP) * WHEEL_STEP + dir * WHEEL_STEP * (e.shiftKey ? 5 : 1);
    setFader(f, Math.round(v * 1000) / 1000);
  }, { passive: false });
  document.addEventListener('dblclick', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.classList.contains('fader')) setFader(e.target, ZERO_DB);
  });

  // FX 1, FX 2 and MASTERING sliders: mouse wheel too, 1 % a notch (Shift: 5 %)
  for (const id of ['fxParam', 'fx2Param', 'mstAmount']) {
    $(id).addEventListener('wheel', (e) => {
      const el = e.currentTarget;
      const d = e.deltaY || e.deltaX; // with Shift held, some systems turn the wheel into sideways scrolling
      if (el.disabled || el.closest('[inert]') || !d) return;
      e.preventDefault();
      const step = 0.01 * (e.shiftKey ? 5 : 1) * (d < 0 ? 1 : -1);
      // some effects have steps (e.g. note values for a delay): keep going until the setting really changes
      const was = parseFloat(el.value);
      for (let v = was, k = 0; k < 100; k++) {
        v = Math.min(1, Math.max(0, Math.round((v + step) * 100) / 100));
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (parseFloat(el.value) !== was || v <= 0 || v >= 1) break;
      }
      showReadout(el);
    }, { passive: false });
  }



  // ---------- installable app (PWA) ----------
  // Works when the app is served from https:// or http://localhost, not from a double-clicked file.

  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // show our own button instead of the browser's mini-bar
    installPrompt = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('Installed. You can start it like any other app.'); });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    let waiting = null;
    const offerUpdate = (w) => { waiting = w; $('updateBar').hidden = false; };
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
      // look for a new version when the app regains focus (an installed app can stay open for days)
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch((err) => console.warn('Service worker not registered:', err));

    let updateRequested = false;
    $('updateBtn').addEventListener('click', () => {
      if (busy) { toast('Wait until the card operation has finished.'); return; }
      if (!waiting) return;
      updateRequested = true;
      waiting.postMessage('skipWaiting');
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // only reload for an update the user asked for (the very first install also changes the controller)
      if (!updateRequested || reloading) return;
      reloading = true;
      const go = () => (busy ? setTimeout(go, 500) : location.reload());
      go();
    });
  }

  // ---------- startup ----------

  document.querySelectorAll('[data-icon]').forEach((b) => { b.innerHTML = icon(b.dataset.icon) + (b.textContent.trim() ? `<span>${esc(b.textContent.trim())}</span>` : ''); });
  updateMixHint();

  $('openBtn').addEventListener('click', openCard);
  renderEditState();
  renderFx();

  (function browserNote() {
    const note = $('browserNote');
    if (navigator.brave && !('showDirectoryPicker' in window)) {
      note.innerHTML = 'Brave: reading works as is. To rename songs, turn on <code>brave://flags/#file-system-access-api</code> and restart Brave.';
    } else if (!('showDirectoryPicker' in window)) {
      note.textContent = 'This browser can read the card. Renaming songs needs a Chromium browser such as Chrome, Edge, Vivaldi, or Brave with its file-system-access flag on.';
    }
  })();
})();
