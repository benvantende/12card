# Makes the README screenshots from a copy of a Model 12 card (nothing is written to the copy):
#   python3 tools/screenshots.py "/path/to/card copy" "SONG" ["SONG FOR TRIM"]
# The card is copied into the browser's private storage (OPFS) of a headless Chrome; needs Playwright.
import asyncio, http.server, threading, functools, os, sys, json, pathlib
from playwright.async_api import async_playwright

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(APP, "docs")
CHROME = "/usr/bin/google-chrome"

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        if path.startswith("/__card/"):
            from urllib.parse import unquote
            return os.path.join(CARD, unquote(path[len("/__card/"):].split("?")[0]))
        return super().translate_path(path)

LOAD = r"""
async (files) => {
  const opfs = await navigator.storage.getDirectory();
  try { await opfs.removeEntry('MODEL12', { recursive: true }); } catch (e) {}
  const card = await opfs.getDirectoryHandle('MODEL12', { create: true });
  for (const f of files) {
    let dir = card; const parts = f.split('/');
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const data = await (await fetch('/__card/' + f.split('/').map(encodeURIComponent).join('/'))).arrayBuffer();
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(data); await w.close();
  }
  for (const d of ['MTR', 'MUSIC']) await card.getDirectoryHandle(d, { create: true });
  window.__card = card;
  await app.openHandle(card);
  return app.state.card.songs.map((s) => s.folder);
}
"""

async def main():
    global CARD
    CARD, song = sys.argv[1], sys.argv[2]
    trim_song = sys.argv[3] if len(sys.argv) > 3 else song
    files = [str(p.relative_to(CARD)) for p in pathlib.Path(CARD).rglob("*") if p.is_file()
             and (p.parts[-2] in (song, trim_song) or p.name == "tascam_m.sys")]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8769), functools.partial(Handler, directory=APP))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        import tempfile   # a real profile: a fresh one has too little storage for a whole song
        b = await p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="12card-shots-"), executable_path=CHROME,
            args=["--autoplay-policy=no-user-gesture-required"], viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        pg = b.pages[0] if b.pages else await b.new_page()
        await pg.goto("http://127.0.0.1:8769/index.html")
        await pg.wait_for_function("!document.getElementById('lcd').classList.contains('booting')", timeout=20000)
        print("songs:", await pg.evaluate(LOAD, files))
        await pg.evaluate("localStorage.setItem('tmm.openTip', 'off')")
        await pg.click(f'.song-item[data-folder="{song}"]')
        await pg.wait_for_function("app.player.duration > 0", timeout=20000)
        await pg.wait_for_timeout(6000)          # the overview reads the tracks
        await pg.evaluate("app.player.seek(app.player.duration * 0.37)")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=os.path.join(OUT, "screenshot-main.png"))
        await pg.click("#infoPanel .ip-bar"); await pg.wait_for_timeout(700)
        await pg.screenshot(path=os.path.join(OUT, "screenshot-info.png"))
        await pg.click("#infoPanel .ip-bar"); await pg.wait_for_timeout(500)
        if trim_song != song:
            await pg.click(f'.song-item[data-folder="{trim_song}"]')
            await pg.wait_for_function("app.player.duration > 0", timeout=20000)
            await pg.wait_for_timeout(5000)
        await pg.click("#trimBtn")
        await pg.wait_for_function("document.getElementById('trimInfo').textContent.startsWith('Keeps')", timeout=20000)
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=os.path.join(OUT, "screenshot-trim.png"))
        await b.close()
    srv.shutdown()

asyncio.run(main())
