# Checks the installable-app (PWA) parts in Chrome:
#  - VERSION in sw.js matches the ?v= in index.html
#  - Chrome reports no installability errors and the manifest parses
#  - the service worker takes control and the app starts offline
#  - a new version is offered with "Update now" and loads after clicking it
#   python3 tests/pwa_test.py
import asyncio, http.server, threading, functools, os, re, shutil, sys, tempfile
from playwright.async_api import async_playwright

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main_sync():
    failed = False
    def check(c, m):
        nonlocal failed
        print(("PASS " if c else "FAIL ") + m); failed |= not c

    sw = open(os.path.join(APP, "sw.js")).read()
    html = open(os.path.join(APP, "index.html")).read()
    swv = re.search(r"const VERSION = '([^']+)'", sw).group(1)
    htmlv = set(re.findall(r"\?v=([0-9.\-]+)", html))
    check(htmlv == {swv}, f"sw.js VERSION {swv} matches index.html ?v= {sorted(htmlv)}")
    assets = re.findall(r"'\./([^'?]*)", sw)
    missing = [a for a in assets if a and not os.path.exists(os.path.join(APP, a))]
    check(not missing, f"every cached file exists {missing}")

    # serve a copy, so the update test can change it
    srv_dir = tempfile.mkdtemp()
    for f in os.listdir(APP):
        if f in ("tests", "tools"): continue
        s = os.path.join(APP, f)
        (shutil.copytree if os.path.isdir(s) else shutil.copy)(s, os.path.join(srv_dir, f))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=srv_dir)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8767), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    async def run():
        async with async_playwright() as p:
            # a normal (non-incognito) profile: Chrome never offers installs in private windows
            profile = tempfile.mkdtemp()
            ctx = await p.chromium.launch_persistent_context(profile, executable_path="/usr/bin/google-chrome", headless=True)
            b = ctx
            pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
            errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            url = "http://localhost:8767/index.html"
            await pg.goto(url)
            await pg.evaluate("navigator.serviceWorker.ready")
            await pg.reload()
            check(await pg.evaluate("!!navigator.serviceWorker.controller"), "service worker controls the page")
            cdp = await ctx.new_cdp_session(pg)
            inst = await cdp.send("Page.getInstallabilityErrors")
            check(inst.get("installabilityErrors") == [], f"Chrome: installable {inst.get('installabilityErrors')}")
            man = await cdp.send("Page.getAppManifest")
            check(not man.get("errors"), f"manifest parses without errors {man.get('errors')}")

            # offline start
            await ctx.set_offline(True)
            await pg.reload()
            ok = await pg.evaluate("!!(window.Model12 && window.Player && window.FX && window.CardIO && window.icon)")
            ver = await pg.inner_text(".version")
            check(ok and swv in ver, f"starts offline with all scripts ({ver})")
            await ctx.set_offline(False)

            # update: publish a new version on the "server"
            newv = swv + "-test"
            for f in ("sw.js", "index.html"):
                pth = os.path.join(srv_dir, f)
                txt = open(pth).read().replace(swv, newv)
                open(pth, "w").write(txt)
            await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
            await pg.wait_for_selector("#updateBar:not([hidden])", timeout=15000)
            check(True, "new version offered (update bar shown)")
            async with pg.expect_navigation():
                await pg.click("#updateBtn")
            await pg.wait_for_load_state()
            check(newv in await pg.inner_text(".version"), f"after Update now: {await pg.inner_text('.version')}")
            keys = await pg.evaluate("caches.keys()")
            check(keys == ["tmm-" + newv], f"old cache removed: {keys}")
            check(not errs, f"no page errors {errs}")
            await b.close()
    asyncio.run(run())
    srv.shutdown()
    shutil.rmtree(srv_dir, ignore_errors=True)
    print("\nRESULT:", "FAILED" if failed else "ALL PASSED")
    sys.exit(1 if failed else 0)

main_sync()
