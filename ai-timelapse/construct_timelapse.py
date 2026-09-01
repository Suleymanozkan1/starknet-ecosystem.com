#!/usr/bin/env python3
"""Build a construction timelapse locally, without a GPU or any API key.

A cross-dissolve between a site photo and a finished render is a slideshow: no
new information appears between the two frames. This renderer instead stages
the transformation the way a real timelapse shows it.

  * A construction line sweeps upward, and the finished building appears below
    it while the raw site remains above - the structure rises rather than
    fading in.
  * Just above that line sits a band of skeletal detail derived from the
    finished frame's edges, which reads as formwork, scaffolding and framing:
    the part that is up but not yet clad.
  * A day/night cycle runs across the whole video, so elapsed time is legible
    rather than implied.
  * The build pauses at discrete stage holds, because real progress is lumpy.

It invents no geometry - everything comes from the two frames you supply - but
what it does invent is a plausible *order of assembly*, and that is what makes
the result read as a timelapse.

For genuinely new motion (workers, cranes, traffic) use ai_pipeline.py, which
needs Gemini, Fal.ai and Kie.ai keys.

Example
-------
    python3 construct_timelapse.py --before site.jpg --after render.jpg \
        --duration 20 --stages 5 --days 3
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

PRESETS = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Render a staged construction timelapse from a before and an after image.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--before", required=True, help="Site / initial state image")
    p.add_argument("--after", required=True, help="Finished / final state image")
    p.add_argument("-o", "--out", default="output/construction.mp4", help="Output MP4")
    p.add_argument("--duration", type=float, default=20.0, help="Total length in seconds")
    p.add_argument("--fps", type=int, default=30, help="Frames per second")
    p.add_argument("--aspect", default="9:16", choices=sorted(PRESETS), help="Aspect preset")
    p.add_argument("--size", default=None, metavar="WxH", help="Explicit size, overrides --aspect")
    p.add_argument("--stages", type=int, default=5, help="Discrete build stages to pause on")
    p.add_argument("--days", type=float, default=3.0, help="Day/night cycles across the video")
    p.add_argument(
        "--daylight",
        type=float,
        default=0.45,
        help="Strength of the day/night cycle, 0 disables it",
    )
    p.add_argument(
        "--skeleton",
        type=float,
        default=0.22,
        help="Height of the scaffolding band, as a fraction of the frame",
    )
    p.add_argument("--zoom", type=float, default=1.10, help="Ken Burns push-in over the video")
    p.add_argument(
        "--settle",
        type=float,
        default=0.12,
        help="Share of the video held on the finished building at the end",
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
    return w - (w % 2), h - (h % 2)


def load_cover(path, size):
    if not os.path.isfile(path):
        raise SystemExit(f"Input image not found: {path}")
    img = Image.open(path).convert("RGB")
    tw, th = size
    scale = max(tw / img.width, th / img.height)
    img = img.resize((max(tw, round(img.width * scale)), max(th, round(img.height * scale))), Image.LANCZOS)
    left, top = (img.width - tw) // 2, (img.height - th) // 2
    return img.crop((left, top, left + tw, top + th))


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def make_skeleton(finished_img):
    """Derive a formwork-like rendering from the finished frame.

    Edges become bright lines on a desaturated, concrete-toned base, which is
    close to how a structure looks once it is up but not yet clad.
    """
    grey = finished_img.convert("L")
    edges = grey.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.MaxFilter(3))
    edges = np.asarray(edges, dtype=np.float32) / 255.0
    edges = np.clip(edges * 2.6, 0.0, 1.0)

    base = np.asarray(grey, dtype=np.float32)[..., None]
    # Cool grey concrete, lifted toward the raw-material end of the palette.
    concrete = base * np.array([0.62, 0.63, 0.66], dtype=np.float32) + 46.0
    timber = np.array([196.0, 158.0, 104.0], dtype=np.float32)
    return np.clip(concrete + edges[..., None] * timber, 0, 255)


def build_curve(total_frames, stages, settle):
    """Progress of the construction line over time, 0 (site) to 1 (finished).

    Real builds advance in bursts and then pause for inspection, so the curve
    is a staircase with eased risers rather than a straight ramp.
    """
    settle_frames = int(total_frames * np.clip(settle, 0.0, 0.6))
    build_frames = max(1, total_frames - settle_frames)
    stages = max(1, stages)

    t = np.linspace(0.0, 1.0, build_frames, endpoint=False)
    scaled = t * stages
    index = np.floor(scaled)
    within = scaled - index
    # 70% of each stage rises, the last 30% holds.
    risen = smoothstep(np.clip(within / 0.7, 0.0, 1.0))
    curve = (index + risen) / stages
    return np.concatenate([curve, np.ones(settle_frames, dtype=np.float32)])


def daylight(t, days, strength):
    """Multiplicative warm/cool tint and brightness for the time of day."""
    if strength <= 0:
        return np.ones(3, dtype=np.float32)
    phase = 2.0 * np.pi * days * t
    sun = np.sin(phase)  # +1 midday, -1 night
    brightness = 1.0 + 0.30 * sun * strength
    warmth = np.array([1.0 + 0.16 * strength * (1.0 - sun),
                       1.0,
                       1.0 + 0.20 * strength * sun], dtype=np.float32)
    return np.clip(brightness * warmth, 0.25, 1.9).astype(np.float32)


def main(argv=None):
    args = parse_args(argv)
    if args.duration <= 0 or args.fps <= 0:
        raise SystemExit("--duration and --fps must be positive.")
    try:
        import imageio.v2 as imageio
    except ImportError:
        raise SystemExit("Missing dependency. Run: pip install -r requirements.txt")

    out_w, out_h = target_size(args)
    zoom = max(1.0, args.zoom)
    canvas = (round(out_w * zoom), round(out_h * zoom))

    before_img = load_cover(args.before, canvas)
    after_img = load_cover(args.after, canvas)
    before = np.asarray(before_img, dtype=np.float32)
    after = np.asarray(after_img, dtype=np.float32)
    skeleton = make_skeleton(after_img)

    cw, ch = canvas
    total_frames = max(2, int(round(args.duration * args.fps)))
    curve = build_curve(total_frames, args.stages, args.settle)

    # Row coordinates as a column vector, normalised so 0 is the bottom of the
    # frame and 1 the top - the direction construction actually grows.
    rows = np.linspace(1.0, 0.0, ch, dtype=np.float32)[:, None, None]
    band = max(1e-3, args.skeleton)
    feather = band * 0.45

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
        f"Rendering {total_frames} frames @ {args.fps}fps ({args.duration:g}s, "
        f"{out_w}x{out_h}, {args.stages} stages, {args.days:g} day cycles) -> {args.out}"
    )

    try:
        for i in range(total_frames):
            t = i / max(1, total_frames - 1)
            progress = float(curve[i])

            # The clad line; the scaffolding band sits just above it.
            clad_y = progress * (1.0 + band)
            m_clad = smoothstep((clad_y - rows) / feather)
            m_built = smoothstep((clad_y + band - rows) / feather)
            m_skel = np.clip(m_built - m_clad, 0.0, 1.0)

            frame = before * (1.0 - m_built) + skeleton * m_skel + after * m_clad

            # Once finished, let the scene settle into its final grade.
            if progress >= 1.0:
                frame = after

            frame = frame * daylight(t, args.days, args.daylight)

            z = 1.0 + (zoom - 1.0) * smoothstep(t)
            vw, vh = round(cw / z), round(ch / z)
            left, top = (cw - vw) // 2, (ch - vh) // 2
            view = np.clip(frame[top : top + vh, left : left + vw], 0, 255).astype(np.uint8)

            img = Image.fromarray(view)
            if img.size != (out_w, out_h):
                img = img.resize((out_w, out_h), Image.LANCZOS)
            writer.append_data(np.asarray(img))

            if (i + 1) % args.fps == 0 or i + 1 == total_frames:
                print(f"  {i + 1}/{total_frames}", end="\r", flush=True)
    finally:
        writer.close()

    print(f"\nDone: {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
