#!/usr/bin/env python3
"""Generate an AI construction timelapse from a before and an after photo.

This is a runnable port of the n8n graphs in n8n/, which are workflow
definitions rather than code. The pipeline is the part that makes the result a
timelapse instead of a dissolve: a vision model invents a plausible halfway
state, an image model renders it, and a video model generates real motion
between consecutive frames.

    before ──┐
             ├─> [Gemini] middle-frame prompt ─> [Fal] middle image
    after  ──┘
                                                       │
    [Gemini] three director prompts <──────────────────┤
             │                                         │
             ├─> [Veo] clip 1  (before -> middle) <─────┤
             ├─> [Veo] clip 2  (middle -> after)  <─────┤
             └─> [Veo] clip 3  (after, reveal)    <─────┘
                        │
                        └─> ffmpeg concat -> final MP4

Three paid services are required: Google Gemini, Fal.ai and Kie.ai. The
upstream template also used Airtable, OpenRouter and Shotstack; the job queue
is unnecessary for a single render, Gemini returns structured JSON directly,
and stitching is done locally with ffmpeg.

Run with --dry-run first: it prints every prompt and request that would be
sent, resolves nothing over the network, and costs nothing.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
FAL_EDIT_URL = "https://queue.fal.run/fal-ai/nano-banana-pro/edit"
FAL_UPLOAD_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate"
KIE_GENERATE_URL = "https://api.kie.ai/api/v1/veo/generate"
KIE_STATUS_URL = "https://api.kie.ai/api/v1/veo/record-info"

# Ported verbatim from "Generate middle image prompt" in 01-part1-generate.json.
MIDDLE_FRAME_SYSTEM = """\
# SYSTEM ROLE: AI Construction Workflow Architect
You are an expert Prompt Engineer specializing in high-end construction,
architectural, and infrastructure timelapses. Your goal is to generate a
"Middle Image Prompt" that bridges a [Start Frame] and an [End Frame].

## LOGIC PARAMETERS:
- **Phase**: Exactly 50-60% completion. This is the "Bridge Frame."
- **Physics**: Do not allow "magic growth." Transformation must look physical.
- **Goal**: Create a logical motion path for Video AI (Veo/Kling/Sora) to
  prevent morphing and flickering.

## OUTPUT PROMPT STRUCTURE:
1. **Camera Anchor**: Must specify "Locked-off static camera" and "identical
   angle to reference frames" to ensure zero perspective drift.
2. **The "WIP" Edge**: Describe a sharp "work-in-progress" line where
   new materials (asphalt, wood, steel) meet the old or raw surface.
3. **Skeletal Exposure**: Reveal internal elements that are usually
   hidden in the final shot (e.g., rebar in a road, studs in a wall,
   joists on a porch).
4. **Active Staging**: Modular items (furniture, equipment, tools) should
   be placed in "transit" positions-not yet in their final spots.
5. **Lighting Buffer**: Calculate a time-of-day halfway between the Start
   and End frames (e.g., if Start is dawn and End is dusk, specify 2 PM).

## FINAL OUTPUT INSTRUCTIONS:
- Generate a single, cohesive paragraph for use in an Image Generator.
- Include high-fidelity keywords: "4K," "photorealistic," "sharp textures."
- Return the paragraph only, with no preamble and no markdown."""

# Ported from "Generate video prompts", with the free-text output replaced by a
# JSON contract so the OpenRouter parsing agent is no longer needed.
VIDEO_PROMPTS_SYSTEM = """\
# SYSTEM ROLE: Technical Director for AI Construction Timelapses
You are an expert Video Prompt Engineer. Your task is to analyze three
provided images ([Initial State], [Mid-Transformation], and [Final Hero Shot])
and generate a sequence of three cohesive video prompts.

## CORE DIRECTIVES:
- **Consistent Slow Motion**: Every clip MUST feature "slow, controlled
  cinematic camera movement" (e.g., slow push-in, dolly, or subtle pan)
  to maintain premium production value.
- **Physics**: Transitions must be mechanical and additive, avoiding "AI
  morphing" or "material melting".
- **Pacing**: Use "high-speed motion blur" for workers during construction
  phases (Clips 1 & 2), but "static stillness" for the final reveal (Clip 3)
  to emphasize the pristine finish.

## VIDEO PROMPT STRUCTURE:
1. **Camera**: Specify a slow, cinematic camera movement (push-in, dolly,
   or pan), 4K photorealistic.
2. **Action**: Describe the physical transformation using mechanical verbs
   (e.g., "bolting," "rolling," "snapping").
3. **No Characters**: Ensure the final shot is pristine and empty,
   focusing entirely on the architecture and design.
4. **Lighting**: Match the transition between your reference images.
5. **SFX**: Layered, realistic audio cues.

## THE SEQUENCE LOGIC:
- **Clip 1 (Start to Mid)**: Raw framing/base layering. Slow camera pan.
- **Clip 2 (Mid to End)**: Finishing materials/furniture. Slow camera dolly.
- **Clip 3 (Final Reveal)**: No characters; pristine atmosphere. Slow push-in.

## OUTPUT INSTRUCTIONS:
- Each prompt is a clear, descriptive paragraph including specific SFX cues.
- DO NOT include negative prompts."""

CLIP_SCHEMA = {
    "type": "object",
    "properties": {
        "clip1_prompt": {"type": "string"},
        "clip2_prompt": {"type": "string"},
        "clip3_prompt": {"type": "string"},
    },
    "required": ["clip1_prompt", "clip2_prompt", "clip3_prompt"],
}


class PipelineError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def request_json(url, method="GET", headers=None, payload=None, timeout=180):
    """Issue an HTTP request and decode a JSON response."""
    data = None
    headers = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode()
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise PipelineError(f"{method} {url} -> HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise PipelineError(f"{method} {url} -> {exc.reason}") from exc
    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise PipelineError(f"{method} {url} -> response was not JSON: {body[:300]!r}")


def download(url, dest, timeout=600):
    req = urllib.request.Request(url, headers={"User-Agent": "ai-timelapse/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as fh:
            while chunk := resp.read(1 << 16):
                fh.write(chunk)
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise PipelineError(f"Could not download {url}: {exc}")
    return dest


def poll(fn, *, label, interval, timeout):
    """Call `fn` until it returns a non-None value, or give up."""
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        result = fn()
        if result is not None:
            return result
        remaining = int(deadline - time.monotonic())
        print(f"  {label}: waiting ({attempt}, {remaining}s left)", end="\r", flush=True)
        time.sleep(interval)
    raise PipelineError(f"{label}: timed out after {timeout}s")


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------


def is_url(value):
    return value.startswith(("http://", "https://"))


def fal_upload(path, fal_key):
    """Upload a local file to Fal storage and return its public URL.

    Fal and Kie fetch reference images over the network, so local paths have to
    become URLs before either can see them.
    """
    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    initiated = request_json(
        f"{FAL_UPLOAD_INITIATE}?storage_type=fal-cdn-v3",
        method="POST",
        headers={"Authorization": f"Key {fal_key}"},
        payload={"content_type": content_type, "file_name": os.path.basename(path)},
    )
    upload_url = initiated.get("upload_url")
    file_url = initiated.get("file_url")
    if not upload_url or not file_url:
        raise PipelineError(f"Unexpected Fal upload response: {json.dumps(initiated)[:300]}")

    with open(path, "rb") as fh:
        body = fh.read()
    req = urllib.request.Request(
        upload_url, data=body, headers={"Content-Type": content_type}, method="PUT"
    )
    try:
        urllib.request.urlopen(req, timeout=300).read()
    except urllib.error.HTTPError as exc:
        raise PipelineError(f"Fal upload PUT failed: HTTP {exc.code}")
    return file_url


def gemini_analyze(system_text, image_paths, api_key, model, schema=None):
    """Send a prompt plus inline images to Gemini and return its answer.

    Images are inlined as base64 because the Gemini REST API does not fetch
    arbitrary URLs on your behalf.
    """
    parts = [{"text": system_text}]
    for path in image_paths:
        with open(path, "rb") as fh:
            blob = fh.read()
        mime = mimetypes.guess_type(path)[0] or "image/jpeg"
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(blob).decode()}})

    payload = {"contents": [{"role": "user", "parts": parts}]}
    if schema is not None:
        payload["generationConfig"] = {
            "responseMimeType": "application/json",
            "responseSchema": schema,
        }

    result = request_json(
        f"{GEMINI_URL.format(model=model)}?key={api_key}", method="POST", payload=payload
    )
    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise PipelineError(f"Unexpected Gemini response: {json.dumps(result)[:400]}")
    return json.loads(text) if schema is not None else text.strip()


def fal_middle_image(prompt, image_urls, aspect_ratio, fal_key, timeout):
    """Render the 50-60% bridge frame with Nano Banana Pro."""
    submitted = request_json(
        FAL_EDIT_URL,
        method="POST",
        headers={"Authorization": f"Key {fal_key}"},
        payload={"prompt": prompt, "image_urls": image_urls, "aspect_ratio": aspect_ratio},
    )
    # Follow the URLs the queue hands back rather than rebuilding them: the n8n
    # subworkflow hardcodes a nano-banana path while submitting to
    # nano-banana-pro, so its polling never matches the request it made.
    status_url = submitted.get("status_url")
    response_url = submitted.get("response_url")
    if not status_url or not response_url:
        raise PipelineError(f"Unexpected Fal submit response: {json.dumps(submitted)[:300]}")

    def check():
        state = request_json(status_url, headers={"Authorization": f"Key {fal_key}"})
        status = state.get("status")
        if status == "COMPLETED":
            return state
        if status in {"FAILED", "ERROR"}:
            raise PipelineError(f"Fal generation failed: {json.dumps(state)[:300]}")
        return None

    poll(check, label="middle image", interval=5, timeout=timeout)
    final = request_json(response_url, headers={"Authorization": f"Key {fal_key}"})
    images = final.get("images") or []
    if not images or not images[0].get("url"):
        raise PipelineError(f"Fal returned no image: {json.dumps(final)[:300]}")
    return images[0]["url"]


def kie_generate_clip(prompt, image_urls, generation_type, aspect_ratio, kie_key, model, timeout):
    """Render one clip with Veo and return its URL."""
    submitted = request_json(
        KIE_GENERATE_URL,
        method="POST",
        headers={"Authorization": f"Bearer {kie_key}"},
        payload={
            "prompt": prompt,
            "model": model,
            "aspectRatio": aspect_ratio,
            "imageUrls": image_urls,
            "generationType": generation_type,
            "enableFallback": True,
        },
    )
    task_id = (submitted.get("data") or {}).get("taskId")
    if not task_id:
        raise PipelineError(f"Kie.ai did not return a taskId: {json.dumps(submitted)[:300]}")

    def check():
        state = request_json(
            f"{KIE_STATUS_URL}?taskId={task_id}", headers={"Authorization": f"Bearer {kie_key}"}
        )
        data = state.get("data") or {}
        flag = data.get("successFlag")
        if flag in (1, "1"):
            urls = (data.get("response") or {}).get("resultUrls") or []
            if not urls:
                raise PipelineError(f"Veo reported success with no URL: {json.dumps(data)[:300]}")
            return urls[0]
        if flag in (2, 3, "2", "3"):
            reason = data.get("errorMessage") or json.dumps(data)[:300]
            raise PipelineError(f"Veo generation failed: {reason}")
        return None

    return poll(check, label=f"clip {generation_type}", interval=10, timeout=timeout)


# --------------------------------------------------------------------------
# Stitching
# --------------------------------------------------------------------------


def ffmpeg_exe():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def stitch(clip_paths, out_path, music_path=None):
    """Concatenate the clips, optionally laying a music bed over them."""
    listing = os.path.join(os.path.dirname(out_path) or ".", "_concat.txt")
    with open(listing, "w") as fh:
        for path in clip_paths:
            fh.write(f"file '{os.path.abspath(path)}'\n")

    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "concat", "-safe", "0", "-i", listing]
    if music_path:
        cmd += ["-i", music_path, "-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-movflags", "+faststart", out_path]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    os.remove(listing)
    if proc.returncode != 0:
        raise PipelineError(f"ffmpeg failed:\n{proc.stderr.strip()[-800:]}")
    return out_path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def load_dotenv(path=".env"):
    """Populate os.environ from a .env file without overriding real env vars."""
    if not os.path.isfile(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Generate an AI construction timelapse from a before and an after image.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--before", required=True, help="Initial state: local path or public URL")
    p.add_argument("--after", required=True, help="Final state: local path or public URL")
    p.add_argument("--out", default="output/ai-timelapse.mp4", help="Final video path")
    p.add_argument("--work-dir", default="output/work", help="Where intermediates are kept")
    p.add_argument("--aspect", default="9:16", help="Aspect ratio passed to both models")
    p.add_argument("--model-video", default="veo3_fast", help="Kie.ai video model")
    p.add_argument("--model-text", default="gemini-2.5-flash", help="Gemini model")
    p.add_argument("--music", default=None, help="Optional audio file to lay over the video")
    p.add_argument("--timeout", type=int, default=900, help="Per-generation timeout in seconds")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the prompts and planned requests without calling any paid API",
    )
    return p.parse_args(argv)


def require_keys(*names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise PipelineError(
            "Missing credentials: "
            + ", ".join(missing)
            + "\nCopy .env.example to .env and fill them in, or export them."
        )
    return [os.environ[n] for n in names]


def local_copy(source, work_dir, stem):
    """Make sure an input exists locally, so Gemini can read its bytes."""
    ext = os.path.splitext(source.split("?")[0])[1] or ".jpg"
    dest = os.path.join(work_dir, stem + ext)
    name = os.path.basename(dest)
    if is_url(source):
        print(f"  fetching {name} from {source[:70]}")
        return download(source, dest)
    if not os.path.isfile(source):
        raise PipelineError(f"Input image not found: {source}")
    with open(source, "rb") as src, open(dest, "wb") as dst:
        dst.write(src.read())
    return dest


def main(argv=None):
    args = parse_args(argv)
    load_dotenv()
    os.makedirs(args.work_dir, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)

    if args.dry_run:
        print("DRY RUN - no network calls, no cost.\n")
        print(f"before        : {args.before}")
        print(f"after         : {args.after}")
        print(f"aspect        : {args.aspect}")
        print(f"video model   : {args.model_video}   text model: {args.model_text}")
        print(f"output        : {args.out}\n")
        for name, keys in (
            ("Gemini", ["GOOGLE_GEMINI_API_KEY"]),
            ("Fal.ai", ["FAL_API_KEY"]),
            ("Kie.ai", ["KIE_API_KEY"]),
        ):
            state = "set" if all(os.environ.get(k) for k in keys) else "MISSING"
            print(f"  {name:8} {','.join(keys):24} {state}")
        print("\nPlanned requests:")
        print(f"  1. POST {GEMINI_URL.format(model=args.model_text)}  (2 images -> middle prompt)")
        print(f"  2. POST {FAL_EDIT_URL}  (2 images -> middle frame)")
        print(f"  3. POST {GEMINI_URL.format(model=args.model_text)}  (3 images -> 3 clip prompts)")
        for i, gt in enumerate(
            ["FIRST_AND_LAST_FRAMES_2_VIDEO"] * 2 + ["FIRST_AND_LAST_FRAMES_2_VIDEO"], 1
        ):
            print(f"  {3 + i}. POST {KIE_GENERATE_URL}  (clip {i}, {gt})")
        print("  7. ffmpeg concat -> " + args.out)
        print("\nMiddle-frame system prompt:\n" + "-" * 60)
        print(MIDDLE_FRAME_SYSTEM)
        print("-" * 60 + "\nClip system prompt:\n" + "-" * 60)
        print(VIDEO_PROMPTS_SYSTEM)
        print("-" * 60)
        return 0

    gemini_key, fal_key, kie_key = require_keys(
        "GOOGLE_GEMINI_API_KEY", "FAL_API_KEY", "KIE_API_KEY"
    )

    print("[1/6] Preparing inputs")
    before_local = local_copy(args.before, args.work_dir, "before")
    after_local = local_copy(args.after, args.work_dir, "after")
    before_url = args.before if is_url(args.before) else fal_upload(before_local, fal_key)
    after_url = args.after if is_url(args.after) else fal_upload(after_local, fal_key)
    print(f"  before -> {before_url[:80]}")
    print(f"  after  -> {after_url[:80]}")

    print("[2/6] Writing the middle-frame prompt (Gemini)")
    middle_prompt = gemini_analyze(
        MIDDLE_FRAME_SYSTEM, [before_local, after_local], gemini_key, args.model_text
    )
    with open(os.path.join(args.work_dir, "middle_prompt.txt"), "w") as fh:
        fh.write(middle_prompt)
    print(f"  {middle_prompt[:150]}...")

    print("[3/6] Rendering the middle frame (Fal.ai)")
    middle_url = fal_middle_image(
        middle_prompt, [before_url, after_url], args.aspect, fal_key, args.timeout
    )
    middle_local = download(middle_url, os.path.join(args.work_dir, "middle.png"))
    print(f"\n  middle -> {middle_url[:80]}")

    print("[4/6] Writing the three clip prompts (Gemini)")
    prompts = gemini_analyze(
        VIDEO_PROMPTS_SYSTEM,
        [before_local, middle_local, after_local],
        gemini_key,
        args.model_text,
        schema=CLIP_SCHEMA,
    )
    with open(os.path.join(args.work_dir, "clip_prompts.json"), "w") as fh:
        json.dump(prompts, fh, indent=2)
    for key in ("clip1_prompt", "clip2_prompt", "clip3_prompt"):
        print(f"  {key}: {prompts[key][:110]}...")

    print("[5/6] Generating three clips (Veo)")
    plan = [
        (prompts["clip1_prompt"], [before_url, middle_url]),
        (prompts["clip2_prompt"], [middle_url, after_url]),
        (prompts["clip3_prompt"], [after_url]),
    ]
    clip_paths = []
    for i, (prompt, urls) in enumerate(plan, 1):
        url = kie_generate_clip(
            prompt,
            urls,
            "FIRST_AND_LAST_FRAMES_2_VIDEO",
            args.aspect,
            kie_key,
            args.model_video,
            args.timeout,
        )
        path = download(url, os.path.join(args.work_dir, f"clip{i}.mp4"))
        clip_paths.append(path)
        print(f"\n  clip {i} -> {path}")

    print("[6/6] Stitching")
    stitch(clip_paths, args.out, args.music)
    size_mb = os.path.getsize(args.out) / 1e6
    print(f"\nDone: {args.out} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PipelineError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
