#!/usr/bin/env python3
"""Generate the MixCWork system-tray icons.

Composes the orange node-network mark (lifted from `public/mixcwork.png`) on a
transparent canvas so it reads against both light and dark menu bars /
taskbars. Emits:
  resources/tray/tray-icon.png         48x48  Linux
  resources/tray/tray-icon.ico         16/32/48  Windows
  resources/tray/tray-icon-mac.png     22x22  macOS menu bar
  resources/tray/tray-icon-mac@2x.png  44x44  macOS Retina menu bar

The old implementation shelled out to ImageMagick; this one only needs Pillow,
matching the other icon generators. Idempotent.
"""
import os

from PIL import Image

from brand_mark import ROOT, SRC, load_mark

OUT_DIR = os.path.join(ROOT, "resources", "tray")
PADDING_FRAC = 0.02


def tray_icon(mark, size):
    """The mark centred on a transparent `size`x`size` canvas."""
    box = int(size * (1 - 2 * PADDING_FRAC))
    scale = box / max(mark.width, mark.height)
    w, h = max(1, int(mark.width * scale)), max(1, int(mark.height * scale))
    glyph = mark.resize((w * 2, h * 2), Image.LANCZOS).resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(glyph, ((size - w) // 2, (size - h) // 2))
    return canvas


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    mark = load_mark(SRC)

    tray_icon(mark, 48).save(os.path.join(OUT_DIR, "tray-icon.png"))
    print("wrote tray-icon.png (48x48)")

    tray_icon(mark, 48).save(
        os.path.join(OUT_DIR, "tray-icon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    print("wrote tray-icon.ico (16/32/48)")

    tray_icon(mark, 22).save(os.path.join(OUT_DIR, "tray-icon-mac.png"))
    tray_icon(mark, 44).save(os.path.join(OUT_DIR, "tray-icon-mac@2x.png"))
    print("wrote tray-icon-mac.png (22x22) and tray-icon-mac@2x.png (44x44)")


if __name__ == "__main__":
    main()
