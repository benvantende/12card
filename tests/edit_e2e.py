# End-to-end test of renaming, undo/redo, rollback and "Check card".
# Uses a fake card in the browser's private storage (OPFS), which has the same
# file-handle API as a real folder. Run from the app folder:
#   python3 tests/edit_e2e.py
import asyncio, http.server, threading, functools, sys, os, json
from playwright.async_api import async_playwright

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/usr/bin/google-chrome"

BUILD_CARD = r"""
async () => {
  const fx = async (n) => new Uint8Array(await (await fetch('tests/fixtures/' + n)).arrayBuffer());
  const empty = await fx('empty_track.wav'), songSys = await fx('song.sys'), prot = await fx('song_protected.sys'), cardSys = await fx('tascam_m_TV.sys');
  function wav(seconds, freq) {           // 16-bit mono 44.1k sine
    const n = Math.round(44100 * seconds), b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true);
    d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 44100, true); d.setUint32(28, 88200, true);
    d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.round(8000 * Math.sin(2 * Math.PI * freq * i / 44100)), true);
    return new Uint8Array(b);
  }
  const put = async (dir, name, bytes) => { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(bytes); await w.close(); };
  const opfs = await navigator.storage.getDirectory();
  try { await opfs.removeEntry('card', { recursive: true }); } catch (e) {}
  const card = await opfs.getDirectoryHandle('card', { create: true });
  await put(card, 'tascam_m.sys', cardSys);
  const mtr = await card.getDirectoryHandle('MTR', { create: true });
  for (const d of ['MUSIC', 'UTILITY']) await card.getDirectoryHandle(d, { create: true });
  const songs = { 'TV': [1, 2, 3, 11, 12], 'WANDERING': [1, 2], 'epistem 01': [7, 8], 'PROT': [1] };
  for (const [name, used] of Object.entries(songs)) {
    const dir = await mtr.getDirectoryHandle(name, { create: true });
    for (let t = 1; t <= 12; t++) await put(dir, `01_${name}_TR${String(t).padStart(2, '0')}.wav`, used.includes(t) ? wav(1.5, 110 * t) : empty);
    await put(dir, 'song.sys', name === 'PROT' ? prot : songSys);
    for (let t = 1; t <= 12; t++) await put(dir, `tempTr${t}_A.bin`, new Uint8Array(0));
  }
  window.__card = card;
  await app.openHandle(card);
  return app.state.card.songs.map((s) => s.folder).sort();
}
"""

TREE = r"""
async () => {
  const out = {};
  const mtr = await window.__card.getDirectoryHandle('MTR');
  for await (const [name, d] of mtr.entries()) {
    const files = [];
    for await (const [f, h] of d.entries()) files.push(f + ':' + (await h.getFile()).size);
    out[name] = files.sort();
  }
  const sys = new Uint8Array(await (await (await window.__card.getFileHandle('tascam_m.sys')).getFile()).arrayBuffer());
  out.__current = Model12.parseCardSys(sys).currentSong;
  return out;
}
"""

import re as _re0
re_meta = lambda m: bool(_re0.match(r"\d+:\d\d · [\d.]+ MB · \S", m)) and "tracks" not in m
CFG_NORM = -23  # config/mastering.js importNormalise.target
RJ_ = "async (n) => JSON.parse(await (await (await (await window.__card.getDirectoryHandle('SETTINGS')).getFileHandle(n)).getFile()).text())"

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        check.failed = True
check.failed = False

def song_ok(tree, name, used_sizes=None):
    files = tree.get(name)
    if not files: return False
    tracks = [f for f in files if f.startswith(f"01_{name}_TR")]
    return len(tracks) == 12 and len(files) == 25 and any(f.startswith('song.sys:2048') for f in files)

def make_fixtures():
    """Other formats, made from one known 16-bit 44.1 kHz mono WAV (needs ffmpeg)."""
    import subprocess, struct, math
    fx = os.path.join(APP, "tests", "fixtures", "gen")
    os.makedirs(fx, exist_ok=True)
    n = 44100
    samples = [int(9000 * math.sin(2 * math.pi * 220 * i / 44100) + 3000 * math.sin(2 * math.pi * 1234 * i / 44100)) for i in range(n)]
    data = struct.pack("<%dh" % n, *samples)
    with open(os.path.join(fx, "mono16.wav"), "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 44100, 88200, 2, 16) + b"data" + struct.pack("<I", len(data)) + data)
    run = lambda *a: subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)
    run("-i", os.path.join(fx, "mono16.wav"), "-c:a", "flac", os.path.join(fx, "mono16.flac"))
    run("-f", "lavfi", "-i", "sine=f=330:d=2", "-ac", "2", "-ar", "48000", "-sample_fmt", "s32", "-c:a", "flac", "-bits_per_raw_sample", "24", os.path.join(fx, "stereo24_48k.flac"))
    run("-f", "lavfi", "-i", "sine=f=440:d=2", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", os.path.join(fx, "stereo.mp3"))
    return data

async def main():
    MONO16 = make_fixtures()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 1280, "height": 860})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        # behave like Chrome on a real disk: names starting with "~" are refused
        await pg.add_init_script("""(() => {
          const bad = (n) => typeof n === 'string' && n.startsWith('~');
          const gf = FileSystemDirectoryHandle.prototype.getFileHandle, gd = FileSystemDirectoryHandle.prototype.getDirectoryHandle, mv = FileSystemHandle.prototype.move;
          FileSystemDirectoryHandle.prototype.getFileHandle = function (n, o) { if (o && o.create && bad(n)) return Promise.reject(new TypeError("Name is not allowed.")); return gf.call(this, n, o); };
          FileSystemDirectoryHandle.prototype.getDirectoryHandle = function (n, o) { if (o && o.create && bad(n)) return Promise.reject(new TypeError("Name is not allowed.")); return gd.call(this, n, o); };
          if (mv) FileSystemHandle.prototype.move = function (...a) { if (a.some(bad)) return Promise.reject(new DOMException('', 'InvalidModificationError')); return mv.apply(this, a); };
        })()""")
        await pg.add_init_script("document.addEventListener('DOMContentLoaded', () => { window.__lcdAtStart = document.getElementById('lcd').classList.contains('booting'); })")
        await pg.goto("http://127.0.0.1:8765/index.html")
        await pg.wait_for_function("!document.getElementById('lcd').classList.contains('booting')", timeout=3000)
        check(await pg.evaluate("window.__lcdAtStart === true && getComputedStyle(document.getElementById('lcd')).visibility === 'visible'"), "player display hidden while loading, shown once loaded")
        songs = await pg.evaluate(BUILD_CARD)
        check(songs == ['PROT', 'TV', 'WANDERING', 'epistem 01'], f"fake card opened: {songs}")
        check(await pg.is_hidden("#modeBadge"), "editing works: no badge (it only says Read-only when nothing can be changed)")

        # 1. case-only rename of the current song through the UI
        await pg.click('.song-item[data-folder="TV"]')
        await pg.evaluate("app.openRenameDialog()")
        await pg.fill("#renameInput", "tv")
        notes = await pg.inner_text("#renameNotes")
        check("two steps" in notes and "current song" in notes, "dialog explains case-only + current song")
        check(await pg.is_disabled("#renameOk"), "rename blocked until backup is confirmed")
        await pg.check("#backupCheck")
        await pg.click("#renameOk")
        await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'TV') && app.state.card.songs.some(s => s.folder === 'tv')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "tv") and "TV" not in t and not any(k.startswith("tmmtmp_") for k in t), "TV → tv: folder + 12 tracks renamed, no temp folder left")
        check(t["__current"] == "tv", f"tascam_m.sys current song follows: {t['__current']}")
        check((await pg.inner_text("#songInfo h2")).startswith("tv"), "UI shows renamed song selected")

        # 2. validation
        await pg.click('.song-item[data-folder="WANDERING"]')
        await pg.evaluate("app.openRenameDialog()")
        check(await pg.is_hidden("#backupRow"), "backup question only asked once per session")
        for bad, why in [("EPISTEM 01", "already exists"), ("twelve chars", "11 characters"), ("a/b", "Not allowed")]:
            await pg.fill("#renameInput", bad)
            err = await pg.inner_text("#renameErrors")
            check(why in err and await pg.is_disabled("#renameOk"), f"rejects {bad!r}: {err.strip()[:60]}")
        await pg.fill("#renameInput", "wander 2")
        await pg.click("#renameOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'wander 2')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "wander 2") and "WANDERING" not in t and t["__current"] == "tv", "WANDERING → wander 2, current song untouched")

        # 3. undo / redo
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'WANDERING')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "WANDERING") and "wander 2" not in t, "undo restores WANDERING")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'TV')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "TV") and t["__current"] == "TV", "second undo restores TV (case-only, back through temp) and current song")
        await pg.click("#redoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "tv") and t["__current"] == "tv", "redo works")

        # 4. failure halfway: the 5th file move throws → everything moved back
        await pg.evaluate("""() => {
          const orig = FileSystemFileHandle.prototype.move; let n = 0;
          FileSystemFileHandle.prototype.move = function (...a) { if (++n === 5) { FileSystemFileHandle.prototype.move = orig; return Promise.reject(new Error('simulated card error')); } return orig.apply(this, a); };
        }""")
        await pg.click('.song-item[data-folder="epistem 01"]')
        await pg.evaluate("app.openRenameDialog()")
        await pg.fill("#renameInput", "broken")
        await pg.click("#renameOk")
        await pg.wait_for_selector("#alertDlg[open]")
        msg = await pg.inner_text("#alertMsg")
        check("simulated card error" in msg and "put back" in msg, f"error reported: {msg[:90]}")
        await pg.click("#alertOk")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "epistem 01") and "broken" not in t, "rollback: epistem 01 intact, no half-renamed folder")

        # 5. protected song cannot be renamed
        await pg.click('.song-item[data-folder="PROT"]')
        check(await pg.evaluate("!document.getElementById('songTitle').classList.contains('editable')"), "protected song: the title can't be renamed")

        # 6. check card: all good, then one unreadable file
        await pg.click("#checkBtn")
        await pg.wait_for_function("document.getElementById('checkClose').textContent === 'Close'")
        res = await pg.inner_text("#checkResult")
        check("Every file on the card could be read" in res, f"check card OK: {res.strip()[:70]}")
        await pg.click("#checkClose")
        await pg.evaluate("""() => { const e = app.state.card.entries.find(e => e.path.endsWith('TR02.wav')); e.getFile = async () => { throw new Error('Input/output error'); }; }""")
        await pg.click("#checkBtn")
        await pg.wait_for_function("document.getElementById('checkClose').textContent === 'Close'")
        res = await pg.inner_text("#checkResult")
        check("could not be read" in res and "Input/output error" in res, "check card reports the unreadable file")
        await pg.screenshot(path="/tmp/edit_check.png")
        await pg.click("#checkClose")
        # write check: read-only track files are listed per song, nothing is changed
        before = await pg.evaluate(TREE)
        await pg.evaluate("""() => { window.__cw0 = FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable = function (...a) {
            if (/_TR0[1-3]\\.wav$/.test(this.name)) return Promise.reject(new DOMException('Cannot write to a read-only file.', 'NoModificationAllowedError'));
            return window.__cw0.apply(this, a); }; }""")
        await pg.click("#checkBtn")
        await pg.wait_for_function("document.getElementById('checkClose').textContent === 'Close'")
        res = await pg.inner_text("#checkResult")
        check("Marked read-only" in res and "(3 files)" in res and "chmod u+w" in res, f"check card lists read-only files per song: {res[res.find('Marked'):][:120]}")
        check(await pg.evaluate(TREE) == before, "write check changed nothing on the card")
        await pg.click("#checkClose")
        await pg.evaluate("() => { FileSystemFileHandle.prototype.createWritable = function () { return Promise.reject(new DOMException('Cannot write to a read-only file.', 'NoModificationAllowedError')); }; }")
        await pg.click("#checkBtn")
        await pg.wait_for_function("document.getElementById('checkClose').textContent === 'Close'")
        res = await pg.inner_text("#checkResult")
        check("lock switch" in res and "Marked read-only" not in res, "check card: whole card read-only is reported once")
        await pg.click("#checkClose")
        await pg.evaluate("() => { FileSystemFileHandle.prototype.createWritable = window.__cw0; }")

        # 7. dangling current song is flagged (like today's card)
        await pg.evaluate("""async () => {
          const h = await window.__card.getFileHandle('tascam_m.sys');
          const b = Model12.setCurrentSongName(new Uint8Array(await (await h.getFile()).arrayBuffer()), 'GONE');
          const w = await h.createWritable(); await w.write(b); await w.close();
          await app.rescan();
        }""")
        issues = await pg.evaluate("Model12.cardIssues(app.state.card).map(i => i.msg)")
        check(any("GONE" in i for i in issues), "missing current song is flagged")

        await pg.click('.song-item[data-folder="tv"]')
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "tv mix")
        await pg.screenshot(path="/tmp/edit_dialog.png")
        await pg.click("#renameCancel")

        # 8a. Chrome-like: moves work except for .sys files → song.sys is copied, the rest moved
        HASH = """async (args) => {
          const [folder, file] = args;
          const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle(folder);
          const f = await (await d.getFileHandle(file)).getFile();
          return Array.from(new Uint8Array(await f.arrayBuffer())).reduce((a, b, i) => (a + b * (i % 251 + 1)) % 1000000007, 0);
        }"""
        before_wav = await pg.evaluate(HASH, ["epistem 01", "01_epistem 01_TR07.wav"])
        before_sys = await pg.evaluate(HASH, ["epistem 01", "song.sys"])
        await pg.evaluate("""() => {
          window.__origMove = FileSystemFileHandle.prototype.move;
          window.__refuse = (name) => name.endsWith('.sys');
          FileSystemFileHandle.prototype.move = function (...a) {
            if (window.__refuse(this.name)) return Promise.reject(new DOMException('The implementation did not support the requested type of object or operation.', 'NotSupportedError'));
            return window.__origMove.apply(this, a);
          };
          CardIO.noMove.clear();
        }""")
        await pg.click('.song-item[data-folder="epistem 01"]')
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "Epistem 1")
        await pg.click("#renameOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'Epistem 1')")
        t = await pg.evaluate(TREE)
        ok = song_ok(t, "Epistem 1") and "epistem 01" not in t
        ok = ok and before_wav == await pg.evaluate(HASH, ["Epistem 1", "01_Epistem 1_TR07.wav"])
        ok = ok and before_sys == await pg.evaluate(HASH, ["Epistem 1", "song.sys"])
        check(ok, "Chrome-like (.sys refused): wavs moved, song.sys copied + verified, old folder gone")
        check(await pg.evaluate("[...CardIO.noMove]") == [".sys"], "remembers only .sys as unmovable")

        # 8b. Brave-like: every move refused → everything copied; case-only rename too
        await pg.evaluate("() => { window.__refuse = () => true; CardIO.noMove.clear(); }")
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "epistem 1")
        await pg.click("#renameOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'epistem 1')")
        t = await pg.evaluate(TREE)
        ok = song_ok(t, "epistem 1") and not any(k.startswith("tmmtmp_") for k in t)
        ok = ok and before_wav == await pg.evaluate(HASH, ["epistem 1", "01_epistem 1_TR07.wav"])
        check(ok, "Brave-like (all refused): case-only rename by copying, audio identical")

        # copy fails halfway (card full / write error): copies removed, original intact
        await pg.evaluate("""() => {
          const orig = FileSystemFileHandle.prototype.createWritable; let n = 0;
          FileSystemFileHandle.prototype.createWritable = function (...a) { if (this.name.startsWith('tmmtmp_probe')) return orig.apply(this, a); if (++n === 3) { FileSystemFileHandle.prototype.createWritable = orig; return Promise.reject(new Error('simulated write error')); } return orig.apply(this, a); };
        }""")
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "fail copy")
        await pg.click("#renameOk")
        await pg.wait_for_selector("#alertDlg[open]")
        msg = await pg.inner_text("#alertMsg")
        await pg.click("#alertOk")
        t = await pg.evaluate(TREE)
        check("put back" in msg and song_ok(t, "epistem 1") and "fail copy" not in t, f"copy failure undone: {msg[:80]}")

        # mixed failure: some files moved, then an error → moves undone, copies deleted
        await pg.evaluate("""() => {
          window.__refuse = (name) => name.endsWith('.sys'); CardIO.noMove.clear();
          const orig = FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable = function (...a) { if (this.name.startsWith('tmmtmp_probe')) return orig.apply(this, a); FileSystemFileHandle.prototype.createWritable = orig; return Promise.reject(new Error('simulated write error on song.sys')); };
        }""")
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "mixed")
        await pg.click("#renameOk")
        await pg.wait_for_selector("#alertDlg[open]")
        msg = await pg.inner_text("#alertMsg")
        await pg.click("#alertOk")
        t = await pg.evaluate(TREE)
        check("put back" in msg and song_ok(t, "epistem 1") and "mixed" not in t, "mixed move+copy failure undone completely")

        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'Epistem 1')")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'epistem 01')")
        t = await pg.evaluate(TREE)
        check(song_ok(t, "epistem 01"), "undo restores the original name")
        await pg.evaluate("() => { FileSystemFileHandle.prototype.move = window.__origMove; CardIO.noMove.clear(); }")

        # 9. copy 11/12 onto 7/8, clear everything else, undo both, redo, and a failure halfway
        HASHT = """async (n) => {
          const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv');
          const f = await (await d.getFileHandle('01_tv_TR' + String(n).padStart(2, '0') + '.wav')).getFile();
          const b = new Uint8Array(await f.arrayBuffer());
          return [b.length, Array.from(b).reduce((a, x, i) => (a + x * (i % 251 + 1)) % 1000000007, 0)];
        }"""
        orig = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        await pg.click('.song-item[data-folder="tv"]')
        await pg.wait_for_timeout(300)
        check(await pg.is_visible('.strip[data-strip="11/12"]') and await pg.evaluate("app.player.settings['11/12'].mute"), "11/12 strip shown, muted by default")
        await pg.click("#tracksBtn")
        check(await pg.input_value("#trkSrc") == "11/12" and await pg.input_value("#trkDst") == "7/8", "copy dialog defaults to 11/12 → 7/8")
        await pg.check('input[name="trkMode"][value="copy"]')
        await pg.select_option("#trkDst", "3")
        check(await pg.is_disabled("#trkOk") and "pair" in await pg.inner_text("#trkErrors"), "stereo onto mono refused")
        await pg.select_option("#trkDst", "7/8")
        await pg.click("#trkOk")
        await pg.wait_for_function("app.state.card && app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === false")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        check(now[7] == orig[11] and now[8] == orig[12] and now[11] == orig[11] and now[12] == orig[12], "TR07/08 are byte-identical copies of TR11/12; 11/12 unchanged")

        await pg.click("#clearBtn")
        await pg.select_option("#clrKeep", "7/8")
        await pg.click("#clrAll")
        ticked = await pg.evaluate("[...document.querySelectorAll('#clrList input:checked')].map(i => i.value)")
        check(ticked == ["1", "2", "3", "11", "12"], f"'all except 7/8' ticks the used tracks: {ticked}")
        await pg.click("#clrOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').used === 2")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        hdr = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv');
          const b = new Uint8Array(await (await (await d.getFileHandle('01_tv_TR01.wav')).getFile()).arrayBuffer());
          const h = Model12.parseWavHeader(b, b.length); return [h.frames, h.bitsPerSample, h.sampleRate]; }""")
        check(all(now[n][0] < 6000 for n in (1, 2, 3, 11, 12)) and now[7] == orig[11] and hdr == [0, 16, 44100], f"cleared tracks are valid empty WAVs {hdr}; 7/8 kept")
        check(await pg.evaluate("app.state.card.songs.find(s => s.folder === 'tv').used") == 2, "song now shows 2/12 tracks used")

        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').used === 7")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        check(all(now[n] == orig[n] for n in (1, 2, 3, 11, 12)), "undo clear: all cleared tracks byte-identical to before")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === true")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        check(now == orig, "undo copy: the whole song is byte-identical to the start")
        await pg.click("#redoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === false")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        check(now[7] == orig[11], "redo copy works")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === true")

        # write error on the second track of a copy → first one restored
        await pg.evaluate("""() => {
          const orig = FileSystemFileHandle.prototype.createWritable; let n = 0;
          FileSystemFileHandle.prototype.createWritable = function (...a) { if (++n === 2) { FileSystemFileHandle.prototype.createWritable = orig; return Promise.reject(new Error('simulated write error')); } return orig.apply(this, a); };
        }""")
        await pg.click("#tracksBtn"); await pg.check('input[name="trkMode"][value="copy"]'); await pg.click("#trkOk")
        await pg.wait_for_selector("#alertDlg[open]")
        msg = await pg.inner_text("#alertMsg"); await pg.click("#alertOk")
        now = {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        check("put back" in msg and now == orig, f"copy failure halfway: song unchanged ({msg[:60]})")
        await pg.screenshot(path="/tmp/tracks.png")

        # 10. swap (default), single tracks, import, export
        async def tv_state():
            return {n: await pg.evaluate(HASHT, n) for n in range(1, 13)}
        orig = await tv_state()
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(200)
        await pg.click("#tracksBtn")
        check(await pg.is_checked('input[name="trkMode"][value="swap"]'), "Swap is the default mode")
        opts = await pg.evaluate("[...document.getElementById('trkSrc').options].map(o => o.value)")
        check(opts == ['1','2','3','4','5','6','7','8','7/8','9','10','9/10','11','12','11/12'], f"channel list in manual order: {opts}")
        await pg.select_option("#trkDst", "11"); await pg.select_option("#trkSrc", "11/12")
        check("pair" in await pg.inner_text("#trkErrors"), "pair with single track refused")
        await pg.select_option("#trkSrc", "11"); await pg.select_option("#trkDst", "11/12")
        check(await pg.is_disabled("#trkOk") and await pg.inner_text("#trkErrors") != "", "11 with 11/12 refused")
        await pg.select_option("#trkSrc", "11/12"); await pg.select_option("#trkDst", "7/8")
        await pg.click("#trkOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === false")
        now = await tv_state()
        check(now[7] == orig[11] and now[8] == orig[12] and now[11] == orig[7] and now[12] == orig[8], "swap 11/12 ⇄ 7/8: contents traded")
        names = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv'); const o = []; for await (const k of d.keys()) o.push(k); return o.sort(); }""")
        check(len(names) == 25 and not any(n.startswith('tmmtmp_') for n in names), "no temporary files left after swap")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === true")
        check(await tv_state() == orig, "undo swap: back to the original")
        # single tracks, in no-move mode (like Brave): swap 11 ⇄ 3 by contents
        await pg.evaluate("""() => { window.__origMove2 = FileSystemFileHandle.prototype.move; FileSystemFileHandle.prototype.move = function () { return Promise.reject(new DOMException('nope', 'NotSupportedError')); }; CardIO.noMove.clear(); }""")
        await pg.click("#tracksBtn"); await pg.select_option("#trkSrc", "11"); await pg.select_option("#trkDst", "3"); await pg.click("#trkOk")
        await pg.wait_for_selector("#busy[hidden]", state="attached"); await pg.wait_for_timeout(300)
        now = await tv_state()
        check(now[3] == orig[11] and now[11] == orig[3], "swap single tracks 11 ⇄ 3 by contents (browser refuses moves)")
        await pg.click("#undoBtn"); await pg.wait_for_timeout(800)
        check(await tv_state() == orig, "undo content swap")
        await pg.evaluate("() => { FileSystemFileHandle.prototype.move = window.__origMove2; CardIO.noMove.clear(); }")

        # clear per single track
        await pg.click("#clearBtn")
        items = await pg.evaluate("[...document.querySelectorAll('#clrList input')].map(i => i.value + (i.disabled ? '-' : '+'))")
        check(len(items) == 12 and items[10] == '11+' and items[3] == '4-', f"clear lists 12 single tracks: {items}")
        await pg.check('#clrList input[value="12"]'); await pg.click("#clrOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[11].empty === true")
        now = await tv_state()
        check(now[12][0] < 6000 and now[11] == orig[11], "cleared only track 12")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[11].empty === false")

        # import: stereo 24-bit file → empty pair 9/10 (song is 16-bit → converted); 48 kHz refused; mono onto pair refused
        await pg.evaluate(r"""() => {
          function wav(ch, bits, rate, seconds, fmtTag = 1) {
            const n = Math.round(rate * seconds), bps = bits / 8, b = new ArrayBuffer(44 + n * ch * bps), d = new DataView(b);
            const w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
            w(0, 'RIFF'); d.setUint32(4, 36 + n * ch * bps, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true);
            d.setUint16(20, fmtTag, true); d.setUint16(22, ch, true); d.setUint32(24, rate, true); d.setUint32(28, rate * ch * bps, true);
            d.setUint16(32, ch * bps, true); d.setUint16(34, bits, true); w(36, 'data'); d.setUint32(40, n * ch * bps, true);
            for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
              const v = 0.5 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / rate), o = 44 + (i * ch + c) * bps;
              if (bits === 24) { const x = Math.round(v * 8388607); d.setUint8(o, x & 255); d.setUint8(o + 1, (x >> 8) & 255); d.setUint8(o + 2, (x >> 16) & 255); }
              else d.setInt16(o, Math.round(v * 32767), true);
            }
            return b;
          }
          window.__wavStereo24 = new File([wav(2, 24, 44100, 2)], 'guitar idea.wav', { type: 'audio/wav' });
          window.__wav48 = new File([wav(1, 16, 48000, 1)], 'wrong rate.wav', { type: 'audio/wav' });
        }""")
        await pg.click("#importBtn")
        dst_opts = await pg.evaluate("[...document.getElementById('impDst').options].filter(o => !o.disabled).map(o => o.value)")
        check('9/10' in dst_opts and '1' not in dst_opts, f"only empty targets offered: {dst_opts}")
        await pg.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(window.__wav48); const i = document.getElementById('impFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); }""")
        await pg.wait_for_function("!/Reading|Measuring/.test(document.getElementById('impInfo').textContent)")
        notes48 = await pg.inner_text("#impNotes")
        check("from 48 kHz to 44.1 kHz" in notes48 and not await pg.inner_text("#impErrors"), f"48 kHz file accepted, conversion announced: {notes48[:70]}")
        await pg.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(window.__wavStereo24); const i = document.getElementById('impFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); }""")
        await pg.wait_for_function("!/Reading|Measuring/.test(document.getElementById('impInfo').textContent)")
        check(await pg.is_visible("#impNormRow") and await pg.is_checked("#impNorm") and "LUFS" in await pg.inner_text("#impNormText"), f"a loud file: 'Normalise the level' shown and ticked ({(await pg.inner_text('#impNormText'))[:90]})")
        await pg.evaluate("() => { const c = document.getElementById('impNorm'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); } }")
        info = await pg.inner_text("#impInfo"); dst = await pg.input_value("#impDst")
        check("Stereo" in info and dst == "7/8", f"stereo file: {info}; first empty pair suggested: {dst}")
        await pg.select_option("#impDst", "9/10")
        check("16-bit" in await pg.inner_text("#impNotes"), "conversion to the song's bit depth announced")
        await pg.click("#impOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[8].empty === false")
        hdr = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv'); const r = [];
          for (const n of ['09', '10']) { const b = new Uint8Array(await (await (await d.getFileHandle('01_tv_TR' + n + '.wav')).getFile()).arrayBuffer());
            const h = Model12.parseWavHeader(b, b.length); const v = new DataView(b.buffer).getInt16(h.dataOffset + 2 * 25, true);
            r.push([h.channels, h.bitsPerSample, h.sampleRate, h.frames, h.dataOffset, Model12.findChunk(b, 'bext') ? 'bext' : '-', v]); } return r; }""")
        exp9 = round(0.5 * __import__('math').sin(2 * __import__('math').pi * 440 * 25 / 44100) * 32767)
        exp10 = round(0.5 * __import__('math').sin(2 * __import__('math').pi * 660 * 25 / 44100) * 32767)
        ok = hdr[0][:4] == [1, 16, 44100, 88200] and hdr[1][:4] == [1, 16, 44100, 88200] and abs(hdr[0][6] - exp9) <= 2 and abs(hdr[1][6] - exp10) <= 2
        check(ok, f"imported: left → TR09, right → TR10, mono 16-bit, full length, correct samples {hdr}")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[8].empty === true")
        check(await tv_state() == orig, "undo import: tracks empty again, song as before")
        await pg.click("#redoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[8].empty === false")
        check(True, "redo import works")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[8].empty === true")

        # export to the card's MUSIC folder, then undo
        await pg.click("#exportBtn")
        check(await pg.inner_text("#expFiles") == "tv_2-MIX_01.wav", "export file name like the unit")
        await pg.check('input[name="expTo"][value="card"]'); await pg.click("#expOk")
        await pg.wait_for_function("app.state.card.music.some(m => m.path === 'MUSIC/tv_2-MIX_01.wav')")
        mixok = await pg.evaluate("""async () => {
          const m = await (await window.__card.getDirectoryHandle('MUSIC')).getFileHandle('tv_2-MIX_01.wav');
          const b = new Uint8Array(await (await m.getFile()).arrayBuffer()); const h = Model12.parseWavHeader(b, b.length);
          const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv');
          const L = new Uint8Array(await (await (await d.getFileHandle('01_tv_TR11.wav')).getFile()).arrayBuffer());
          const R = new Uint8Array(await (await (await d.getFileHandle('01_tv_TR12.wav')).getFile()).arrayBuffer());
          const li = Model12.parseWavHeader(L, L.length);
          for (let i = 0; i < li.frames; i++) for (let k = 0; k < 2; k++) {
            if (b[h.dataOffset + 4 * i + k] !== L[li.dataOffset + 2 * i + k]) return 'L differs at ' + i;
            if (b[h.dataOffset + 4 * i + 2 + k] !== R[li.dataOffset + 2 * i + k]) return 'R differs at ' + i;
          }
          return [h.channels, h.bitsPerSample, h.frames === li.frames];
        }""")
        check(mixok == [2, 16, True], f"MUSIC/tv_2-MIX_01.wav = TR11 left, TR12 right, interleaved: {mixok}")
        await pg.click("#undoBtn")
        await pg.wait_for_function("!app.state.card.music.some(m => m.path === 'MUSIC/tv_2-MIX_01.wav')")
        check(True, "undo export removes the new file")
        blobs = await pg.evaluate("CardIO.exportMixBlobs(app.state.card, 'tv').then(f => f.map(x => [x.name, x.blob.size]))")
        check(blobs[0][0] == "tv_2-MIX_01.wav" and blobs[0][1] > 44, f"download export works without writing to the card {blobs}")
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(200)
        check(not await pg.is_disabled("#exportBtn"), "a song without a recorded mix can still be exported (as My mix)")
        await pg.click("#exportBtn")
        check(await pg.is_disabled('input[name="expSrc"][value="rec"]') and await pg.is_checked('input[name="expSrc"][value="app"]') and await pg.is_disabled('input[name="expTo"][value="card"]'), "no recorded mix: My mix chosen, download only")
        await pg.click("#expCancel")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(200)
        await pg.screenshot(path="/tmp/v10.png")

        # 11. read-only situations
        orig = await tv_state()
        await pg.evaluate("""() => { window.__cw = FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable = function () { return Promise.reject(new DOMException('Cannot write to a read-only file.', 'NoModificationAllowedError')); }; }""")
        await pg.click("#tracksBtn"); await pg.check('input[name="trkMode"][value="copy"]'); await pg.click("#trkOk")
        await pg.wait_for_selector("#alertDlg[open]")
        msg = await pg.inner_text("#alertMsg"); await pg.click("#alertOk")
        check("read-only right now" in msg and "lock switch" in msg and await tv_state() == orig, f"read-only card: clear message, nothing changed")
        # only the existing track files are read-only (new files can be written)
        await pg.evaluate("""async () => {
            const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv');
            window.__ro = new Set(); for await (const k of d.keys()) if (/_TR\\d\\d\\.wav$/.test(k)) window.__ro.add(k);
            window.__rm = FileSystemDirectoryHandle.prototype.removeEntry;
            FileSystemDirectoryHandle.prototype.removeEntry = function (n, ...a) { window.__ro.delete(n); return window.__rm.call(this, n, ...a); };
            FileSystemFileHandle.prototype.createWritable = function (...a) {
              if (window.__ro.has(this.name) && !window.__allowRO) return Promise.reject(new DOMException('Cannot write to a read-only file.', 'NoModificationAllowedError'));
              return window.__cw.apply(this, a); }; }""")
        await pg.click("#tracksBtn"); await pg.check('input[name="trkMode"][value="copy"]'); await pg.click("#trkOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === false")
        now = await tv_state()
        names = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv'); const o = []; for await (const k of d.keys()) o.push(k); return o; }""")
        check(now[7] == orig[11] and now[8] == orig[12] and len(names) == 25 and not any(n.startswith('tmmtmp_') for n in names), "read-only track files: copy works by replacing the files, no leftovers")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === true")
        check(await tv_state() == orig, "undo also works with read-only track files")
        # same, in a browser that refuses moves (Brave)
        await pg.evaluate("""() => { window.__mv = FileSystemFileHandle.prototype.move; FileSystemFileHandle.prototype.move = function () { return Promise.reject(new DOMException('nope', 'NotSupportedError')); }; CardIO.noMove.clear(); }""")
        await pg.click("#clearBtn"); await pg.check('#clrList input[value="11"]'); await pg.click("#clrOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[10].empty === true")
        now = await tv_state()
        check(now[11][0] < 6000 and now[12] == orig[12], "read-only file + no moves: clear still works")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[10].empty === false")
        check(await tv_state() == orig, "…and undo")
        # rename refused without a reason (like the error in Chrome): swap falls back to swapping contents
        await pg.evaluate("""() => { FileSystemFileHandle.prototype.move = function () { return Promise.reject(new DOMException('', 'InvalidModificationError')); }; CardIO.noMove.clear(); window.__allowRO = true; }""")
        await pg.click("#tracksBtn"); await pg.select_option("#trkSrc", "11/12"); await pg.select_option("#trkDst", "7/8"); await pg.click("#trkOk")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === false")
        now = await tv_state()
        check(now[7] == orig[11] and now[11] == orig[7], "swap works when renaming is refused without a reason")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'tv').tracks[6].empty === true")
        await pg.evaluate("() => { FileSystemFileHandle.prototype.move = window.__mv; FileSystemFileHandle.prototype.createWritable = window.__cw; FileSystemDirectoryHandle.prototype.removeEntry = window.__rm; CardIO.noMove.clear(); }")
        check(await tv_state() == orig, "song back to the original")
        labels = await pg.evaluate("(async () => { document.getElementById('tracksBtn').click(); await new Promise(r => setTimeout(r, 50)); const o = [...document.getElementById('trkSrc').options].map(o => o.textContent); document.getElementById('trkCancel').click(); return o; })()")
        check(labels[0] == "Track 1" and "Tracks 7/8" in labels and "Tracks 9/10" in labels and labels[-1] == "Master 11/12" and not any("stereo" in l for l in labels), f"dropdown labels: {labels}")
        check(await pg.evaluate("[...document.querySelectorAll('.mode .seg')].map(b => b.id)") == ["modeMulti", "modeMain"], "Multitrack button comes first")
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.click('.song-item[data-folder="tv"]')
        await pg.wait_for_function("app.state.selected.folder === 'tv' && app.player.hasMainMix() && document.getElementById('modeMulti').classList.contains('active')")
        check(await pg.evaluate("app.player.mode === 'multi' && !document.getElementById('modeMain').classList.contains('active') && app.player.hasMainMix()"), "a song with a main mix opens in Multitrack")

        # ===== 2026-11-20 additions =====
        SYSB = """async (f) => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle(f); return [...new Uint8Array(await (await (await d.getFileHandle('song.sys')).getFile()).arrayBuffer())]; }"""
        # status icons instead of words
        await pg.evaluate("""async () => { const h = await window.__card.getFileHandle('tascam_m.sys'); const b = new Uint8Array(await (await h.getFile()).arrayBuffer());
          const nb = Model12.setCurrentSongName(b, 'tv'); const w = await h.createWritable(); await w.write(nb); await w.close(); await app.rescan('tv'); }""")
        tv_item = pg.locator('.song-item[data-folder="tv"]')
        check(await tv_item.locator('.st-current svg').count() == 1 and "current" not in (await tv_item.inner_text()).lower(), "current song: pin icon, no word")
        check(await pg.locator('.st-current').first.get_attribute('title') == "Current song: the last song loaded on the Model 12", "pin icon has a tooltip")
        prot = pg.locator('.song-item[data-folder="PROT"]')
        check(await prot.locator('.st-lock svg').count() == 1, "protected song: lock icon after the name")
        # protect / unprotect in the app
        await pg.click('.song-item[data-folder="WANDERING"]')
        before = await pg.evaluate(SYSB, "WANDERING")
        await pg.click("#protectBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').sys.protected === true")
        after = await pg.evaluate(SYSB, "WANDERING")
        diff = [i for i in range(2048) if before[i] != after[i]]
        check(diff == [0x20] and after[0x20] == 1, f"Protect sets only song.sys byte 0x20: {diff}")
        check(await pg.evaluate("!document.getElementById('songTitle').classList.contains('editable')") and await pg.is_disabled("#clearBtn") and await pg.get_attribute("#protectBtn", "aria-label") == "Unprotect", "protected: editing buttons off, button says Unprotect")
        check(await pg.locator('.song-item[data-folder="WANDERING"] .st-lock').count() == 1 and await pg.locator('.song-head .st-lock').count() == 1, "lock icon in the list and the header")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').sys.protected === false")
        check(await pg.evaluate(SYSB, "WANDERING") == before, "undo protect: song.sys back to the original")
        await pg.click('.song-item[data-folder="PROT"]'); await pg.click("#protectBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'PROT').sys.protected === false")
        check(await pg.evaluate("document.getElementById('songTitle').classList.contains('editable')"), "Unprotect a song protected on the unit: editing possible")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'PROT').sys.protected === true")
        # card bar shows space used
        check(" used" in await pg.inner_text("#cardStatus"), f"card bar shows the space used: {await pg.inner_text('#cardStatus')}")
        # faders: wheel, double-click, 0 dB light
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(600)
        f1 = pg.locator('#mixer .fader[data-strip]').first
        await f1.evaluate("(el) => { el.value = 0.5; el.dispatchEvent(new Event('input', { bubbles: true })); }")
        await f1.hover(); await pg.mouse.wheel(0, -100)
        v1 = float(await f1.input_value())
        check(abs(v1 - 0.51) < 1e-6, f"mouse wheel up moves the fader one step: {v1}")
        await f1.dblclick()
        st = await pg.evaluate("(() => { const f = document.querySelector('#mixer .fader[data-strip]'); return [f.value, app.player.settings[f.dataset.strip].fader, f.closest('.fader-wrap').classList.contains('zero-flash')]; })()")
        check(float(st[0]) == 0.75 and abs(st[1] - 0.75) < 1e-9 and st[2], f"double-click: back to 0 dB, mark lights up {st}")
        box = await f1.bounding_box()
        y0 = box["y"] + 10 + 0.25 * (box["height"] - 20)
        await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] * 0.6); await pg.mouse.down()
        await pg.mouse.move(box["x"] + box["width"] / 2, y0 + 1.2, steps=4)
        snapped = float(await f1.input_value()); await pg.mouse.up()
        check(snapped == 0.75, f"dragging close to 0 dB snaps to it ({snapped})")
        mf = pg.locator('#masterFader'); await mf.hover(); await pg.mouse.wheel(0, 100)
        mv = await mf.input_value()
        check(float(mv) == 0.74, "main fader also follows the wheel")
        # song info box → metadata.txt (one box, folded by default)
        check(await pg.evaluate("!document.getElementById('infoPanel').classList.contains('open')") and await pg.is_hidden("#meta_title") and await pg.is_hidden("#metaSave"), "song info starts folded: only the bar shows")
        bar_h = await pg.evaluate("document.getElementById('infoPanel').getBoundingClientRect().height")
        check(bar_h < 40, f"folded box is as low as the Multitrack bar ({bar_h}px)")
        await pg.click("#infoPanel .ip-bar")
        check(await pg.is_visible("#meta_title") and await pg.is_visible("#metaSave"), "clicking the bar opens it")
        await pg.fill("#meta_title", "Television"); await pg.fill("#meta_artist", "Ben"); await pg.fill("#meta_comment", "line one\nline two")
        check(not await pg.is_disabled("#metaSave"), "Save info enabled after typing")
        await pg.click("#metaSave")
        await pg.wait_for_function("app.state.card.meta && app.state.card.meta.tv && app.state.card.meta.tv.title === 'Television'")
        check(await pg.inner_text("#lcdName") == "Television", "the player shows the title instead of the folder name")
        check(not await pg.evaluate("document.getElementById('lcdName').classList.contains('scrolling')"), "a short title doesn't scroll")
        await pg.fill("#meta_title", "A very long title that does not fit on the display"); await pg.click("#metaSave")
        await pg.wait_for_function("document.getElementById('lcdName').classList.contains('scrolling')")
        anim = await pg.evaluate("""(() => { const a = document.querySelector('#lcdName .lcd-scroll').getAnimations()[0]; const k = a.effect.getKeyframes(); const d = a.effect.getTiming().duration; return [d, k[1].offset * d]; })()""")
        check(anim[1] >= 3900 and anim[0] > 10000, f"a long title scrolls calmly: rests {anim[1]/1000:.1f} s first, loop {anim[0]/1000:.1f} s")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.meta.tv.title === 'Television'")
        js = await pg.evaluate("async (n) => JSON.parse(await (await (await (await window.__card.getDirectoryHandle('SETTINGS')).getFileHandle(n)).getFile()).text())", "tv.json")
        check(js["song"] == "tv" and js["info"]["title"] == "Television" and js["info"]["comment"] == "line one\nline two", f"SETTINGS/tv.json written: {js['info']}")
        cs = await pg.evaluate("async (n) => JSON.parse(await (await (await (await window.__card.getDirectoryHandle('SETTINGS')).getFileHandle(n)).getFile()).text())", "_card_settings.json")
        check("Ben" in cs["artists"], f"the artist goes on the card's list (SETTINGS/_card_settings.json): {cs['artists']}")
        if await pg.evaluate("document.getElementById('infoPanel').classList.contains('open')"): await pg.click("#infoPanel .ip-bar")
        sumtxt = await pg.inner_text("#infoPanel .ip-sum")
        check("Television" in sumtxt and "Ben" in sumtxt and "Created" in sumtxt and "Size" in sumtxt and "Click 120 BPM" in sumtxt, f"folded bar summary: {sumtxt}")
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(200)
        check("Artist Ben" in (await pg.inner_text("#infoPanel .ip-sum")).replace("\n", " "), "another song without an artist shows the most used artist")
        if not await pg.is_visible("#meta_artist"): await pg.click("#infoPanel .ip-bar")
        check(await pg.input_value("#meta_artist") == "Ben" and await pg.is_disabled("#metaSave"), "the most used artist is filled in (not counted as a change)")
        opts = await pg.evaluate("[...document.querySelectorAll('#artistChoices option')].map(o => o.value)")
        check("Ben" in opts and await pg.get_attribute("#meta_artist", "list") == "artistChoices", f"artist field offers the card's artists as you type: {opts}")
        check(await pg.locator("#metaDefaultRow").count() == 0, "no 'first artist becomes the default' line")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path="/tmp/info_closed.png", clip={"x": 320, "y": 140, "width": 730, "height": 330})
        await (pg.locator(".transport .lcd")).screenshot(path="/tmp/lcd.png")
        check(await pg.inner_text("#lcdMode") == "MULTI" and "44.1k" in await pg.inner_text("#lcdFmt"), "LCD shows the mode and the format")
        gaps = await pg.evaluate("""(() => { const r = (el) => el.getBoundingClientRect(); const head = document.querySelector('.song-head'), p = document.getElementById('infoPanel'), t = document.getElementById('trackMap'), v = document.getElementById('viewBar'), m = document.querySelector('#mixer .strip');
          return [r(p).top - r(head).bottom, r(t).top - r(p).bottom, r(v).top - r(t).bottom, r(m).top - r(v).bottom].map((x) => Math.round(x * 10) / 10); })()""")
        check(gaps == [7, 7, 7, 7], f"7px between the song header, Song info, overview, Multitrack bar and console: {gaps}")
        # the new workspace: main faders on the channel fader line, song info floats, the overview shows the song
        fb = await pg.evaluate("""(() => [document.querySelector('#mixer .strip .fader-wrap').getBoundingClientRect().bottom, document.getElementById('masterFader').parentElement.getBoundingClientRect().bottom])()""")
        check(abs(fb[0] - fb[1]) < 1, f"main faders on the same line as the channel faders ({fb})")
        y0 = await pg.evaluate("document.querySelector('#mixer .strip').getBoundingClientRect().top")
        await pg.click("#infoPanel .ip-bar"); await pg.wait_for_timeout(150)
        y1 = await pg.evaluate("document.querySelector('#mixer .strip').getBoundingClientRect().top")
        ov = await pg.evaluate("getComputedStyle(document.querySelector('#infoPanel .ip-body')).position")
        await pg.mouse.click(700, 980); await pg.wait_for_timeout(150)
        check(y0 == y1 and ov == "absolute" and not await pg.evaluate("document.getElementById('infoPanel').classList.contains('open')"), f"Song info opens over the console (nothing moves: {y0} → {y1}) and a click elsewhere folds it away")
        await pg.wait_for_function("document.querySelector('#trackMap .tm-note').hidden", timeout=8000)
        lanes = await pg.evaluate("""(() => { const c = document.querySelector('#trackMap canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 120 && d[i] < 120) lit++; return [c.width, c.height, lit]; })()""")
        check(not await pg.is_hidden("#trackMap") and lanes[2] > 200, f"the overview draws the song's tracks ({lanes})")
        await pg.evaluate("app.player.seek(app.player.duration / 2)"); await pg.wait_for_timeout(200)
        hx = await pg.evaluate("(() => { const m = document.getElementById('trackMap').getBoundingClientRect(), h = document.querySelector('#trackMap .tm-head').getBoundingClientRect(); return (h.left - m.left - 40) / (m.width - 46); })()")
        box = await pg.evaluate("(() => { const r = document.getElementById('trackMap').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await pg.mouse.click(box[0] + 40 + (box[2] - 46) * 0.25, box[1] + box[3] / 2); await pg.wait_for_timeout(200)
        pos = await pg.evaluate("app.player.position / app.player.duration")
        check(abs(hx - 0.5) < 0.03 and abs(pos - 0.25) < 0.03, f"the play-position line follows the player ({hx:.2f}) and a click jumps there ({pos:.2f})")
        await pg.evaluate("app.player.seek(0)")
        await pg.click("#infoPanel .ip-bar")
        await pg.screenshot(path="/tmp/info_open.png", clip={"x": 320, "y": 140, "width": 730, "height": 330})
        await pg.evaluate("app.rescan('tv')"); await pg.wait_for_timeout(300)
        check(await pg.input_value("#meta_title") == "Television" and await pg.input_value("#meta_comment") == "line one\nline two", "song info read back after re-reading the card")
        # rename keeps the info, undo of the rename too
        await pg.evaluate("app.openRenameDialog()"); await pg.fill("#renameInput", "telly"); await pg.click("#renameOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'telly')")
        await pg.wait_for_function("app.state.card.meta.telly && !app.state.card.meta.tv")
        check(await pg.input_value("#meta_title") == "Television", "rename: the song info follows the new name")
        await pg.click("#undoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv') && app.state.card.meta.tv")
        check(True, "undo rename: info back under the old name")
        # export dialog: tags only for downloads
        await pg.click("#exportBtn")
        check(await pg.is_hidden("#expMeta"), "export to card: no song-info fields (card exports stay untagged)")
        await pg.check('input[name="expTo"][value="download"]')
        check(await pg.locator('input[name="expFormat"]').count() == 0 and "FLAC" in await pg.inner_text("#exportDlg"), "downloads are always FLAC: no format choice")
        check(await pg.is_visible("#expMeta") and await pg.input_value("#expMeta_title") == "Television" and len(await pg.input_value("#expMeta_year")) == 4, "download: song info shown, year filled in")
        await pg.fill("#expMeta_genre", "Ambient")
        async with pg.expect_download() as dl:
            await pg.click("#expOk")
        path = await (await dl.value).path()
        data = open(path, "rb").read()
        check(data[:4] == b"fLaC" and b"TITLE=Television" in data and b"GENRE=Ambient" in data, "downloaded FLAC carries the tags")
        iso = await pg.evaluate("(() => { const d = app.state.card.songs.find(s => s.folder === 'tv').sys.created; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()")
        check(("DATE=" + iso).encode() in data, f"DATE is the recording date from song.sys ({iso})")
        rg = await pg.evaluate("""(() => { const sr = 44100, n = sr * 6, a = new Float32Array(n), b = new Float32Array(n);
          for (let i = sr * 2; i < sr * 4; i++) a[i] = 0.5 * Math.sin(i / 10);            // music from 2 s to 4 s
          for (let i = 0; i < n; i++) b[i] += (Math.random() - 0.5) * 2e-4;              // a little hiss everywhere
          return app.soundRange([a, b], sr).map(x => x / sr); })()""")
        check(abs(rg[0] - 1.75) < 0.01 and abs(rg[1] - 5.0) < 0.01, f"silence trim: music 2–4 s with hiss around it → keeps {rg[0]:.2f}–{rg[1]:.2f} s (¼ s before, 1 s after)")
        await pg.wait_for_function("app.state.card.meta.tv.genre === 'Ambient'")
        check(True, "export with 'also save' updates the song info")
        # artwork: a cover made for the song (faders = its levels, title/artist/year), a cover image in the card root overrides it
        lv = await pg.evaluate("(async () => Cover.songLevels(app.state.selected))()")
        check(lv[0] > 0.1 and lv[1] == 0 and lv[2] > 0.1, f"cover faders follow the song: 1-6 and 11/12 recorded, 7-10 empty -> {[round(x, 2) for x in lv]}")
        await pg.click("#exportBtn"); await pg.check('input[name="expTo"][value="download"]')
        await pg.wait_for_function("document.getElementById('expCoverImg').src.startsWith('blob:') && document.getElementById('expCoverImg').naturalWidth === 1400")
        check("made for this song" in await pg.inner_text("#expCoverLabel") and await pg.is_checked("#expCover"), "export dialog shows the cover made for this song")
        src1 = await pg.evaluate("document.getElementById('expCoverImg').src")
        await pg.fill("#expMeta_title", "Television (live)")
        await pg.wait_for_function("(s) => document.getElementById('expCoverImg').src !== s && document.getElementById('expCoverImg').src.startsWith('blob:')", arg=src1)
        check(True, "editing the title redraws the cover")
        async with pg.expect_download() as dl1:
            await pg.click("#expOk")
        data1 = open(await (await dl1.value).path(), "rb").read()
        builtin = open(os.path.join(APP, "icons", "cover.jpg"), "rb").read()
        i = data1.find(b"image/jpeg")
        check(i > 0 and data1.find(bytes([0xff, 0xd8, 0xff]), i) > 0 and builtin not in data1, "downloaded mix carries the song's own cover (a JPEG, not the generic one)")
        await pg.evaluate("""async () => { const b = await (await fetch('icons/icon-512.png')).arrayBuffer(); const h = await window.__card.getFileHandle('cover.png', { create: true }); const w = await h.createWritable(); await w.write(b); await w.close(); await app.rescan('tv'); }""")
        await pg.wait_for_timeout(300)
        await pg.click("#exportBtn"); await pg.check('input[name="expTo"][value="download"]')
        await pg.wait_for_function("document.getElementById('expCoverImg').naturalWidth === 512")
        check("cover.png from the card" in await pg.inner_text("#expCoverLabel") and await pg.is_hidden("#expCoverNone"), "a cover in the card root overrides the app's cover")
        async with pg.expect_download() as dl2:
            await pg.click("#expOk")
        data2 = open(await (await dl2.value).path(), "rb").read()
        own = open(os.path.join(APP, "icons", "icon-512.png"), "rb").read()
        check(b"image/png" in data2 and own in data2, "downloaded mix carries the card's own cover instead")
        await pg.click("#exportBtn"); await pg.check('input[name="expTo"][value="download"]'); await pg.uncheck("#expCover")
        async with pg.expect_download() as dl3:
            await pg.click("#expOk")
        check(b"image/" not in open(await (await dl3.value).path(), "rb").read()[:200000], "artwork can be switched off")
        js2 = await pg.evaluate("async (n) => JSON.parse(await (await (await (await window.__card.getDirectoryHandle('SETTINGS')).getFileHandle(n)).getFile()).text())", "tv.json")
        check("cover" not in json.dumps(js2) and "object" not in json.dumps(js2), "the image doesn't end up in the settings file")
        await pg.click("#exportBtn"); await pg.check('input[name="expTo"][value="card"]'); await pg.click("#expOk")
        await pg.wait_for_function("app.state.card.music.some(m => m.path === 'MUSIC/tv_2-MIX_01.wav')")
        card_mix = await pg.evaluate("async () => [...new Uint8Array(await (await (await (await window.__card.getDirectoryHandle('MUSIC')).getFileHandle('tv_2-MIX_01.wav')).getFile()).arrayBuffer())].length")
        raw = await pg.evaluate("async () => { const b = new Uint8Array(await (await (await (await window.__card.getDirectoryHandle('MUSIC')).getFileHandle('tv_2-MIX_01.wav')).getFile()).arrayBuffer()); return [String.fromCharCode(...b.subarray(b.length - 300)).includes('INAM'), new DataView(b.buffer).getUint32(4, true) + 8 === b.length]; }")
        check(not raw[0] and raw[1], "export to the card: no tags, file ends with the audio")
        await pg.click("#undoBtn"); await pg.wait_for_function("!app.state.card.music.some(m => m.path === 'MUSIC/tv_2-MIX_01.wav')")
        # tip after opening
        await pg.evaluate("localStorage.clear(); app.showOpenTip()")
        check(await pg.is_visible("#notice") and "Check card" in await pg.inner_text("#notice"), "tip about Check card shown after opening")
        await pg.click("#notice button:has-text(\"Don't show again\")")
        await pg.evaluate("app.showOpenTip()")
        check(await pg.is_hidden("#notice"), "Don't show again is remembered")
        # import into a new song
        tree0 = await pg.evaluate(TREE)
        await pg.click('.song-item[data-folder="tv"]')
        await pg.click("#importBtn")
        await pg.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(window.__wavStereo24); const i = document.getElementById('impFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); }""")
        await pg.wait_for_timeout(200)
        await pg.check('input[name="impInto"][value="new"]')
        check(await pg.input_value("#impNewName") == "guitar idea" and await pg.input_value("#impDst") == "7/8", f"new song: name from the file, stereo on 7/8 ({await pg.input_value('#impNewName')}, {await pg.input_value('#impDst')})")
        await pg.fill("#impNewName", "tv")
        check(await pg.is_disabled("#impOk") and "already exists" in await pg.inner_text("#impErrors"), "existing name refused")
        await pg.fill("#impNewName", "play along")
        if await pg.is_visible("#impBackupCheck"): await pg.check("#impBackupCheck")
        await pg.click("#impOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'play along' && !s.tracks[6].empty)")
        t = await pg.evaluate(TREE)
        files = t.get("play along", [])
        s = await pg.evaluate("(() => { const s = app.state.card.songs.find(s => s.folder === 'play along'); return { used: s.used, warn: s.warnings, sel: app.state.selected.folder, prot: s.sys.protected, tempo: s.sys.tempo, marks: s.sys.marks.length, rate: s.sampleRate, bits: s.bitsPerSample }; })()")
        check(song_ok(t, "play along") and s["used"] == 2 and not s["warn"] and s["sel"] == "play along", f"new song made: 25 files, 7/8 filled, selected {s}")
        check(not s["prot"] and s["tempo"] == 120 and s["marks"] == 0, "new song: not protected, tempo 120, no marks")
        sysn = await pg.evaluate(SYSB, "play along"); syst = await pg.evaluate(SYSB, "tv")
        d = [i for i in range(2048) if sysn[i] != syst[i]]
        check(set(d) <= {0x20, 0x5c, 0x5d, 0x5e, 0x5f, 0x25c, 0x262} | set(range(0xd0, 0xd0 + 396)), f"new song.sys differs from its template only in the reset fields: {[hex(x) for x in d]}")
        emp = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('play along'); return (await (await d.getFileHandle('01_play along_TR01.wav')).getFile()).size; }""")
        check(emp == 5548, f"empty tracks in the new song are 5,548-byte files like the unit's ({emp})")
        await pg.click("#undoBtn")
        await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'play along')")
        check(await pg.evaluate(TREE) == tree0, "undo removes the new song completely")
        await pg.click("#redoBtn")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'play along' && !s.tracks[6].empty)")
        check(True, "redo creates it again")
        await pg.click("#undoBtn"); await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'play along')")
        await pg.screenshot(path="/tmp/new_features.png")

        # ===== other formats: FLAC (exact), FLAC 48k/24-bit (rate conversion), MP3 =====
        await pg.evaluate("""async () => {
          const f = async (n, type) => new File([await (await fetch('tests/fixtures/gen/' + n)).arrayBuffer()], n, { type });
          window.__flac16 = await f('mono16.flac', 'audio/flac'); window.__flac48 = await f('stereo24_48k.flac', 'audio/flac'); window.__mp3 = await f('stereo.mp3', 'audio/mpeg'); }""")
        async def pick(var):
            await pg.evaluate("(v) => { const dt = new DataTransfer(); dt.items.add(window[v]); const i = document.getElementById('impFile'); i.files = dt.files; i.dispatchEvent(new Event('change')); }", var)
            await pg.wait_for_function("!/Reading|Measuring/.test(document.getElementById('impInfo').textContent)")
        TRK = """async ([f, n]) => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle(f);
            const b = new Uint8Array(await (await (await d.getFileHandle(`01_${f}_TR${String(n).padStart(2, '0')}.wav`)).getFile()).arrayBuffer());
            const i = Model12.parseWavHeader(b.subarray(0, 65536), b.length); return { rate: i.sampleRate, bits: i.bitsPerSample, frames: i.frames, data: [...b.subarray(i.dataOffset)] }; }"""
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(200)
        await pg.click("#importBtn"); await pick("__flac16")
        await pg.evaluate("() => { const c = document.getElementById('impNorm'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); } }")
        info = await pg.inner_text("#impInfo"); notes = await pg.inner_text("#impNotes")
        check(info.startswith("FLAC · Mono · 44.1 kHz · 16-bit") and "lossless" in notes, f"FLAC recognised: {info} | {notes[:60]}")
        await pg.select_option("#impDst", "4")
        if await pg.is_visible("#impBackupCheck"): await pg.check("#impBackupCheck")
        await pg.evaluate("() => { const c = document.getElementById('impNorm'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); } }")
        await pg.click("#impOk")
        await pg.wait_for_function("!app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        tr = await pg.evaluate(TRK, ["WANDERING", 4])
        check(bytes(tr["data"]) == MONO16 and tr["bits"] == 16 and tr["rate"] == 44100, f"FLAC import is bit-exact: same samples as the WAV it was made from ({tr['frames']} frames)")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        # the same file with "Normalise the level": the track ends up at the target loudness
        await pg.click("#importBtn"); await pick("__flac16")
        check(await pg.is_checked("#impNorm") and "converted rather than copied exactly" in await pg.inner_text("#impNotes"), "normalise: ticked for a loud file, and it says the audio is converted")
        await pg.select_option("#impDst", "4"); await pg.click("#impOk")
        await pg.wait_for_function("!app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        lu = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('WANDERING');
          const b = new Uint8Array(await (await (await d.getFileHandle('01_WANDERING_TR04.wav')).getFile()).arrayBuffer());
          const h = Model12.parseWavHeader(b.subarray(0, 65536), b.length); const x = Model12.pcmToFloat(b.subarray(h.dataOffset), h.bitsPerSample, 1, 0);
          return Loudness.measure([x], h.sampleRate); }""")
        check(abs(lu["lufs"] - CFG_NORM) < 0.5 and lu["peakDb"] <= -2.9, f"normalised track: {lu['lufs']:.1f} LUFS (target {CFG_NORM}), peak {lu['peakDb']:.1f} dBFS")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        await pg.click("#redoBtn"); await pg.wait_for_function("!app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        lu2 = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('WANDERING');
          const b = new Uint8Array(await (await (await d.getFileHandle('01_WANDERING_TR04.wav')).getFile()).arrayBuffer());
          const h = Model12.parseWavHeader(b.subarray(0, 65536), b.length); return Loudness.measure([Model12.pcmToFloat(b.subarray(h.dataOffset), h.bitsPerSample, 1, 0)], h.sampleRate).lufs; }""")
        check(abs(lu2 - lu["lufs"]) < 0.05, "redo imports at the same level")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[3].empty")
        await pg.click("#importBtn"); await pick("__flac48")
        info = await pg.inner_text("#impInfo"); notes = await pg.inner_text("#impNotes")
        check(info.startswith("FLAC · Stereo · 48 kHz · 24-bit") and "from 48 kHz to 44.1 kHz" in notes and "16-bit" in notes and await pg.input_value("#impDst") == "7/8", f"48 kHz 24-bit FLAC: conversion announced, 7/8 suggested ({notes[:90]})")
        await pg.click("#impOk")
        await pg.wait_for_function("!app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[6].empty")
        l = await pg.evaluate(TRK, ["WANDERING", 7])
        import struct as _s
        pk = max(abs(v) for v in _s.unpack("<%dh" % (len(l["data"]) // 2), bytes(l["data"])))
        check(l["rate"] == 44100 and l["bits"] == 16 and abs(l["frames"] - 88200) <= 2 and 2000 < pk < 32768, f"converted to 44.1 kHz/16-bit, 2 s long, audio present (frames {l['frames']}, peak {pk})")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[6].empty")
        await pg.click("#importBtn"); await pick("__mp3")
        info = await pg.inner_text("#impInfo"); notes = await pg.inner_text("#impNotes")
        check(info.startswith("MP3 · Stereo") and "lossy" in notes and not await pg.inner_text("#impErrors"), f"MP3 recognised, lossy noted: {info}")
        await pg.click("#impOk")
        await pg.wait_for_function("!app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[6].empty")
        m = await pg.evaluate(TRK, ["WANDERING", 7])
        check(m["rate"] == 44100 and abs(m["frames"] - 88200) < 3000, f"MP3 imported ({m['frames']} frames)")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.find(s => s.folder === 'WANDERING').tracks[6].empty")
        # new song from a 48 kHz FLAC: settings from this song, audio converted
        await pg.click("#importBtn"); await pick("__flac48"); await pg.check('input[name="impInto"][value="new"]')
        await pg.fill("#impNewName", "flac song")
        check("44.1 kHz" in await pg.inner_text("#impNotes") and not await pg.inner_text("#impErrors"), "new song from a 48 kHz file: made at 44.1 kHz from this song's settings")
        await pg.click("#impOk")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'flac song' && !s.tracks[6].empty)")
        check(True, "new song with the converted FLAC on 7/8")
        await pg.click("#undoBtn"); await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'flac song')")

        # ===== tempo: click label, BPM field, detect =====
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(300)
        if not await pg.is_visible("#meta_bpm"): await pg.click("#infoPanel .ip-bar")
        facts = await pg.inner_text("#infoPanel .facts")
        ft = " ".join(facts.split())
        check("Click 120 BPM" in ft and "Tempo —" in ft, f"song.sys tempo shown as the click setting; no tempo yet: {ft}")
        await pg.fill("#meta_bpm", "86"); await pg.click("#metaSave")
        await pg.wait_for_function("app.state.card.meta.WANDERING && app.state.card.meta.WANDERING.bpm === '86'")
        await pg.wait_for_timeout(200)
        check("Tempo 86 BPM" in (await pg.inner_text("#infoPanel .facts")).replace("\n", " ") and await pg.evaluate("app.player.fxSettings.tempo") == 86, "BPM saved: shown as Tempo, delays follow 86")
        await pg.click("#undoBtn"); await pg.wait_for_function("!(app.state.card.meta.WANDERING || {}).bpm")
        try: await pg.wait_for_function("app.player.fxSettings.tempo === 120 && app.state.selected.sys.tempo === 120", timeout=8000)
        except Exception: pass
        check(await pg.evaluate("app.player.fxSettings.tempo") == 120, f"undo: delays back on the click tempo ({await pg.evaluate('[app.player.fxSettings.tempo, app.state.selected.sys.tempo]')})")
        # a 12 s beat at 100 BPM on 11/12, then Detect
        await pg.evaluate("""async () => {
          const sr = 44100, n = sr * 12, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
          const w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
          w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true);
          d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
          const x = new Float32Array(n);
          for (let t = 0; t < 12; t += 0.6) { const k = Math.floor(t * sr); for (let i = 0; i < 2000 && k + i < n; i++) x[k + i] += 0.8 * Math.sin(2 * Math.PI * 60 * i / sr) * Math.exp(-i / 400); }
          for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.round(x[i] * 30000), true);
          const dir = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('WANDERING');
          for (const tr of ['11', '12']) { const h = await dir.getFileHandle(`01_WANDERING_TR${tr}.wav`); window['__old' + tr] = await (await h.getFile()).arrayBuffer(); const wr = await h.createWritable(); await wr.write(b); await wr.close(); }
          await app.rescan('WANDERING'); }""")
        await pg.wait_for_timeout(300)
        if not await pg.is_visible("#meta_bpm"): await pg.click("#infoPanel .ip-bar")
        await pg.click("#bpmDetect")
        await pg.wait_for_function("document.getElementById('meta_bpm').value !== ''")
        est = await pg.input_value("#meta_bpm")
        check(abs(float(est) - 100) <= 1 and not await pg.is_disabled("#metaSave") and "Estimated" in await pg.inner_text("#toast"), f"Detect fills in the tempo from the audio ({est} BPM), not saved until you click Save")
        await pg.evaluate("""async () => { const dir = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('WANDERING');
          for (const tr of ['11', '12']) { const h = await dir.getFileHandle(`01_WANDERING_TR${tr}.wav`); const wr = await h.createWritable(); await wr.write(window['__old' + tr]); await wr.close(); }
          await app.rescan('WANDERING'); }""")

        # ===== mixes saved per song, default mix, My mix export =====
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        await pg.evaluate("app.player.set('1', 'pan', -1); app.player.set('2', 'pan', 1)")
        await pg.wait_for_function("(() => { try { return JSON.parse(app.state.card.meta.tv.mix).strips['1'].pan === -1; } catch (e) { return false; } })()", timeout=6000)
        await pg.wait_for_function("document.getElementById('mixSaveIcon').classList.contains('saved')")
        mj = await pg.evaluate("async (n) => JSON.parse(await (await (await (await window.__card.getDirectoryHandle('SETTINGS')).getFileHandle(n)).getFile()).text())", "tv.json")
        check(mj["mix"]["strips"]["1"]["pan"] == -1 and await pg.locator("#viewBar .vb-mix em, #mixDefault").count() == 0, "console changes are saved in SETTINGS/tv.json; save icon green; no text or 'Use as default'")
        await pg.click('.song-item[data-folder="epistem 01"]'); await pg.wait_for_timeout(400)
        check(await pg.evaluate("app.player.settings['1'].pan") == 0, "another song opens with its own (here: factory) mix")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        check(await pg.evaluate("[app.player.settings['1'].pan, app.player.settings['2'].pan]") == [-1, 1], "back on the song: its mix is restored (1 left, 2 right)")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        await pg.click("#mixReset"); await pg.wait_for_function("!(app.state.card.meta.tv || {}).mix")
        check(await pg.evaluate("app.player.settings['1'].pan") == 0, "Reset forgets the song's own mix")
        await pg.click("#undoBtn"); await pg.wait_for_function("!!(app.state.card.meta.tv || {}).mix")
        check(await pg.evaluate("app.player.settings['1'].pan") == -1, "undo Reset brings the mix back")
        # offline render follows the console: only strip 1, hard left
        stats = await pg.evaluate("""(async () => {
          const P = app.player; const keep = JSON.stringify(P.getMix());
          for (const id of ['2', '3', '4', '5', '6', '7/8', '9/10', '11/12']) P.set(id, 'mute', true);
          const r = await P.renderMix();
          let l = 0, rr = 0; for (let i = 0; i < r.left.length; i++) { l = Math.max(l, Math.abs(r.left[i])); rr = Math.max(rr, Math.abs(r.right[i])); }
          P.setMix(JSON.parse(keep));
          return { frames: r.left.length, song: P.totalFrames, l, r: rr, tracks: r.tracks }; })()""")
        check(stats["tracks"] == 1 and stats["l"] > 0.05 and stats["r"] < 1e-4 and stats["song"] <= stats["frames"] <= stats["song"] + 44100 * 7, f"render follows mute and pan: {stats}")
        # export My mix (download only, 24-bit, tags)
        await pg.click("#exportBtn"); await pg.check('input[name="expSrc"][value="app"]')
        check(await pg.is_disabled('input[name="expTo"][value="card"]') and await pg.is_checked('input[name="expTo"][value="download"]') and "tv_MIX_APP.flac" in await pg.inner_text("#expFiles"), "My mix: download only, named <song>_MIX_APP.flac")
        async with pg.expect_download() as dlm:
            await pg.click("#expOk")
        dm = await dlm.value
        mdata = open(await dm.path(), "rb").read()
        import struct as _st
        si = mdata[8:42]
        ch, sr2, bits2 = ((si[12] >> 1) & 7) + 1, int.from_bytes(si[10:13], "big") >> 4, (((si[12] & 1) << 4) | (si[13] >> 4)) + 1
        check(dm.suggested_filename == "tv_MIX_APP.flac" and mdata[:4] == b"fLaC" and (ch, sr2, bits2) == (2, 44100, 24) and b"TITLE=" in mdata and b"image/" in mdata, f"My mix file: stereo 44.1 kHz 24-bit with tags and cover ({dm.suggested_filename}, {ch}, {sr2}, {bits2})")
        # level check: a mix above full scale offers to bring it down to -1 dBFS
        await pg.evaluate("""() => { const P = app.player; const orig = P.renderMix.bind(P);
          P.renderMix = async (cb) => { const r = await orig(cb); const k = 4 / r.peak; for (let i = 0; i < r.left.length; i++) { r.left[i] *= k; r.right[i] *= k; } r.peak = 4; return r; }; window.__restoreRender = () => { P.renderMix = orig; }; }""")
        await pg.click("#exportBtn"); await pg.check('input[name="expSrc"][value="app"]')
        await pg.click("#expOk")
        await pg.wait_for_selector("#choiceDlg[open]")
        check("+12.0 dBFS" in await pg.inner_text("#choiceMsg"), f"clipping mix: the app warns ({(await pg.inner_text('#choiceMsg'))[:40]})")
        async with pg.expect_download() as dlc:
            await pg.click("#choiceButtons button:has-text('Lower to')")
        cpath = await (await dlc.value).path()
        import subprocess as _sp
        pcm = _sp.run(["ffmpeg", "-v", "error", "-i", cpath, "-f", "s32le", "-"], capture_output=True).stdout
        mx = max(abs(v) >> 8 for v in _st.unpack("<%di" % (len(pcm) // 4), pcm))
        check(abs(20 * __import__("math").log10(mx / 8388608) + 1) < 0.05, f"lowered: the file peaks at -1 dBFS ({20 * __import__('math').log10(mx / 8388608):.2f})")
        await pg.evaluate("window.__restoreRender()")
        # ===== mastering on the main output, loudness on the My mix download =====
        opts = await pg.evaluate("[...document.querySelectorAll('#mstPreset option')].map(o => o.textContent)")
        check(opts[0] == "Off" and {"Punch", "Crystal stereo", "Ambience", "Vocal presence", "Kick", "Stereo enhance", "Nature", "Sixties", "Seventies", "Analog", "Vinyl", "Tape"} <= set(opts), f"mastering presets from the config: {opts}")
        await pg.select_option("#mstPreset", "tape")
        await pg.wait_for_function("(() => { try { return JSON.parse(app.state.card.meta.tv.mix).mastering.preset === 'tape'; } catch (e) { return false; } })()", timeout=6000)
        check("saturation" in await pg.inner_text("#mstDesc") and not await pg.is_disabled("#mstAmount"), "picking a preset shows what it does and is saved with the song's mix")
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(300)
        check(await pg.input_value("#mstPreset") == "", "another song: mastering off")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        check(await pg.input_value("#mstPreset") == "tape", "back on the song: its preset is back")
        ms = await pg.evaluate("""async () => { const P = app.player; const st = (r) => { let pk = 0, e = 0; for (let i = 0; i < r.left.length; i++) { pk = Math.max(pk, Math.abs(r.left[i]), Math.abs(r.right[i])); e += r.left[i] ** 2; } return [pk, e]; };
          const out = {}; for (const id of [null, ...CFG12.mastering.presets.map(p => p.id)]) { P.setMastering('preset', id); out[id || 'off'] = st(await P.renderMix()); }
          P.setMastering('preset', 'tape'); P.setMastering('amount', 0); out.zero = st(await P.renderMix()); P.setMastering('amount', 1); return out; }""")
        check(all(v[0] < 1.0 for k, v in ms.items()) and all(abs(v[1] - ms["off"][1]) > 1e-3 for k, v in ms.items() if k not in ("off", "zero")), f"every preset renders, changes the sound and stays below 0 dBFS (peaks {[round(v[0], 2) for v in ms.values()]})")
        check(abs(ms["zero"][1] - ms["off"][1]) < 1e-6 * max(1, ms["off"][1]), "AMOUNT 0 sounds exactly like off")
        await pg.select_option("#mstLoud", "-14")
        await pg.wait_for_function("(() => { try { return JSON.parse(app.state.card.meta.tv.mix).mastering.loudness === -14; } catch (e) { return false; } })()", timeout=6000)
        await pg.click("#exportBtn"); await pg.check('input[name="expSrc"][value="app"]')
        async with pg.expect_download() as dll:
            await pg.click("#expOk")
        lpath = await (await dll.value).path()
        ebu = _sp.run(["ffmpeg", "-hide_banner", "-nostats", "-i", lpath, "-af", "ebur128=peak=sample", "-f", "null", "-"], capture_output=True, text=True).stderr
        import re as _re
        lufs = float(_re.findall(r"I:\s+(-?[\d.]+) LUFS", ebu)[-1]); spk = float(_re.findall(r"Peak:\s+(-?[\d.]+) dBFS", ebu)[-1])
        check(abs(lufs + 14) < 1.0 and spk <= -0.9, f"My mix download at -14 LUFS: ffmpeg measures {lufs} LUFS, sample peak {spk} dBFS")
        await pg.select_option("#mstLoud", ""); await pg.select_option("#mstPreset", "")
        await pg.wait_for_function("(() => { try { return !JSON.parse(app.state.card.meta.tv.mix).mastering; } catch (e) { return true; } })()", timeout=6000)
        # the song buttons: icons only when there's no room for the labels, labels back when there is
        await pg.set_viewport_size({"width": 1030, "height": 860}); await pg.wait_for_timeout(300)
        c1 = await pg.evaluate("document.querySelector('#songInfo .song-actions').classList.contains('compact')")
        lbl = await pg.evaluate("[...document.querySelectorAll('#songInfo .act-btn')].every(b => b.getAttribute('aria-label') && (b.title || '').length > 3)")
        await pg.set_viewport_size({"width": 1600, "height": 860}); await pg.wait_for_timeout(300)
        c2 = await pg.evaluate("document.querySelector('#songInfo .song-actions').classList.contains('compact')")
        await pg.set_viewport_size({"width": 1280, "height": 860}); await pg.wait_for_timeout(300)
        check(c1 and not c2 and lbl, "narrow window: icons only (tooltips stay); wide window: labels back")
        meta = await pg.inner_text('.song-item[data-folder="tv"] .song-meta')
        check(re_meta(meta), f"song list: length · size · date on one line: {meta}")
        await pg.click('#modeMain'); await pg.wait_for_timeout(200)
        check(await pg.inner_text("#fxHint") == "" and await pg.inner_text("#fx2Hint") == "", "Main mix: no 'switch to Multitrack' note in the effects box")
        await pg.click('#modeMulti'); await pg.wait_for_timeout(200)

        # ===== FLAC downloads (the default) =====
        import subprocess, tempfile, hashlib, json as _json
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        await pg.click("#exportBtn"); await pg.check('input[name="expSrc"][value="rec"]'); await pg.check('input[name="expTo"][value="download"]')
        check(await pg.inner_text("#expFiles") == "tv_2-MIX_01.flac" and "exact samples" in await pg.inner_text("#expFileNote"), "recorded mix as FLAC: name and note")
        async with pg.expect_download() as dlf:
            await pg.click("#expOk")
        fpath = await (await dlf.value).path()
        fdata = open(fpath, "rb").read()
        ref = await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv'); const out = [];
          for (const t of ['11', '12']) { const b = new Uint8Array(await (await (await d.getFileHandle(`01_tv_TR${t}.wav`)).getFile()).arrayBuffer()); const h = Model12.parseWavHeader(b.subarray(0, 65536), b.length); out.push([...b.subarray(h.dataOffset, h.dataOffset + h.frames * 2)]); } return out; }""")
        L, R = bytes(ref[0]), bytes(ref[1])
        inter = b"".join(L[i:i + 2] + R[i:i + 2] for i in range(0, min(len(L), len(R)), 2))
        dec = subprocess.run(["ffmpeg", "-v", "error", "-err_detect", "crccheck+explode", "-i", fpath, "-f", "s16le", "-"], capture_output=True).stdout
        check(fdata[:4] == b"fLaC" and dec == inter, f"recorded mix FLAC decodes to exactly the samples of 11/12 ({len(dec)} bytes)")
        pj = _json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags:stream=codec_name,width:stream_disposition=attached_pic", "-of", "json", fpath], capture_output=True, text=True).stdout)
        tg = {k.lower(): v for k, v in pj["format"]["tags"].items()}
        check(tg.get("title") and any(s.get("codec_name") in ("mjpeg", "png") and s["disposition"]["attached_pic"] == 1 for s in pj["streams"]), f"FLAC has the tags and the cover as front picture ({tg.get('title')})")
        await pg.click("#exportBtn"); await pg.check('input[name="expSrc"][value="app"]')
        check(await pg.inner_text("#expFiles") == "tv_MIX_APP.flac", "My mix as FLAC")
        async with pg.expect_download() as dlg:
            await pg.click("#expOk")
        gpath = await (await dlg.value).path()
        info = _json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate,bits_per_raw_sample", "-of", "json", gpath], capture_output=True, text=True).stdout)
        a0 = [s for s in info["streams"] if s["codec_name"] == "flac"][0]
        ok = subprocess.run(["ffmpeg", "-v", "error", "-err_detect", "crccheck+explode", "-i", gpath, "-f", "null", "-"], capture_output=True).returncode == 0
        check(ok and a0["channels"] == 2 and a0["sample_rate"] == "44100" and a0["bits_per_raw_sample"] == "24", f"My mix FLAC: stereo 44.1 kHz 24-bit, decodes cleanly {a0}")
        # ===== 2026-11-21: FX 2, clip indicator, columns scroll on their own =====
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        check(await pg.locator('#mixer .knob[data-key="fx2"]').count() == 9 and await pg.locator("#fx2Panel").count() == 1 and await pg.locator("#fx2Fader").count() == 1, "an FX 2 row on every channel, an FX 2 card and an FX 2 return fader")
        check("orange" not in await pg.inner_text(".transport"), "no 'turn up the orange FX knobs' hint")
        check(await pg.is_visible("#fxPanel") and not await pg.is_visible("#fx2Panel") and await pg.locator("#fxBox .fx-tab").count() == 2, "FX 1 and FX 2 share one box with tabs; FX 1 shows first")
        await pg.click("#fxTab1")
        check(await pg.is_visible("#fx2Panel") and not await pg.is_visible("#fxPanel"), "the FX 2 tab shows FX 2")
        await pg.select_option("#fx2Type", "PINGPONG")
        await pg.evaluate("app.player.set('2', 'fx2', 0.5)")
        await pg.wait_for_function("(() => { try { const m = JSON.parse(app.state.card.meta.tv.mix); return m.fx2.type === 'PINGPONG' && m.strips['2'].fx2 === 0.5; } catch (e) { return false; } })()", timeout=6000)
        check(True, "FX 2 type and the channel's FX 2 send are saved with the song's mix")
        await pg.click('.song-item[data-folder="epistem 01"]'); await pg.wait_for_timeout(400)
        check(await pg.evaluate("app.player.fxs[1].type") == "DELAY1", "another song: FX 2 starts as Delay 1")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        check(await pg.evaluate("[app.player.fxs[1].type, app.player.settings['2'].fx2]") == ["PINGPONG", 0.5] and await pg.input_value("#fx2Type") == "PINGPONG", "back on the song: FX 2 restored")
        y0 = await pg.evaluate("document.getElementById('masterFader').getBoundingClientRect().top")
        await pg.click("#infoPanel .ip-bar"); await pg.wait_for_timeout(300)
        y1 = await pg.evaluate("document.getElementById('masterFader').getBoundingClientRect().top")
        await pg.click("#infoPanel .ip-bar"); await pg.wait_for_timeout(300)
        check(y0 == y1 and await pg.evaluate("document.documentElement.scrollHeight <= innerHeight + 1"), f"opening Song info doesn't move the right column ({y0} → {y1})")
        await pg.set_viewport_size({"width": 1280, "height": 560}); await pg.wait_for_timeout(200)
        sq = await pg.evaluate("[...document.querySelector('.transport').children].every(el => el.hidden || el.getBoundingClientRect().height >= el.scrollHeight - 6)")
        await pg.evaluate("document.querySelector('.desk').scrollTop = 9999"); await pg.wait_for_timeout(100)
        mb = await pg.evaluate("document.querySelector('.mode-switch, #modeMulti').getBoundingClientRect().height")
        await pg.set_viewport_size({"width": 1280, "height": 860}); await pg.wait_for_timeout(200)
        check(sq and mb > 20, f"a short window: the right column scrolls and nothing in it gets squashed (Multitrack/Main mix {mb}px high)")
        await pg.click("#fxTab0")
        check(await pg.evaluate("document.getElementById('clipInd').hidden"), "no clip warning at rest")
        await pg.evaluate("app.player.setMaster(1); for (const id of ['1', '2', '3']) app.player.set(id, 'fader', 1)")
        await pg.click("#playBtn"); await pg.wait_for_timeout(800); await pg.click("#playBtn")
        ct = await pg.inner_text("#clipInd")
        bl = await pg.evaluate("parseFloat(document.getElementById('clipInd').style.getPropertyValue('--blink'))")
        check(not await pg.evaluate("document.getElementById('clipInd').hidden") and ct.endswith("dB") and await pg.locator("#clipInd svg").count() == 1 and bl < 1.2, f"clipping: the amount over 0 dB under MAIN, flashing ({ct}, every {bl}s)")
        await pg.click("#clipInd"); await pg.wait_for_timeout(100)
        check(await pg.evaluate("document.getElementById('clipInd').hidden"), "click clears the clip warning")
        await pg.evaluate("app.player.setMaster(0.75); for (const id of ['1', '2', '3']) app.player.set(id, 'fader', 0.75); app.player.set('2', 'fx2', 0)")
        await pg.click("#mixReset"); await pg.wait_for_function("!(app.state.card.meta.tv || {}).mix")
        await pg.click("#undoBtn"); await pg.wait_for_function("!!(app.state.card.meta.tv || {}).mix")
        await pg.wait_for_timeout(300)

        # ===== 2026-11-23: overview keys and marks, inactive strips, readout, snapshots, sort menu, song info layout =====
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        await pg.evaluate("app.player.seek(0.5)"); await pg.mouse.click(5, 5)
        await pg.keyboard.press("t")
        tf = await pg.evaluate("[document.activeElement.id, app.player.position]")
        check(tf == ["trackMap", 0.5], f"T puts the keyboard on the overview without moving the play position ({tf})")
        await pg.keyboard.press("Escape")
        check(await pg.evaluate("document.activeElement.id") != "trackMap", "Escape lets go of the overview")
        await pg.focus("#trackMap")
        bc = await pg.evaluate("getComputedStyle(document.getElementById('trackMap')).borderColor")
        await pg.keyboard.press("End"); e1 = await pg.evaluate("[app.player.position, app.player.duration]")
        await pg.keyboard.press("Home"); h1 = await pg.evaluate("app.player.position")
        await pg.keyboard.press("ArrowRight"); r1 = await pg.evaluate("app.player.position")
        await pg.keyboard.press("Shift+ArrowLeft"); r2 = await pg.evaluate("app.player.position")
        check(abs(e1[0] - e1[1]) < 0.1 and h1 == 0 and abs(r1 - 1) < 0.01 and r2 == 0, f"overview keys: End {e1}, Home {h1}, → {r1:.2f}, Shift+← {r2:.2f} (border {bc})")
        await pg.keyboard.press("m"); await pg.wait_for_timeout(300)
        check(await pg.evaluate("app.state.selected.sys.marks.length") == 0 and await pg.evaluate("!document.querySelector('dialog[open]')"), "M does nothing: marks are set on the Model 12")
        # Main mix: the console is off; empty tracks are off
        await pg.click("#modeMain"); await pg.wait_for_timeout(200)
        off = await pg.evaluate("[...document.querySelectorAll('#mixer .strip')].every(s => s.inert && s.classList.contains('off')) && document.getElementById('fxBox').inert")
        await pg.click("#modeMulti"); await pg.wait_for_timeout(200)
        on = await pg.evaluate("[...document.querySelectorAll('#mixer .strip')].filter(s => !s.classList.contains('empty')).every(s => !s.inert)")
        check(off and on, "Main mix: channel strips and effects are switched off (the recording plays as it is); Multitrack: on again")
        # readout: shows on hover, stays while dragging
        await pg.hover('#mixer .knob[data-strip="1"][data-key="hi"]'); await pg.wait_for_timeout(100)
        ro = await pg.evaluate("[!document.querySelector('.readout').hidden, document.querySelector('.readout').innerText]")
        bx = await pg.locator('#mixer .knob[data-strip="1"][data-key="hi"]').bounding_box()
        await pg.mouse.down(); await pg.mouse.move(bx["x"] + 15, bx["y"] - 60, steps=4); await pg.mouse.move(bx["x"] + 200, bx["y"] - 80, steps=3)
        held = await pg.evaluate("[!document.querySelector('.readout').hidden, document.querySelector('.readout').innerText]")
        await pg.mouse.up(); await pg.wait_for_timeout(50)
        gone = await pg.evaluate("document.querySelector('.readout').hidden")
        check(ro[0] and "CH 1" in ro[1] and "HIGH" in ro[1] and held[0] and "+" in held[1] and gone, f"knob readout: on hover ({ro[1]!r}), still up while turning outside the knob ({held[1]!r}), gone after")
        await pg.dblclick('#mixer .knob[data-strip="1"][data-key="hi"]')
        await pg.hover('#mixer .fader[data-strip="2"]'); await pg.wait_for_timeout(100)
        check("FADER" in await pg.inner_text(".readout") and "dB" in await pg.inner_text(".readout"), f"fader readout in dB: {await pg.inner_text('.readout')!r}")
        await pg.mouse.move(5, 5)
        # snapshots
        await pg.click("#snap0")
        await pg.evaluate("app.player.set('5', 'pan', -0.6)"); await pg.wait_for_timeout(100)
        s1 = await pg.evaluate("[document.getElementById('snap0').classList.contains('filled'), document.getElementById('snap0').classList.contains('current')]")
        await pg.click("#snap1"); await pg.click("#snap0"); await pg.wait_for_timeout(150)
        back = await pg.evaluate("[app.player.settings['5'].pan, document.getElementById('snap0').classList.contains('current'), document.getElementById('snap1').classList.contains('current')]")
        await pg.click("#snap1"); await pg.wait_for_timeout(150)
        fwd = await pg.evaluate("app.player.settings['5'].pan")
        await pg.click("#snapStart"); await pg.wait_for_timeout(150)
        st0 = await pg.evaluate("[app.player.settings['5'].pan, document.getElementById('snapStart').classList.contains('current')]")
        check(s1 == [True, False] and back == [0, True, False] and abs(fwd + 0.6) < 1e-9 and st0 == [0, True], f"snapshots: take, change, recall ({s1}, {back}, {fwd}), and back to the mix as opened ({st0})")
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(300)
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        check(await pg.locator("#viewBar .snap.filled").count() == 0, "snapshots are gone after opening another song")
        # sort menu
        await pg.click("#sortBtn")
        await pg.click('#sortPop [data-sort="name"]'); n1 = await pg.evaluate("[...document.querySelectorAll('#songList .song-item')].map(e => e.dataset.folder)")
        await pg.click('#sortPop [data-dir="desc"]'); n2 = await pg.evaluate("[...document.querySelectorAll('#songList .song-item')].map(e => e.dataset.folder)")
        await pg.keyboard.press("Escape")
        check(n1 == sorted(n1, key=str.lower) and n2 == list(reversed(n1)) and await pg.is_hidden("#sortPop") and "Z–A" in await pg.inner_text("#sortBtn"), f"sort menu: name A–Z {n1}, then descending")
        await pg.click("#sortBtn"); await pg.click('#sortPop [data-sort="date"]'); await pg.keyboard.press("Escape")
        # song info: three columns, description saved, summary stays, save icon
        if not await pg.evaluate("document.getElementById('infoPanel').classList.contains('open')"): await pg.click("#infoPanel .ip-bar")
        await pg.wait_for_timeout(300)
        cols = await pg.evaluate("[...document.querySelectorAll('#infoPanel .facts, #infoPanel .mb-fields, #infoPanel .mb-texts')].map(e => Math.round(e.getBoundingClientRect().left))")
        check(len(cols) == 3 and cols[0] < cols[1] < cols[2] and await pg.is_visible("#infoPanel .ip-sum") and await pg.locator("#metaSave svg").count() == 1, f"song info: facts | fields | description + comment ({cols}); summary stays on the bar; Save is an icon")
        await pg.fill("#meta_description", "Recorded on a rainy Sunday"); await pg.click("#metaSave")
        await pg.wait_for_function("(app.state.card.meta.tv || {}).description === 'Recorded on a rainy Sunday'")
        dj = await pg.evaluate(RJ_, "tv.json")
        check(dj["info"].get("description") == "Recorded on a rainy Sunday", "description saved in SETTINGS/tv.json")
        await pg.click("#infoPanel .ip-bar")

        # ===== 2026-11-21: save icon, click tempo in song.sys, title rename, duplicate, migration =====
        RS = "async ([f, o]) => new Uint8Array(await (await (await (await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle(f)).getFileHandle('song.sys')).getFile()).arrayBuffer())[o]"
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(400)
        await pg.evaluate("""() => { window.__iconStates = []; const el = document.getElementById('mixSaveIcon');
          new MutationObserver(() => window.__iconStates.push(el.className)).observe(el, { attributes: true }); }""")
        await pg.evaluate("app.player.set('3', 'pan', 0.5)")
        await pg.wait_for_function("window.__iconStates.some(c => c.includes('saved'))", timeout=6000)
        st = await pg.evaluate("window.__iconStates")
        check(any("saving" in c for c in st) and "saved" in st[-1], f"save icon: flickers while saving, then green ({st[-3:]})")
        check(await pg.locator("#viewBar .vb-mix #mixSaveIcon").count() == 1 and await pg.locator("#viewBar .vb-mix #mixReset svg").count() == 1, "save and reset icons together on the Multitrack bar")
        # BPM -> click tempo byte (rounded), undo restores it
        await pg.click('.song-item[data-folder="WANDERING"]'); await pg.wait_for_timeout(300)
        if not await pg.is_visible("#meta_bpm"): await pg.click("#infoPanel .ip-bar")
        await pg.fill("#meta_bpm", "95.6"); await pg.click("#metaSave")
        await pg.wait_for_function("(app.state.selected && app.state.selected.sys && app.state.selected.sys.tempo) === 96", timeout=8000)
        check(await pg.evaluate(RS, ["WANDERING", 0x25C]) == 96, "Save writes the BPM (rounded) as the song's click tempo in song.sys")
        await pg.click("#undoBtn"); await pg.wait_for_function("(app.state.selected && app.state.selected.sys && app.state.selected.sys.tempo) === 120", timeout=8000)
        check(await pg.evaluate(RS, ["WANDERING", 0x25C]) == 120, "undo puts the old click tempo back in song.sys")
        # rename by clicking the title
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        check(await pg.locator("#renameBtn").count() == 0, "no Rename button")
        await pg.click("#songTitle")
        check(await pg.evaluate("document.getElementById('songTitle').isContentEditable"), "clicking the title makes it editable")
        await pg.keyboard.press("Control+A"); await pg.keyboard.type("tv b")
        await pg.keyboard.press("Enter")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv b') && app.state.selected && app.state.selected.folder === 'tv b'", timeout=10000)
        try: await pg.wait_for_function("!!app.state.card.meta['tv b'] && !app.state.card.meta.tv", timeout=5000)
        except Exception: pass
        check(await pg.evaluate("!!app.state.card.meta['tv b'] && !app.state.card.meta.tv"), f"title rename (with a space typed) moves the folder and its settings")
        await pg.click("#undoBtn"); await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv')", timeout=10000)
        await pg.wait_for_timeout(300)
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        await pg.click("#songTitle"); await pg.keyboard.press("Control+A"); await pg.keyboard.type("x"); await pg.keyboard.press("Escape")
        await pg.wait_for_timeout(200)
        check(await pg.inner_text("#songTitle") == "tv" and not await pg.evaluate("document.getElementById('songTitle').isContentEditable"), "Escape cancels the title edit")
        # duplicate
        await pg.click("#dupBtn")
        await pg.wait_for_selector("#choiceDlg[open]")
        dm = await pg.inner_text("#choiceMsg")
        check("complete copy" in dm and '"tv01"' in dm and "original stays exactly as it is" in dm, "Duplicate first explains what it does")
        await pg.click("#choiceButtons .btn.primary")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv01')", timeout=20000)
        await pg.wait_for_function("app.history.undo.length && app.history.undo.at(-1).to === 'tv01'", timeout=10000)
        tree = await pg.evaluate(TREE)
        check(sorted(f.replace("tv01", "tv") for f in tree["tv01"]) == tree["tv"], f"duplicate: every file copied with the new name ({len(tree['tv01'])} files)")
        d1 = await pg.evaluate("[app.state.card.meta.tv01 && app.state.card.meta.tv01.mix === app.state.card.meta.tv.mix, (app.state.card.meta.tv01 || {}).title]")
        check(d1[0] and d1[1] == await pg.evaluate("app.state.card.meta.tv.title"), f"duplicate: song info and mix copied ({d1})")
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        await pg.click("#dupBtn"); await pg.wait_for_selector("#choiceDlg[open]"); await pg.click("#choiceButtons .btn.primary")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv02')", timeout=20000)
        await pg.wait_for_function("app.history.undo.length && app.history.undo.at(-1).to === 'tv02'", timeout=10000)
        check(True, "a second duplicate becomes tv02")
        await pg.click("#undoBtn"); await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'tv02')", timeout=10000)
        await pg.click("#undoBtn"); await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'tv01')", timeout=10000)
        await pg.wait_for_timeout(300)
        tree = await pg.evaluate(TREE)
        sj = await pg.evaluate("async () => { const out = []; for await (const [n] of (await window.__card.getDirectoryHandle('SETTINGS')).entries()) out.push(n); return out.sort(); }")
        check("tv01" not in tree and "tv01.json" not in sj and not await pg.evaluate("!!app.state.card.meta.tv01"), f"undo removes the copy and its settings ({sj})")
        await pg.click('.song-item[data-folder="PROT"]'); await pg.wait_for_timeout(300)
        check(not await pg.is_disabled("#dupBtn") and "editable" not in (await pg.get_attribute("#songTitle", "class")), "a protected song can be duplicated, not renamed")
        # delete: type DELETE, everything of the song goes, no undo
        await pg.click('.song-item[data-folder="tv"]'); await pg.wait_for_timeout(300)
        await pg.click("#dupBtn"); await pg.wait_for_selector("#choiceDlg[open]"); await pg.click("#choiceButtons .btn.primary")
        await pg.wait_for_function("app.state.card.songs.some(s => s.folder === 'tv01')", timeout=20000)
        await pg.wait_for_timeout(300)
        await pg.click('.song-item[data-folder="tv01"]'); await pg.wait_for_timeout(300)
        await pg.evaluate("""async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('tv01');
          const w = await (await d.getFileHandle('._song.sys', { create: true })).createWritable(); await w.write('mac'); await w.close(); }""")
        await pg.evaluate("""async () => { const h = await window.__card.getFileHandle('tascam_m.sys'); const b = new Uint8Array(await (await h.getFile()).arrayBuffer());
          const w = await h.createWritable(); await w.write(Model12.setCurrentSongName(b, 'tv01')); await w.close(); await app.openHandle(window.__card, 'tv01'); }""")
        await pg.wait_for_timeout(400)
        await pg.click("#deleteBtn"); await pg.wait_for_selector("#deleteDlg[open]")
        check("current song on the Model 12" in await pg.inner_text("#delMsg"), "deleting the current song says which song the unit opens instead")
        check(await pg.is_disabled("#delOk") and "can't be undone" in await pg.inner_text("#delMsg"), "Delete asks to type DELETE and says it can't be undone")
        await pg.fill("#delConfirm", "delete"); check(await pg.is_disabled("#delOk"), "lowercase 'delete' is not enough")
        await pg.fill("#delConfirm", "DELETE"); check(not await pg.is_disabled("#delOk"), "DELETE enables the button")
        await pg.click("#delOk")
        await pg.wait_for_function("!app.state.card.songs.some(s => s.folder === 'tv01')", timeout=20000)
        await pg.wait_for_timeout(300)
        tree = await pg.evaluate(TREE)
        sj = await pg.evaluate("async () => { const out = []; for await (const [n] of (await window.__card.getDirectoryHandle('SETTINGS')).entries()) out.push(n); return out.sort(); }")
        check(tree["__current"] in tree and tree["__current"] != "tv01", f"tascam_m.sys now names an existing song ({tree['__current']})")
        check("tv01" not in tree and "tv01.json" not in sj and "tv" in tree, f"Delete removes the folder (hidden files too) and its settings; the original stays ({sj})")
        await pg.click('.song-item[data-folder="PROT"]'); await pg.wait_for_timeout(300)
        check(await pg.is_disabled("#deleteBtn"), "a protected song can't be deleted")
        # migration: an old metadata.txt is converted once, on the first write
        await pg.evaluate("""async () => {
          try { await window.__card.removeEntry('SETTINGS', { recursive: true }); } catch (e) {}
          const h = await window.__card.getFileHandle('metadata.txt', { create: true }); const w = await h.createWritable();
          await w.write('[*]\\nartist = Old Default\\n\\n[WANDERING]\\ntitle = Wandering\\ngenre = ambient\\n'); await w.close();
          await app.openHandle(window.__card); }""")
        await pg.wait_for_timeout(500)
        check(await pg.evaluate("app.state.card.meta.WANDERING && app.state.card.meta.WANDERING.title === 'Wandering' && !app.state.card.meta['*']"), "old metadata.txt is read; its default artist is not a song")
        await pg.click('.song-item[data-folder="epistem 01"]'); await pg.wait_for_timeout(300)
        if not await pg.is_visible("#meta_genre"): await pg.click("#infoPanel .ip-bar")
        check(await pg.input_value("#meta_genre") == "ambient", "most used genre is suggested on another song")
        await pg.fill("#meta_title", "Epistem"); await pg.click("#metaSave")
        await pg.wait_for_function("app.state.card.meta['epistem 01'] && app.state.card.meta['epistem 01'].title === 'Epistem'")
        await pg.wait_for_timeout(300)
        names = await pg.evaluate("async () => { const out = []; for await (const [n] of window.__card.entries()) out.push(n); const s = []; for await (const [n] of (await window.__card.getDirectoryHandle('SETTINGS')).entries()) s.push(n); return [out.sort(), s.sort()]; }")
        check("metadata.txt" not in names[0] and {"WANDERING.json", "epistem 01.json", "_card_settings.json"} <= set(names[1]), f"first write converts metadata.txt to SETTINGS and removes it {names[1]}")
        cs = await pg.evaluate(RJ_, "_card_settings.json")
        check("Old Default" in cs["artists"] and "ambient" in cs["genres"], f"old default artist and genres kept on the card's lists {cs}")
        # clicking quickly through songs (also while playing): the last one clicked is the one that's loaded
        names = await pg.evaluate("[...document.querySelectorAll('#songList .song-item')].map(e => e.dataset.folder)")
        for k in range(30):
            await pg.click(f'.song-item[data-folder="{names[k % len(names)]}"]')
            await pg.wait_for_timeout(15)
            if k == 3: await pg.keyboard.press("Space")
        await pg.wait_for_timeout(1500)
        st = await pg.evaluate("[app.state.selected.folder, app.player.song.folder, document.getElementById('busy').hidden]")
        check(st[0] == st[1] == names[29 % len(names)] and st[2], f"fast clicking through songs: the last clicked is loaded and nothing hangs ({st})")
        if await pg.evaluate("app.player.playing"): await pg.keyboard.press("Space")
        check(not errors, f"no page errors {errors}")
        await b.close()
    srv.shutdown()
    print("\nRESULT:", "FAILED" if check.failed else "ALL PASSED")
    sys.exit(1 if check.failed else 0)

asyncio.run(main())
