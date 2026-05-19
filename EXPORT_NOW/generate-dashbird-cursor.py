#!/usr/bin/env python3
"""Render Dashbird chase wait-cursor frames (matches public/styles.css + wait-cursor.js)."""
from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 64
HOT = 32
DOT_R = 3.5
ORBIT_R = 23
FRAME_MS = 40
WHEEL_PERIOD = 1.35
CHASE_PERIOD = 1.05
FRAMES = int(round((WHEEL_PERIOD * 1000) / FRAME_MS))

COLORS = [
    (255, 155, 122),
    (255, 196, 110),
    (253, 240, 140),
    (142, 252, 219),
    (123, 255, 206),
    (110, 200, 255),
    (183, 169, 255),
    (255, 157, 207),
]

CHASE_DELAYS = [-i * (CHASE_PERIOD / 8) for i in range(8)]


def chase_opacity(t: float, delay: float) -> float:
    phase = (t + delay) % CHASE_PERIOD / CHASE_PERIOD
    if phase <= 0.08:
        return 0.28 + (1.0 - 0.28) * (phase / 0.08)
    if phase <= 0.55:
        return 1.0
    if phase <= 1.0:
        return 1.0 + (0.28 - 1.0) * ((phase - 0.55) / 0.45)
    return 0.28


def render_frame(t: float) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    wheel_deg = (t / WHEEL_PERIOD) * 360.0

    for i, (rgb, delay) in enumerate(zip(COLORS, CHASE_DELAYS)):
        angle = math.radians(wheel_deg + i * 45.0)
        cx = HOT + math.sin(angle) * ORBIT_R
        cy = HOT - math.cos(angle) * ORBIT_R
        op = chase_opacity(t, delay)
        glow_r = DOT_R + 4
        glow = tuple(int(c * op * 0.55) for c in rgb) + (int(255 * op * 0.45),)
        draw.ellipse(
            (cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r),
            fill=glow,
        )
        core = tuple(int(c * op) for c in rgb) + (int(255 * op),)
        draw.ellipse(
            (cx - DOT_R, cy - DOT_R, cx + DOT_R, cy + DOT_R),
            fill=core,
        )

    return img


def main() -> None:
    root = Path(__file__).resolve().parent
    theme = root / "DashbirdChase"
    frames_dir = theme / "frames"
    cursors_dir = theme / "cursors"
    frames_dir.mkdir(parents=True, exist_ok=True)
    cursors_dir.mkdir(parents=True, exist_ok=True)

    config_lines: list[str] = []

    for i in range(FRAMES):
        t = (i / FRAMES) * WHEEL_PERIOD
        frame = render_frame(t)
        name = f"frame-{i:03d}.png"
        path = frames_dir / name
        frame.save(path)
        rel = path.relative_to(theme)
        config_lines.append(f"{SIZE} {HOT} {HOT} {rel} {FRAME_MS}")

    for cursor_name in (
        "progress",
        "wait",
        "left_ptr_watch",
        "watch",
        "half-busy",
    ):
        cfg_path = theme / f"{cursor_name}.cfg"
        cfg_path.write_text("\n".join(config_lines) + "\n", encoding="utf-8")
        out = cursors_dir / cursor_name
        subprocess.run(
            ["xcursorgen", cfg_path.name, f"cursors/{cursor_name}"],
            cwd=theme,
            check=True,
        )

    print(f"Wrote {FRAMES} frames and {5} cursor aliases under {theme}")


if __name__ == "__main__":
    main()
