#!/usr/bin/env python3
"""Regenerate raster sky icons from licensed sources (re-download if needed).

Source URLs (decoded from Brave image-search proxy where applicable):
  comet:     Vecteezy …/038/050/774/…/comet-icon-flat-color-style-illustration-vector.jpg
  eclipse / lunar: iStock …/lunar-eclipse-round-icon.jpg → `lunareclipse.png`
  solar eclipse: ship `solareclipse.png` (or add raw + script) for `solar_eclipse` type.
  supermoon: HiClipart …/supermoon-full-moon-lunar-phase-blue-moon-moon-thumbnail.jpg
  storm:     Vecteezy …/016/754/536/…/orange-explosion-icon-design-free-vector.jpg
  iss:       https://getdrawings.com/free-icon/iss-icon-71.png
  rocket:    Vecteezy …/056/723/475/…/red-and-white-rocket-launch-icon-isolated-on-transparent-background-free-png.png
  starlink:  https://i.pinimg.com/originals/bb/f9/49/bbf949755eb5d2cdf85cae75a596d7e6.jpg
  iridium:   Getty “star sun gold” requires a signed URL (400 without). We ship an
             original gold 8-point star PNG instead (same role in UI).
  rainbow / aurora: Freepik rainbow-with-clouds PNG (10129498) — fetch via Brave image
             proxy or direct cdn-icons-png.freepik.com; saved as public/assets/sky/rainbow.png.

Place inputs in /tmp/skyraw/: comet.jpg, eclipse.jpg, supermoon.jpg,
storm.jpg, iss.png, rocket.png, starlink.jpg — then run: python3 scripts/process_sky_icons.py
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw


def lum(rgb: tuple[int, int, int]) -> float:
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b


def white_to_transparent(im: Image.Image, fuzz: int = 38) -> Image.Image:
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= 255 - fuzz and g >= 255 - fuzz and b >= 255 - fuzz:
                px[x, y] = (0, 0, 0, 0)
    return im


def black_to_transparent(im: Image.Image, fuzz: int = 45) -> Image.Image:
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r <= fuzz and g <= fuzz and b <= fuzz:
                px[x, y] = (0, 0, 0, 0)
    return im


def checkerish_to_transparent(im: Image.Image) -> Image.Image:
    """Remove typical light gray / white checkerboard (hiclipart previews)."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            L = lum((r, g, b))
            d = max(r, g, b) - min(r, g, b)
            if L > 185 and d < 55:
                px[x, y] = (0, 0, 0, 0)
            elif L > 210 and d < 70:
                px[x, y] = (0, 0, 0, 0)
    return im


def trim_transparent(im: Image.Image, pad: int = 2) -> Image.Image:
    bbox = im.getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.width, x1 + pad)
    y1 = min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def save_png(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="PNG", optimize=True)


def make_iridium_star(size: int = 256) -> Image.Image:
    """Gold eight-point star (Iridium-flare stand-in; Getty asset needs signed URL)."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    cx, cy = size / 2, size / 2
    R = size * 0.38
    inner = R * 0.42
    pts = []
    for i in range(16):
        ang = -math.pi / 2 + i * (math.pi / 8)
        rad = R if i % 2 == 0 else inner
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    pts_i = [(int(round(p[0])), int(round(p[1]))) for p in pts]
    draw.polygon(pts_i, fill=(255, 224, 140, 255), outline=(184, 132, 48, 255))
    return im


def main() -> None:
    raw = Path("/tmp/skyraw")
    out = Path("/home/jaybird/jayprograms/dashbird/public/assets/sky")

    if (raw / "comet.jpg").exists():
        c = Image.open(raw / "comet.jpg")
        c = white_to_transparent(c, 42)
        save_png(trim_transparent(c), out / "comet.png")

    if (raw / "eclipse.jpg").exists():
        e = Image.open(raw / "eclipse.jpg")
        e = white_to_transparent(e, 40)
        save_png(trim_transparent(e), out / "lunareclipse.png")

    if (raw / "supermoon.jpg").exists():
        s = Image.open(raw / "supermoon.jpg")
        s = checkerish_to_transparent(s)
        s = white_to_transparent(s, 30)
        save_png(trim_transparent(s), out / "supermoon.png")

    if (raw / "storm.jpg").exists():
        st = Image.open(raw / "storm.jpg")
        st = white_to_transparent(st, 42)
        save_png(trim_transparent(st), out / "geomagnetic.png")

    if (raw / "iss.png").exists():
        iss = Image.open(raw / "iss.png")
        iss = black_to_transparent(iss, 48)
        save_png(trim_transparent(iss), out / "iss.png")

    if (raw / "rocket.png").exists():
        r = Image.open(raw / "rocket.png")
        r = black_to_transparent(r, 42)
        save_png(trim_transparent(r), out / "rocket.png")

    if (raw / "starlink.jpg").exists():
        sl = Image.open(raw / "starlink.jpg")
        sl = white_to_transparent(sl, 42)
        save_png(trim_transparent(sl), out / "starlink.png")

    save_png(trim_transparent(make_iridium_star(256), pad=4), out / "iridium.png")

    print("Wrote:", sorted(p.name for p in out.glob("*.png")))


if __name__ == "__main__":
    main()
