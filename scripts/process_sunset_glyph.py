#!/usr/bin/env python3
"""Rebuild public/icons/weather/sunset-glyph.png from the bundled source PNG.

Removes only the *outer* white canvas: edge-seeded flood fill on near-white
pixels, so interior white streaks on the sun stay intact.

Input:  public/icons/weather/sunset-glyph-source.png
Output: public/icons/weather/sunset-glyph.png
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public/icons/weather/sunset-glyph-source.png"
OUT = ROOT / "public/icons/weather/sunset-glyph.png"


def is_near_white(r: int, g: int, b: int, thresh: int = 242) -> bool:
    return r >= thresh and g >= thresh and b >= thresh


def remove_outer_white_flood(im: Image.Image, thresh: int = 242) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)

    def i(x: int, y: int) -> int:
        return y * w + x

    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            j = i(x, y)
            if seen[j]:
                continue
            r, g, b = px[x, y][:3]
            if is_near_white(r, g, b, thresh):
                seen[j] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            j = i(x, y)
            if seen[j]:
                continue
            r, g, b = px[x, y][:3]
            if is_near_white(r, g, b, thresh):
                seen[j] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or nx >= w or ny < 0 or ny >= h:
                continue
            j = i(nx, ny)
            if seen[j]:
                continue
            r, g, b, _ = px[nx, ny]
            if is_near_white(r, g, b, thresh):
                seen[j] = 1
                q.append((nx, ny))
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


def main() -> None:
    if not SRC.is_file():
        raise SystemExit(f"Missing source: {SRC}")
    raw = Image.open(SRC)
    proc = remove_outer_white_flood(raw, thresh=242)
    proc = trim_transparent(proc, pad=2)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    proc.save(OUT, format="PNG", optimize=True)
    print("Wrote", OUT, proc.size)


if __name__ == "__main__":
    main()
