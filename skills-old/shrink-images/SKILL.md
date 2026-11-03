---
name: shrink-images
description: Shrink JPEG photos to a target file size (default under 1 MB) with minimal quality loss, using mozjpeg and Pillow under uv. Use when the user wants photos smaller for email/chat/upload, needs files under a size budget, or wants a reproducible resize+recompress workflow.
disable-model-invocation: true
---

# Shrink Images

Downscale and recompress JPEG photos so each lands under a byte budget (default **<1 MB**), keeping quality as high as the budget allows. Deterministic, per-image adaptive, no permanent environment setup.

## Setup

Requires only `uv` (installs Pillow on demand via inline dependencies) and optionally `mozjpeg`'s `cjpeg` for better quality-per-byte (`brew install mozjpeg`). The script falls back to Pillow if `cjpeg` is absent.

## Usage

From the skill directory:

```bash
uv run --script scripts/shrink.py <photo1.jpg> [photo2.jpg ...]
```

Options (see `--help` for all):

| Option | Default | Purpose |
|---|---|---|
| `-m, --max-dim` | `2048` | Long side in px. `0` keeps original resolution. |
| `-b, --budget-kb` | `950` | Size target in KB (950 = safely under 1 MB). |
| `-s, --suffix` | `_small` | Outputs land as `<name>_small.jpg` next to each original. |
| `-o, --outdir` | input dir | Override output directory. |

The script prints each file's before/after size and the JPEG quality chosen (higher = better). EXIF/GPS metadata is **stripped** — fine for sharing; mention to the user if they needed to keep it.

## Choosing parameters (model guidance)

The defaults suit documentation/screen viewing. Adjust based on what the user actually needs:

- **<1 MB at any resolution** — start with defaults (2048px + budget 950 KB). The hard cases are detail-dense photos (foliage, textured scenes): at full resolution they often can't fit under 1 MB even at quality 35, so downscaling is required. If a file prints a WARNING (budget not met), lower `--max-dim` (e.g. 1600) rather than pushing quality below ~55, which looks bad.
- **Explicit resolution requirement** (e.g. "keep 2560px", "full resolution") — set `-m` accordingly and check the output sizes; say plainly if the budget can't be met at that resolution.
- **Looser/tighter budget** (e.g. "under 2 MB", "under 500 KB") — set `-b` to `1900` / `480`.
- **Print/archive use** — a higher `-m` (2560+) with a bigger budget, or skip this skill and keep originals.

## Verification

Spot-check quality after shrinking with a structural-similarity metric between the output and a lossless downscale of the original (SSIM ≈ 1 is perfect; >0.94 is typically indistinguishable). Example with the repo venv:

```bash
python - <<'EOF'
from PIL import Image, ImageOps
from skimage.metrics import structural_similarity as ssim
import numpy as np

ref = ImageOps.exif_transpose(Image.open("original.jpg"))
ref.thumbnail((2048, 2048), Image.LANCZOS)
ref = np.asarray(ref.convert("RGB"), dtype=float)
out = np.asarray(Image.open("original_small.jpg").convert("RGB"), dtype=float)
print("SSIM:", ssim(ref, out, channel_axis=2, data_range=255))
EOF
```

## Notes

- The pipeline is deterministic: same inputs + same flags = same outputs.
- Downscale happens losslessly (PNG intermediate), so the only lossy steps are the resize itself and the final JPEG encode.
- `cjpeg` output is visually better than libjpeg-turbo (ImageMagick/Pillow) at the same byte size — prefer installing mozjpeg.
