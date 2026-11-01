#!/usr/bin/env python3
"""Generate the MixWork app icon for macOS and Windows.

Lifts the orange node-network mark out of the master logo
(`public/mixwork.png`, mark + wordmark on an opaque dark plate) and composites
it onto a rounded-square plate whose colours match that master background
(superellipse/squircle corners, subtle vertical gradient). Emits:
  resources/app-icon/app-icon.png    1024x1024 macOS icon (inset squircle, dev
                                      Dock / window icon)
  resources/app-icon/icon.icns       macOS packaging iconset (all mac sizes)
  resources/app-icon/app-icon.ico    Windows multi-size icon (16..256, full-bleed
                                      squircle) for the taskbar / window icon

The macOS icon is inset to Apple's 824px Dock grid; the Windows icon is
full-bleed (taskbar icons fill the box). Idempotent; re-run after swapping the
source logo.
"""
import os
import subprocess
import sys

from PIL import Image

from brand_mark import SRC, compose, load_mark

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "resources", "app-icon")
OUT_PNG = os.path.join(OUT_DIR, "app-icon.png")
OUT_ICNS = os.path.join(OUT_DIR, "icon.icns")
OUT_ICO = os.path.join(OUT_DIR, "app-icon.ico")

CANVAS = 1024
# Apple's macOS icon grid: the squircle occupies 824px centered on the 1024
# canvas (100px transparent margin per side). A full-bleed plate renders ~24%
# wider than neighboring apps in the Dock, so the plate is inset, not full-bleed.
PLATE_INSET = 100
PLATE_SIZE = CANVAS - 2 * PLATE_INSET  # 824
GLYPH_FRAC = 0.60   # mark sized relative to the plate so it clears the corners
SUPER_EXP = 5.0     # superellipse exponent: 5.0 approximates the macOS squircle curvature
# Windows .ico entries (includes 256 for crisp high-DPI taskbar rendering).
WIN_ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    mark = load_mark(SRC)
    print(f"source mark: {mark.width}x{mark.height} from {SRC}")

    # --- macOS: inset the 824px squircle on the 1024 Dock grid ---
    mac_plate = compose(PLATE_SIZE, mark, GLYPH_FRAC, SUPER_EXP)
    final = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    final.alpha_composite(mac_plate, (PLATE_INSET, PLATE_INSET))
    final.save(OUT_PNG)
    print(f"wrote {OUT_PNG}")

    # Build the .iconset for a native .icns (macOS sizes).
    iconset = os.path.join(OUT_DIR, "MixWork.iconset")
    os.makedirs(iconset, exist_ok=True)
    # (filename, pixel size)
    specs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, px in specs:
        final.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    if subprocess.run(["iconutil", "-c", "icns", iconset, "-o", OUT_ICNS]).returncode != 0:
        print("iconutil failed (iconutil only exists on macOS)", file=sys.stderr)
        sys.exit(1)
    for name, _ in specs:
        os.remove(os.path.join(iconset, name))
    os.rmdir(iconset)
    print(f"wrote {OUT_ICNS}")

    # --- Windows: full-bleed squircle, multi-size .ico ---
    # Windows taskbar/window icons fill the box (no Dock-style inset), so the
    # squircle is rendered edge-to-edge at the full 1024 canvas. PIL writes each
    # size downsampled from this high-res source (256 entry keeps it crisp on
    # high-DPI displays).
    win_plate = compose(CANVAS, mark, GLYPH_FRAC, SUPER_EXP)
    win_plate.save(OUT_ICO, sizes=WIN_ICO_SIZES)
    print(f"wrote {OUT_ICO}")


if __name__ == "__main__":
    main()
