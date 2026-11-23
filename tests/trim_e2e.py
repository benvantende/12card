# End-to-end test of Trim song: silence finding, the cut itself (sample-exact, headers kept, marks moved),
# undo/redo through SETTINGS/trim-undo, and the clean-up offer. Uses a fake card in OPFS. Run from the app folder:
#   python3 tests/trim_e2e.py
import asyncio, http.server, threading, functools, sys, os, json
from playwright.async_api import async_playwright

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/usr/bin/google-chrome"
R = 44100

BUILD = r"""
async () => {
  const fx = async (n) => new Uint8Array(await (await fetch('tests/fixtures/' + n)).arrayBuffer());
  const empty = await fx('empty_track.wav'), songSys = await fx('song.sys'), cardSys = await fx('tascam_m_TV.sys');
  const R = 44100;
  // 24-bit mono track in the unit's own header: [silence, tone, silence] in seconds; marks (in frames) in its cue chunk
  function track(parts, marks = []) {
    const n = Math.round(parts.reduce((a, p) => a + p[0], 0) * R);
    const h = Model12.headerFromTemplate(empty, { channels: 1, bitsPerSample: 24, dataBytes: n * 3 });
    const dv = new DataView(h.buffer);
    const cue = Model12.findChunk(h, 'cue '), list = Model12.findChunk(h, 'LIST');
    marks.forEach((m, i) => {
      const o = cue.body + 4 + i * 24; dv.setUint32(o, i + 1, true); dv.setUint32(o + 4, m, true); dv.setUint32(o + 20, m, true);
      const l = list.body + 4 + i * 20, t = `MARK_0${i + 1}`; for (let k = 0; k < 8; k++) h[l + 12 + k] = k < t.length ? t.charCodeAt(k) : 0;
    });
    const out = new Uint8Array(h.length + n * 3); out.set(h);
    let f = 0;
    for (const [sec, amp] of parts) {
      const m = Math.round(sec * R);
      for (let i = 0; i < m; i++, f++) {
        const v = amp ? Math.round(amp * 8388607 * Math.sin(2 * Math.PI * 220 * i / R)) : (i % 7) - 3; // "silence": a little hiss far below −60 dBFS
        const o = h.length + f * 3; out[o] = v & 255; out[o + 1] = (v >> 8) & 255; out[o + 2] = (v >> 16) & 255;
      }
    }
    return out;
  }
  const put = async (dir, name, bytes) => { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close(); };
  const opfs = await navigator.storage.getDirectory();
  try { await opfs.removeEntry('card', { recursive: true }); } catch (e) {}
  const card = await opfs.getDirectoryHandle('card', { create: true });
  await put(card, 'tascam_m.sys', cardSys);
  const mtr = await card.getDirectoryHandle('MTR', { create: true });
  for (const d of ['MUSIC', 'UTILITY']) await card.getDirectoryHandle(d, { create: true });
  const dir = await mtr.getDirectoryHandle('CUTME', { create: true });
  const marks = [Math.round(0.5 * R), 2 * R, Math.round(4.8 * R)];
  const tr = {
    1: track([[1.0, 0], [2.0, 0.5], [2.0, 0]]),
    2: track([[1.5, 0], [1.0, 0.3], [2.5, 0]]),
    3: track([[1.2, 0], [1.8, 0.4]]),                 // shorter than the song, sound to its very end
    7: track([[1.0, 0], [2.0, 0.2], [2.0, 0]], marks),
  };
  for (let t = 1; t <= 12; t++) await put(dir, `01_CUTME_TR${String(t).padStart(2, '0')}.wav`, tr[t] || empty);
  const sys = new Uint8Array(songSys); const sdv = new DataView(sys.buffer);
  marks.forEach((m, i) => sdv.setUint32(0xD0 + 4 * i, m, true));
  await put(dir, 'song.sys', sys);
  for (let t = 1; t <= 12; t++) await put(dir, `tempTr${t}_A.bin`, new Uint8Array(0));
  window.__card = card;
  window.__orig = {};
  for await (const [n, fh] of dir.entries()) window.__orig[n] = new Uint8Array(await (await fh.getFile()).arrayBuffer());
  await app.openHandle(card);
  return app.state.card.songs.map((s) => s.folder);
}
"""

# compare the song folder with the originals: returns a description per file
CHECK = r"""
async ([start, end]) => {
  const dir = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('CUTME');
  const out = {};
  for await (const [n, fh] of dir.entries()) {
    const now = new Uint8Array(await (await fh.getFile()).arrayBuffer()), was = window.__orig[n];
    if (!was) { out[n] = 'new file'; continue; }
    if (!/\.wav$/.test(n) || now.length === was.length && now.every((v, i) => v === was[i])) { out[n] = now.length === was.length && now.every((v, i) => v === was[i]) ? 'same' : 'changed'; continue; }
    const h0 = Model12.parseWavHeader(was, was.length), h1 = Model12.parseWavHeader(now, now.length);
    const s = Math.min(start, h0.frames), want = Math.max(0, Math.min(end, h0.frames) - s) & ~1;
    let audio = h1.frames === want && now.length === h1.dataOffset + want * 3;
    for (let i = 0; audio && i < want * 3; i++) if (now[h1.dataOffset + i] !== was[h0.dataOffset + s * 3 + i]) audio = false;
    // header: only RIFF size (4-7), data size and cue/LIST mark slots may differ
    const cue = Model12.findChunk(now, 'cue '), list = Model12.findChunk(now, 'LIST');
    let hdr = h1.dataOffset === h0.dataOffset;
    for (let i = 0; hdr && i < h1.dataOffset; i++) {
      if (now[i] === was[i]) continue;
      const ok = (i >= 4 && i < 8) || (i >= h1.dataOffset - 4) || (i >= cue.body && i < cue.body + cue.size) || (i >= list.body && i < list.body + list.size);
      if (!ok) hdr = false;
    }
    const dv = new DataView(now.buffer);
    const riff = dv.getUint32(4, true) === now.length - 8;
    const slots = [];
    for (let i = 0; i < 4; i++) { const o = cue.body + 4 + i * 24; slots.push([dv.getUint32(o, true), dv.getUint32(o + 4, true), dv.getUint32(o + 20, true), String.fromCharCode(...now.subarray(list.body + 4 + i * 20 + 12, list.body + 4 + i * 20 + 20)).replace(/\0/g, '')]); }
    out[n] = { audio, hdr, riff, frames: h1.frames, slots };
  }
  return out;
}
"""

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: check.failed = True
check.failed = False

async def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 1280, "height": 860})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto("http://127.0.0.1:8766/index.html")
        await pg.wait_for_function("!document.getElementById('lcd').classList.contains('booting')", timeout=20000)
        songs = await pg.evaluate(BUILD)
        check(songs == ["CUTME"], f"fake card with one song {songs}")
        await pg.click('.song-item[data-folder="CUTME"]'); await pg.wait_for_timeout(400)

        # trim mode: Find silence runs by itself
        await pg.click("#trimBtn")
        await pg.wait_for_function("document.getElementById('trimInfo').textContent.startsWith('Keeps')", timeout=5000)
        t = await pg.evaluate("[app.trimState.start, app.trimState.end, app.trimState.total]")
        exp_start, exp_end = int(0.75 * R), int(4.0 * R)
        check(abs(t[0] - exp_start) < 30 and abs(t[1] - exp_end) < 30 and t[2] == 5 * R, f"Find silence: start {t[0]} (≈{exp_start}), end {t[1]} (≈{exp_end}) of {t[2]}")
        check(await pg.is_visible("#trimBar") and await pg.evaluate("document.getElementById('trackMap').classList.contains('trimming')"), "trim bar and overview edges shown")
        await pg.screenshot(path="/tmp/trim_bar.png")
        # typing a time, and the [ ] keys
        await pg.fill("#trimStart", "0:00.80"); await pg.press("#trimStart", "Enter")
        check(await pg.evaluate("app.trimState.start") == int(0.8 * R), "typed start time is used")
        await pg.evaluate("app.player.seek(3.9)"); await pg.wait_for_timeout(50)
        await pg.keyboard.press("]")
        e2 = await pg.evaluate("app.trimState.end")
        check(abs(e2 - 3.9 * R) < 50, f"] sets the end at the play position ({e2})")
        await pg.fill("#trimStart", "0:00.75"); await pg.press("#trimStart", "Enter")
        await pg.fill("#trimEnd", "0:04.00"); await pg.press("#trimEnd", "Enter")
        start, end = await pg.evaluate("[app.trimState.start, app.trimState.end]")
        check((start, end) == (exp_start, exp_end), f"edges set to {start}…{end}")

        # the dialog
        await pg.click("#trimGo")
        await pg.wait_for_selector("#trimDlg[open]")
        notes = await pg.inner_text("#trimNotes")
        check("0.75 s" in notes and "1.00 s" in notes and "TR01, TR02, TR03, TR07" in notes and "8 empty tracks stay" in notes, "dialog: what is cut, which tracks, empty ones stay")
        check("1 of 3 move" in notes and "2 in the cut part are removed" in notes and "TR03 is shorter" in notes, f"dialog: marks and the short track\n{notes}")
        check(await pg.is_disabled("#trimOk"), "needs the backup tick")
        await pg.screenshot(path="/tmp/trim_dlg.png")
        await pg.check("#trimBackupCheck"); await pg.click("#trimOk")
        await pg.wait_for_function("document.getElementById('busy').hidden && app.history.undo.length === 1", timeout=20000)

        r = await pg.evaluate(CHECK, [start, end])
        kept = (end - start) & ~1   # an even number of 24-bit frames: no pad byte
        for n in (1, 2, 7):
            x = r[f"01_CUTME_TR0{n}.wav"]
            check(isinstance(x, dict) and x["audio"] and x["hdr"] and x["riff"] and x["frames"] == kept, f"TR0{n}: exact audio slice, own header, sizes right ({x if not isinstance(x, dict) else x['frames']})")
        x3 = r["01_CUTME_TR03.wav"]
        check(x3["audio"] and x3["hdr"] and x3["frames"] == (int(3.0 * R) - start) & ~1, f"TR03 (shorter): cut to its own end, even frame count ({x3['frames']})")
        s7 = r["01_CUTME_TR07.wav"]["slots"]
        check(s7[0] == [1, 2 * R - start, 2 * R - start, "MARK_01"] and s7[1][0] == 0xFF000002 and s7[1][3] == "" and s7[2][0] == 0xFF000003, f"TR07 cue: the one mark left moved, others freed {s7}")
        check(r["01_CUTME_TR01.wav"]["slots"][0][0] == 0xFF000001, "tracks without marks keep their cue as it was")
        same = [n for n, v in r.items() if v == "same"]
        check(len([n for n in same if "_TR" in n]) == 8 and "tempTr1_A.bin" in same, "empty tracks and temp files untouched")
        sys_marks = await pg.evaluate("Model12.parseSongSys(window.__orig['song.sys']).marks.length + ':' + app.state.card.songs[0].sys.marks.join(',')")
        check(sys_marks == f"3:{2 * R - start}", f"song.sys: marks moved and dropped ({sys_marks})")
        check(not any(k.startswith("tmmtmp_") for k in r), "no temp files left in the song folder")
        undo = await pg.evaluate("""async () => { const u = await (await (await window.__card.getDirectoryHandle('SETTINGS')).getDirectoryHandle('trim-undo')).entries().next(); const d = u.value[1]; const out = {}; for await (const [n, fh] of d.entries()) out[n] = (await fh.getFile()).size; return [u.value[0], out]; }""")
        check(undo[0].endswith("_CUTME") and set(undo[1]) == {"01_CUTME_TR01.wav", "01_CUTME_TR02.wav", "01_CUTME_TR03.wav", "01_CUTME_TR07.wav", "trim.json"}, f"originals kept in SETTINGS/trim-undo/{undo[0]}")
        dur = await pg.evaluate("app.player.duration")
        check(abs(dur - kept / R) < 0.01, f"the player opens the trimmed song ({dur:.2f} s)")
        trimmed = await pg.evaluate("async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('CUTME'); const o = {}; for await (const [n, fh] of d.entries()) o[n] = Array.from(new Uint8Array(await (await fh.getFile()).arrayBuffer()).subarray(0, 6000)).join() + (await fh.getFile()).size; return o; }")

        # undo puts everything back byte for byte; redo brings the trim back
        await pg.click("#undoBtn")
        await pg.wait_for_function("document.getElementById('busy').hidden && app.history.redo.length === 1", timeout=20000)
        r = await pg.evaluate(CHECK, [0, 10 ** 9])
        check(all(v == "same" for v in r.values()), f"undo: every file as it was {[n for n, v in r.items() if v != 'same']}")
        await pg.click("#redoBtn")
        await pg.wait_for_function("document.getElementById('busy').hidden && app.history.undo.length === 1", timeout=20000)
        again = await pg.evaluate("async () => { const d = await (await window.__card.getDirectoryHandle('MTR')).getDirectoryHandle('CUTME'); const o = {}; for await (const [n, fh] of d.entries()) o[n] = Array.from(new Uint8Array(await (await fh.getFile()).arrayBuffer()).subarray(0, 6000)).join() + (await fh.getFile()).size; return o; }")
        check(again == trimmed, "redo: the trimmed files are back")

        # protected songs can't be trimmed
        # clean-up offer when the card is opened again (history gone)
        await pg.evaluate("app.history.undo.length = 0; app.history.redo.length = 0")
        await pg.evaluate("() => { app.openHandle(window.__card).then(() => app.offerTrimCleanup()); }")
        await pg.wait_for_selector("#choiceDlg[open]")
        msg = await pg.inner_text("#choiceMsg")
        check('"CUTME"' in msg and "Delete them" in await pg.inner_text("#choiceButtons"), f"clean-up offer names the song: {msg[:90]}")
        await pg.click("#choiceButtons button.primary")
        await pg.wait_for_function("document.getElementById('busy').hidden")
        await pg.wait_for_timeout(300)
        left = await pg.evaluate("async () => { const s = []; for await (const [n] of (await window.__card.getDirectoryHandle('SETTINGS')).entries()) s.push(n); return s; }")
        check("trim-undo" not in left, f"kept originals deleted ({left})")
        r = await pg.evaluate(CHECK, [start, end])
        check(r["01_CUTME_TR01.wav"]["audio"], "the trimmed song is still fine after the clean-up")
        # mouse wheel on the FX 1, FX 2 and MASTERING sliders
        await pg.select_option("#mstPreset", index=1); await pg.wait_for_timeout(100)
        await pg.evaluate("document.getElementById('mstAmount').value = 0.5; document.getElementById('mstAmount').dispatchEvent(new Event('input'))")
        for sel in ("#fxParam", "#mstAmount"):
            before = float(await pg.input_value(sel))
            await pg.hover(sel); await pg.mouse.wheel(0, 100); await pg.wait_for_timeout(50)
            after = float(await pg.input_value(sel))
            check(abs(after - (before - 0.01)) < 1e-6, f"wheel down on {sel}: {before} → {after}")
        await pg.click("#fxTab1"); await pg.wait_for_timeout(100)
        before = float(await pg.input_value("#fx2Param"))
        await pg.evaluate("document.getElementById('fx2Param').dispatchEvent(new WheelEvent('wheel', { deltaX: -100, deltaY: 0, shiftKey: true, bubbles: true, cancelable: true }))"); await pg.wait_for_timeout(50)
        after = float(await pg.input_value("#fx2Param"))
        check(after > before, f"Shift+wheel up on #fx2Param moves to the next setting: {before} → {after}")
        check(not errors, f"no page errors {errors}")
        await b.close()
    srv.shutdown()
    print("\nRESULT:", "FAILED" if check.failed else "ALL PASSED")
    sys.exit(1 if check.failed else 0)

asyncio.run(main())
