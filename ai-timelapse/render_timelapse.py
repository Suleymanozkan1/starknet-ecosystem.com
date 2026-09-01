#!/usr/bin/env python3
"""Render a cinematic before -> after timelapse video from still images.

This is the local, no-API-key path of the project: it takes two or more
keyframes (before / optional middle / after) and renders an MP4 with held
shots, soft transitions and a continuous slow push-in, which is what makes a
two-frame construction comparison read as a timelapse rather than a slideshow.

The AI path (n8n + Veo 3.1) lives in n8n/ and generates genuinely new motion;
this renderer only interpolates the frames you give it.

Examples
--------
    python3 render_timelapse.py --frames input/before.jpg input/after.jpg
    python3 render_timelapse.py -f a.jpg b.jpg c.jpg --duration 16 --transition wipe
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image

# Aspect presets, as (width, height). 9:16 matches the n8n workflows' output.
PRESETS = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Render a before->after timelapse MP4 from still images.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "-f",
        "--frames",
        nargs="+",
        required=True,
        metavar="IMAGE",
        help="Keyframes in chronological order (at least two): before [middle...] after",
    )
    p.add_argument("-o", "--out", default="output/timelapse.mp4", help="Output MP4 path")
    p.add_argument("--duration", type=float, default=12.0, help="Total video length in seconds")
    p.add_argument("--fps", type=int, default=30, help="Frames per second")
    p.add_argument(
        "--aspect",
        default="9:16",
        choices=sorted(PRESETS),
        help="Output aspect ratio preset",
    )
    p.add_argument(
        "--size",
        default=None,
        metavar="WxH",
        help="Explicit output size, overrides --aspect (e.g. 1440x2560)",
    )
    p.add_argument(
        "--transition",
        default="dissolve",
        choices=("dissolve", "wipe"),
        help="How one keyframe becomes the next",
    )
    p.add_argument(
        "--transition-ratio",
        type=float,
        default=0.55,
        help="Share of the timeline spent transitioning vs. holding (0-1)",
    )
    p.add_argument(
        "--zoom",
        type=float,
        default=1.08,
        help="Ken Burns push-in factor across the whole video (1.0 disables it)",
    )
    p.add_argument("--crf", type=int, default=18, help="x264 quality, lower is better")
    return p.parse_args(argv)


def target_size(args):
    if args.size:
        try:
            w, h = (int(v) for v in args.size.lower().split("x"))
        except ValueError:
            raise SystemExit(f"--size must look like 1080x1920, got {args.size!r}")
    else:
        w, h = PRESETS[args.aspect]
    # x264 with yuv420p needs even dimensions.
    return w - (w % 2), h - (h % 2)


def load_cover(path, size):
    """Load an image and cover-crop it to `size`, preserving its aspect ratio."""
    if not os.path.isfile(path):
        raise SystemExit(f"Input image not found: {path}")
    img = Image.open(path).convert("RGB")
    tw, th = size
    scale = max(tw / img.width, th / img.height)
    resized = img.resize(
        (max(tw, round(img.width * scale)), max(th, round(img.height * scale))),
        Image.LANCZOS,
    )
    left = (resized.width - tw) // 2
    top = (resized.height - th) // 2
    return np.asarray(resized.crop((left, top, left + tw, top + th)), dtype=np.float32)


def smoothstep(x):
    """Ease-in-out curve; keeps transitions from starting and stopping abruptly."""
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def blend(a, b, t, mode):
    """Mix keyframe `a` into `b` at progress `t` (0 -> a, 1 -> b)."""
    if mode == "dissolve":
        return a + (b - a) * smoothstep(t)

    # Soft-edged wipe travelling left to right, with a feathered seam so the
    # boundary reads as a reveal rather than a hard cut.
    w_px = a.shape[1]
    feather = max(1.0, w_px * 0.18)
    edge = smoothstep(t) * (w_px + 2 * feather) - feather
    xs = np.arange(w_px, dtype=np.float32)
    mask = smoothstep((edge - xs) / feather)[None, :, None]
    return a + (b - a) * mask


def build_timeline(n_keys, total_frames, ratio):
    """Split the timeline into alternating hold and transition segments.

    Returns a list of (kind, keyframe_index, length) where kind is "hold" or
    "trans"; a "trans" segment moves from keyframe i to i + 1.
    """
    n_trans = n_keys - 1
    ratio = min(max(ratio, 0.05), 0.95)
    trans_total = int(round(total_frames * ratio))
    hold_total = total_frames - trans_total

    def split(total, parts):
        base, extra = divmod(total, parts)
        return [base + (1 if i < extra else 0) for i in range(parts)]

    trans_lens = split(trans_total, n_trans)
    hold_lens = split(hold_total, n_keys)

    timeline = []
    for i in range(n_keys):
        timeline.append(("hold", i, hold_lens[i]))
        if i < n_trans:
            timeline.append(("trans", i, trans_lens[i]))
    return [seg for seg in timeline if seg[2] > 0]


def main(argv=None):
    args = parse_args(argv)
    if len(args.frames) < 2:
        raise SystemExit("Need at least two keyframes: a before and an after image.")
    if args.duration <= 0 or args.fps <= 0:
        raise SystemExit("--duration and --fps must be positive.")

    try:
        import imageio.v2 as imageio
    except ImportError:
        raise SystemExit("Missing dependency. Run: pip install -r requirements.txt")

    out_w, out_h = target_size(args)
    zoom = max(1.0, args.zoom)

    # Everything is composited on an oversized canvas so the push-in crops into
    # real pixels instead of upscaling a finished frame.
    canvas = (round(out_w * zoom), round(out_h * zoom))
    keys = [load_cover(path, canvas) for path in args.frames]

    total_frames = max(2, int(round(args.duration * args.fps)))
    timeline = build_timeline(len(keys), total_frames, args.transition_ratio)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    writer = imageio.get_writer(
        args.out,
        fps=args.fps,
        codec="libx264",
        pixelformat="yuv420p",
        macro_block_size=None,
        ffmpeg_params=["-crf", str(args.crf), "-preset", "medium", "-movflags", "+faststart"],
    )

    print(
        f"Rendering {total_frames} frames @ {args.fps}fps "
        f"({args.duration:g}s, {out_w}x{out_h}, {args.transition}) -> {args.out}"
    )

    written = 0
    try:
        for kind, idx, length in timeline:
            for i in range(length):
                if kind == "hold":
                    frame = keys[idx]
                else:
                    frame = blend(keys[idx], keys[idx + 1], (i + 1) / length, args.transition)

                # Continuous push-in across the whole video, independent of segments.
                progress = written / max(1, total_frames - 1)
                z = 1.0 + (zoom - 1.0) * smoothstep(progress)
                cw, ch = round(canvas[0] / z), round(canvas[1] / z)
                left = (canvas[0] - cw) // 2
                top = (canvas[1] - ch) // 2
                view = frame[top : top + ch, left : left + cw]

                img = Image.fromarray(np.clip(view, 0, 255).astype(np.uint8))
                if img.size != (out_w, out_h):
                    img = img.resize((out_w, out_h), Image.LANCZOS)
                writer.append_data(np.asarray(img))

                written += 1
                if written % args.fps == 0 or written == total_frames:
                    print(f"  {written}/{total_frames}", end="\r", flush=True)
    finally:
        writer.close()

    print()
    size_mb = os.path.getsize(args.out) / 1e6
    print(f"Done: {args.out} ({written} frames, {size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
