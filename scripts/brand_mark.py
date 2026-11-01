#!/usr/bin/env python3
"""Shared brand-mark helpers for the MixWork icon generators.

`public/mixwork.png` is the master logo: an orange node-network mark above a
cream "mixwork" wordmark, both on an opaque dark plate. Icon-sized assets need
the mark alone on a transparent background, so `load_mark()` lifts it out of the
master image (alpha from the mark/background colour separation, un-premultiplied
so anti-aliased edges carry no dark fringe) and the generators compose it onto a
dark squircle plate.
"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "mixwork.png")

# Plate colours sampled either side of the master logo's own background
# (#2E2F2F) so composed icons read as the same surface as the master artwork.
PLATE_TOP = (53, 54, 54)
PLATE_BOT = (36, 37, 37)

# (r - b) at which a pixel counts as fully opaque mark. Solid mark pixels sit
# at 146..152; the plate background sits at -1, so this saturates interior
# pixels while keeping anti-aliased edges partially transparent.
MARK_RB_SCALE = 140.0
ALPHA_FLOOR = 0.06


def load_mark(src=SRC):
    """Return the orange mark as an RGBA image cropped to its bounds."""
    logo = Image.open(src).convert("RGB")
    px = logo.load()
    w, h = logo.size

    # Locate the mark: warm pixels above the wordmark. The wordmark is cream
    # (r - b ~ 15) and the plate is neutral (r - b ~ -1), so (r - b) separates
    # the three regions cleanly.
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r - b > 40 and g - b > 10 and r > 150:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < min_x:
        raise SystemExit(f"no brand mark found in {src}")

    # Sample the plate colour just outside the mark for un-premultiplying.
    bg = px[0, 0]

    pad = int(max(max_x - min_x, max_y - min_y) * 0.04)
    box = (
        max(0, min_x - pad),
        max(0, min_y - pad),
        min(w, max_x + 1 + pad),
        min(h, max_y + 1 + pad),
    )
    crop = logo.crop(box)
    cpx = crop.load()
    cw, ch = crop.size
    out = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    opx = out.load()
    for y in range(ch):
        for x in range(cw):
            r, g, b = cpx[x, y]
            a = (r - b) / MARK_RB_SCALE
            if a <= ALPHA_FLOOR:
                continue
            a = 1.0 if a >= 1.0 else a
            if a < 1.0:
                # Un-premultiply against the plate so the edge keeps the mark's
                # own colour instead of blending toward dark grey.
                r = bg[0] + (r - bg[0]) / a
                g = bg[1] + (g - bg[1]) / a
                b = bg[2] + (b - bg[2]) / a
            opx[x, y] = (
                max(0, min(255, int(round(r)))),
                max(0, min(255, int(round(g)))),
                max(0, min(255, int(round(b)))),
                int(round(a * 255)),
            )
    return out.crop(out.getchannel("A").getbbox() or (0, 0, cw, ch))


def squircle_mask(size, exponent, inset=0):
    """An anti-aliased superellipse mask (continuous-curvature corners)."""
    half = (size - 1 - 2 * inset) / 2.0
    cx = cy = inset + half
    buf = bytearray(size * size)
    for y in range(size):
        dy = abs(y - cy) / half
        dyp = dy ** exponent
        base = y * size
        for x in range(size):
            dx = abs(x - cx) / half
            if dx ** exponent + dyp <= 1.0:
                buf[base + x] = 255
    mask = Image.frombytes("L", (size, size), bytes(buf))
    return mask.filter(ImageFilter.GaussianBlur(0.7))


def plate(size, exponent=5.0, top=PLATE_TOP, bottom=PLATE_BOT, inset=0):
    """Full-bleed superellipse plate with a soft vertical gradient."""
    mask = squircle_mask(size, exponent, inset)
    plate_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / (size - 1)
        colour = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        grad.putpixel((0, y), colour)
    plate_img.paste(grad.resize((size, size)), (0, 0), mask)
    return plate_img


def compose(size, mark, glyph_frac, exponent=5.0, inset=0):
    """Plate of `size` px with `mark` centred at `glyph_frac` of the plate."""
    canvas = plate(size, exponent, inset=inset)
    target = int(size * glyph_frac)
    scale = target / max(mark.width, mark.height)
    w, h = max(1, int(mark.width * scale)), max(1, int(mark.height * scale))
    glyph = mark.resize((w * 2, h * 2), Image.LANCZOS).resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(glyph, ((size - w) // 2, (size - h) // 2))
    return canvas
