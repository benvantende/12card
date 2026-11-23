# Renders every effect type offline (OfflineAudioContext) and checks it behaves as intended.
#   python3 tests/fx_test.py
import asyncio, http.server, threading, functools, os, sys
from playwright.async_api import async_playwright

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

JS = r"""
async () => {
  const sr = 44100, out = {};
  async function render(type, param, tempo, seconds = 4) {
    const ctx = new OfflineAudioContext(2, sr * seconds, sr);
    const eng = new FX.Engine(ctx, ctx.destination, { type, param, ret: 0.75, mute: false, tempo });
    const b = ctx.createBuffer(1, 64, sr); b.getChannelData(0)[0] = 1;   // a click
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(eng.input); src.start(0.1);
    const r = await ctx.startRendering();
    return [r.getChannelData(0), r.getChannelData(1)];
  }
  const peakAt = (d, from, to) => { let m = 0, at = -1; for (let i = Math.floor(from * sr); i < Math.min(d.length, to * sr); i++) if (Math.abs(d[i]) > m) { m = Math.abs(d[i]); at = i; } return { m, t: at / sr }; };
  const energy = (d, from, to) => { let e = 0; for (let i = Math.floor(from * sr); i < Math.min(d.length, to * sr); i++) e += d[i] * d[i]; return e; };
  for (const t of FX.TYPES) {
    const [l, r] = await render(t.id, FX.paramInfo(t.id, 120).def, 120);
    let finite = true, max = 0;
    for (const d of [l, r]) for (const v of d) { if (!Number.isFinite(v)) finite = false; max = Math.max(max, Math.abs(v)); }
    out[t.id] = { finite, max: +max.toFixed(3), tail: +energy(l, 1.5, 4).toFixed(5), early: +energy(l, 0, 1.5).toFixed(4) };
  }
  // delay timing: tempo 120, 1/4 → 0.5 s after the click (at 0.1 s)
  const [dl] = await render('DELAY1', 0.6, 120);
  out.delay1_echo = peakAt(dl, 0.3, 0.9).t;
  const [dl95] = await render('DELAY1', 0.6, 95);
  out.delay1_echo_95bpm = peakAt(dl95, 0.3, 1.2).t;
  const [d8] = await render('DELAY2', 0.2, 120); // 1/8
  out.delay2_eighth = peakAt(d8, 0.15, 0.6).t;
  // ping pong: first echo left only, second echo right
  const [pl, pr] = await render('PINGPONG', 0.6, 120);
  out.pp_first = { left: peakAt(pl, 0.3, 0.9), right: peakAt(pr, 0.3, 0.9) };
  out.pp_second_right = peakAt(pr, 0.9, 1.4).t;
  // reverb lengths: Hall 2 rings longer than Room 1; higher DECAY rings longer
  const [h2] = await render('HALL2', 0.5, 120), [r1] = await render('ROOM1', 0.5, 120);
  out.hall2_vs_room1 = [energy(h2, 1.2, 4), energy(r1, 1.2, 4)];
  const [hShort] = await render('HALL1', 0.1, 120), [hLong] = await render('HALL1', 0.9, 120);
  out.hall1_decay = [energy(hShort, 1.5, 4), energy(hLong, 1.5, 4)];
  out.info = FX.TYPES.map((t) => { const p = FX.paramInfo(t.id, 95); return `${t.name}: ${p.label} ${p.show(p.def)}`; });
  return out;
}
"""

async def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP)
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    failed = False
    def check(c, m):
        nonlocal failed
        print(("PASS " if c else "FAIL ") + m); failed |= not c
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        pg = await b.new_page()
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto("http://127.0.0.1:8766/index.html")
        r = await pg.evaluate(JS)
        for k, v in r.items():
            if isinstance(v, dict) and "finite" in v:
                check(v["finite"] and 0.01 < v["max"] < 4, f"{k:13} output ok (peak {v['max']}, tail energy {v['tail']})")
        check(abs(r["delay1_echo"] - 0.6) < 0.005, f"Delay 1 echo at 120 BPM, 1/4: {r['delay1_echo'] - 0.1:.3f} s after the click (0.500 expected)")
        check(abs(r["delay1_echo_95bpm"] - (0.1 + 60 / 95)) < 0.005, f"Delay 1 at 95 BPM: {r['delay1_echo_95bpm'] - 0.1:.3f} s ({60/95:.3f} expected)")
        check(abs(r["delay2_eighth"] - 0.35) < 0.005, f"Delay 2, 1/8 at 120: {r['delay2_eighth'] - 0.1:.3f} s (0.250 expected)")
        pf = r["pp_first"]
        check(pf["left"]["m"] > 0.1 and pf["right"]["m"] < 0.01 and abs(pf["left"]["t"] - 0.6) < 0.005, f"Ping Pong first echo left only (L {pf['left']['m']:.2f}, R {pf['right']['m']:.3f})")
        check(abs(r["pp_second_right"] - 1.1) < 0.005, f"Ping Pong second echo right at {r['pp_second_right'] - 0.1:.3f} s")
        h, ro = r["hall2_vs_room1"]
        check(h > 10 * ro, f"Hall 2 rings much longer than Room 1 ({h:.4f} vs {ro:.6f})")
        s, l = r["hall1_decay"]
        check(l > 3 * s, f"Hall 1: higher DECAY = longer tail ({l:.4f} vs {s:.5f})")
        print("\n".join("  " + x for x in r["info"]))
        check(not errs, f"no page errors {errs}")
        await b.close()
    srv.shutdown()
    print("\nRESULT:", "FAILED" if failed else "ALL PASSED")
    sys.exit(1 if failed else 0)

asyncio.run(main())
