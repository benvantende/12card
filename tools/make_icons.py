# Generates the app icons in ../icons/ (run: python3 tools/make_icons.py).
# Design: dark rounded square with three console faders (grey, grey, red main fader).
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")
os.makedirs(OUT, exist_ok=True)

BG, PANEL, SLOT = (21, 23, 26), (36, 40, 45), (8, 9, 10)
GREY_TOP, GREY_BOT, RED_TOP, RED_BOT, LINE = (228, 230, 233), (120, 125, 132), (240, 120, 104), (150, 32, 20), (250, 250, 250)

def draw(size, maskable=False):
    S = size * 4  # draw large, scale down = smooth edges
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)          # full bleed; the OS applies its own mask
        inset = int(S * 0.20)                         # keep the artwork inside the safe zone
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)
        inset = int(S * 0.14)
    box = [inset, inset, S - inset, S - inset]
    d.rounded_rectangle(box, radius=int(S * 0.08), fill=PANEL)
    w = box[2] - box[0]
    cols = [0.27, 0.5, 0.73]
    caps = [0.38, 0.62, 0.30]   # cap positions (fraction of travel from top)
    top, bot = box[1] + w * 0.14, box[3] - w * 0.14
    for i, (cx, cp) in enumerate(zip(cols, caps)):
        x = box[0] + w * cx
        sw = w * 0.045
        d.rounded_rectangle([x - sw / 2, top, x + sw / 2, bot], radius=sw / 2, fill=SLOT)
        cw, ch = w * 0.17, w * 0.10
        y = top + (bot - top) * cp
        t, b = (RED_TOP, RED_BOT) if i == 2 else (GREY_TOP, GREY_BOT)
        for k in range(int(ch)):  # vertical gradient cap
            f = k / ch
            col = tuple(int(t[j] + (b[j] - t[j]) * f) for j in range(3))
            d.line([x - cw / 2, y - ch / 2 + k, x + cw / 2, y - ch / 2 + k], fill=col)
        d.line([x - cw / 2 + 2, y, x + cw / 2 - 2, y], fill=LINE, width=max(2, int(ch * 0.08)))
    return im.resize((size, size), Image.LANCZOS)

for name, size, mask in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                         ("icon-maskable-512.png", 512, True), ("apple-touch-icon.png", 180, True),
                         ("favicon-32.png", 32, False)]:
    img = draw(size, mask)
    if name == "apple-touch-icon.png":
        img = img.convert("RGB")  # iOS wants no transparency
    img.save(os.path.join(OUT, name), optimize=True)
    print("wrote", name)

# cover.jpg: the app's built-in artwork for downloaded mixes; same design, full bleed, 1400 x 1400 (the size music apps prefer).
# A cover.jpg in the root of the SD card overrides it.
cover = draw(1400, True).convert("RGB")
cover.save(os.path.join(OUT, "cover.jpg"), quality=90, optimize=True, progressive=False)
print("wrote icons/cover.jpg (the app's default artwork for downloaded mixes)")
