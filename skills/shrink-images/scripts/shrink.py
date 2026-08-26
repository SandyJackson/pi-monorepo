#!/usr/bin/env python3
"""Shrink JPEG photos to a target byte budget (default <1 MB) with minimal
quality loss, using mozjpeg's cjpeg when available and Pillow as fallback.

Workflow:
  1. Decode + auto-orient + downscale to max_dim (long side) -> PNG (lossless)
  2. Binary-search the highest JPEG quality that fits under the budget
  3. Encode as progressive JPEG

Run with uv (inline dependencies, works in any environment):
  uv run --script shrink.py photos/*.jpg
"""
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.0"]
# ///

import argparse
import os
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageOps

CJPEG = shutil.which("cjpeg")
QMIN, QMAX = 55, 92  # never go below Q55 even if it means exceeding budget


def encode(input_png: Path, out_jpg: Path, quality: int) -> bool:
    if CJPEG:
        r = subprocess.run(
            [CJPEG, "-quality", str(quality), "-progressive",
             "-outfile", str(out_jpg), str(input_png)],
            capture_output=True,
        )
        return r.returncode == 0
    im = Image.open(input_png)
    im.save(out_jpg, "JPEG", quality=quality, progressive=True,
            optimize=True, subsampling="4:2:0")
    return True


def find_quality(input_png: Path, out_jpg: Path, budget: int) -> int:
    """Highest quality (<=QMAX) whose output fits under `budget` bytes."""
    lo, hi = QMIN, QMAX
    best = QMIN
    while lo <= hi:
        mid = (lo + hi) // 2
        if encode(input_png, out_jpg, mid) and os.path.getsize(out_jpg) <= budget:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="input JPEG files")
    ap.add_argument("-m", "--max-dim", type=int, default=2048,
                    help="max long side in px, 0 = keep original size (default 2048)")
    ap.add_argument("-b", "--budget-kb", type=int, default=950,
                    help="target max file size in KB (default 950 = safely <1 MB)")
    ap.add_argument("-s", "--suffix", default="_small",
                    help="output suffix: <name><suffix>.jpg next to each input (default _small)")
    ap.add_argument("-o", "--outdir", default=None,
                    help="optional output dir; defaults to each input's directory")
    args = ap.parse_args()

    for src in [Path(p) for p in args.inputs]:
        outdir = Path(args.outdir) if args.outdir else src.parent
        outdir.mkdir(parents=True, exist_ok=True)
        out = outdir / f"{src.stem}{args.suffix}.jpg"
        tmp = outdir / ".shrink_tmp.png"

        im = Image.open(src)
        im = ImageOps.exif_transpose(im)  # bake EXIF orientation, then EXIF is dropped
        if args.max_dim > 0:
            im.thumbnail((args.max_dim, args.max_dim), Image.LANCZOS)
        im.save(tmp, "PNG")
        before = src.stat().st_size

        q = find_quality(tmp, out, args.budget_kb * 1024)
        encode(tmp, out, q)  # final encode at the chosen quality
        size = out.stat().st_size

        status = ""
        if size > args.budget_kb * 1024:
            status = f"  WARNING: {size // 1024} KB still over {args.budget_kb} KB budget — lower --max-dim"
        print(f"{src.name}: {before // 1024} KB -> {size // 1024} KB "
              f"({before / size:.1f}x) {im.width}x{im.height} q{q}{status}")
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
