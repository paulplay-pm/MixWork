#!/usr/bin/env python3
"""Generate the small-size MixWork brand mark for tiny UI contexts.

The master logo (`public/mixwork.png`) carries a wordmark that is unreadable
below ~64px, so small usages (16px title bar, 18px context-menu icon, 34px
export card) ship a squircle badge instead: a full-bleed dark plate carrying
the orange node-network mark, echoing the app icon.

The squircle has transparent corners, so the badge works on both light and
dark backgrounds. Emits:
  public/mixwork-small.png                     512x512
  enterprise_server/web/public/brand/…          (same file, when present)
  enterprise_server/web-dist/brand/…            (built console output, when present)

Idempotent; re-run after swapping the source logo.
"""
import os
import shutil

from brand_mark import ROOT, SRC, compose, load_mark

OUT = os.path.join(ROOT, "public", "mixwork-small.png")
COPIES = [
    os.path.join(ROOT, "enterprise_server", "web", "public", "brand", "mixwork-small.png"),
    os.path.join(ROOT, "enterprise_server", "web-dist", "brand", "mixwork-small.png"),
]

SIZE = 512
GLYPH_FRAC = 0.74
SUPER_EXP = 4.5


def main():
    mark = load_mark(SRC)
    compose(SIZE, mark, GLYPH_FRAC, SUPER_EXP).save(OUT)
    print(f"wrote {OUT}")
    for target in COPIES:
        if os.path.isdir(os.path.dirname(target)):
            shutil.copyfile(OUT, target)
            print(f"copied -> {target}")


if __name__ == "__main__":
    main()
