#!/usr/bin/env python3
"""Regenerate PWA / apple-touch-icon PNGs at sizes 120/152/180/192/512.

Composes a rounded-square dark tile with the word "Klebb" above the
brand dog-head logo. Run from the repo root:

    python scripts/regen-pwa-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "public" / "icons"
LOGO_SRC = ICONS / "logo-dark.png"  # teal dog on transparent bg

BG = (15, 15, 26, 255)        # #0f0f1a (matches manifest background_color)
TEXT = (255, 255, 255, 255)   # white wordmark
SIZES = [120, 152, 180, 192, 512]
FONT_PATH = "C:/Windows/Fonts/seguibl.ttf"  # Segoe UI Black


def render(size: int) -> Image.Image:
    # work at 4x for nicer downsample
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(s * 0.225)  # iOS-ish squircle radius
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=BG)

    # text: "Klebb"
    font_size = int(s * 0.26)
    font = ImageFont.truetype(FONT_PATH, font_size)
    text = "Klebb"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (s - tw) // 2 - bbox[0]
    ty = int(s * 0.13) - bbox[1]
    draw.text((tx, ty), text, font=font, fill=TEXT)

    # logo
    logo = Image.open(LOGO_SRC).convert("RGBA")
    target_logo = int(s * 0.55)
    logo = logo.resize((target_logo, target_logo), Image.LANCZOS)
    lx = (s - target_logo) // 2
    ly = int(s * 0.42)
    img.paste(logo, (lx, ly), logo)

    out = img.resize((size, size), Image.LANCZOS)
    # iOS masks the icon to a squircle anyway; flatten to RGB on the
    # brand bg so the saved PNG has no semi-transparent fringe pixels.
    flat = Image.new("RGB", out.size, BG[:3])
    flat.paste(out, (0, 0), out)
    return flat


def main() -> None:
    for size in SIZES:
        out = ICONS / f"icon-{size}.png"
        render(size).save(out, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
