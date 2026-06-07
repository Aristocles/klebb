#!/usr/bin/env python3
"""Regenerate PWA / apple-touch-icon PNGs at sizes 120/152/180/192/512.

Composes a rounded-square dark tile with the brand dog-head logo
centred. iOS already prints the bookmark label beneath the icon, so
the tile itself carries no wordmark. Run from the repo root:

    python scripts/regen-pwa-icons.py
"""
from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "public" / "icons"
LOGO_SRC = ICONS / "logo-dark.png"  # teal dog on transparent bg

BG = (15, 15, 26, 255)  # #0f0f1a (matches manifest background_color)
SIZES = [120, 152, 180, 192, 512]
LOGO_FRACTION = 0.72  # logo edge length as a fraction of tile edge


def render(size: int) -> Image.Image:
    # work at 4x for nicer downsample
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    radius = int(s * 0.225)  # iOS-ish squircle radius
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=BG)

    logo = Image.open(LOGO_SRC).convert("RGBA")
    # centre the logo's visible bbox, not its full canvas (the source
    # logo has transparent padding which would otherwise pull it
    # off-centre).
    bbox = logo.getbbox()
    cropped = logo.crop(bbox)
    cw, ch = cropped.size
    target = int(s * LOGO_FRACTION)
    scale = target / max(cw, ch)
    new_size = (max(1, int(cw * scale)), max(1, int(ch * scale)))
    cropped = cropped.resize(new_size, Image.LANCZOS)
    lx = (s - new_size[0]) // 2
    ly = (s - new_size[1]) // 2
    img.paste(cropped, (lx, ly), cropped)

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
