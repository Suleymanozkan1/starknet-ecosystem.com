# AI Timelapse Video

Before → after timelapse videos from two construction photos, in two flavours:

| | `render_timelapse.py` | `construct_timelapse.py` | `ai_pipeline.py` |
| --- | --- | --- | --- |
| Needs API keys | No | No | Yes (Gemini, Fal.ai, Kie.ai) |
| Needs a GPU | No | No | No (the models run remotely) |
| Cost | Free | Free | Per-render API cost |
| What it does | Holds and dissolves between your frames | Stages the build: the structure rises, scaffolding shows, days pass | Invents a halfway frame and generates real motion with Veo 3.1 |
| Honest description | A slideshow with transitions | A staged reveal built from your two frames | A generated timelapse |

Start with `construct_timelapse.py`: it needs nothing but the two photos and
is the best result available without paying for generation. Move to
`ai_pipeline.py` when you want workers, cranes and traffic that were never in
either photo.

---

## 1. Staged construction timelapse (no keys, no GPU)

```bash
pip install -r requirements.txt

python3 construct_timelapse.py \
  --before input/site.jpg --after input/render.jpg \
  --duration 20 --stages 5 --days 3
```

A cross-dissolve between a site photo and a finished render is a slideshow:
nothing new appears between the two frames. This renderer stages the
transformation instead.

- A construction line sweeps upward; the finished building appears below it
  while the raw site stays above, so the structure **rises** rather than fades.
- Above that line sits a band of skeletal detail derived from the finished
  frame's edges, which reads as formwork and scaffolding.
- A day/night cycle runs across the video, so elapsed time is visible.
- The build pauses at discrete stage holds, because real progress is lumpy.

It invents no geometry. What it invents is a plausible **order of assembly**,
and that is what makes it read as a timelapse.

| Flag | Default | Notes |
| --- | --- | --- |
| `--stages` | `5` | Discrete build stages to pause on. |
| `--days` | `3` | Day/night cycles across the video. |
| `--daylight` | `0.45` | Strength of that cycle; `0` disables it. |
| `--skeleton` | `0.22` | Height of the scaffolding band, as a fraction of the frame. |
| `--settle` | `0.12` | Share of the video held on the finished building. |
| `--zoom` | `1.10` | Ken Burns push-in. `1.0` disables it. |

---

## 2. Simple dissolve renderer

```bash
pip install -r requirements.txt

python3 render_timelapse.py \
  --frames input/before.jpg input/after.jpg \
  --out output/timelapse.mp4 \
  --duration 12 --aspect 9:16
```

`ffmpeg` comes bundled via `imageio-ffmpeg` — nothing to install separately.

### Options

| Flag | Default | Notes |
| --- | --- | --- |
| `-f, --frames` | *required* | Two or more images in chronological order. A middle frame makes the progression far more convincing. |
| `-o, --out` | `output/timelapse.mp4` | Output path. |
| `--duration` | `12` | Seconds. |
| `--fps` | `30` | Frames per second. |
| `--aspect` | `9:16` | `9:16`, `16:9`, `1:1`, `4:5`. Inputs are cover-cropped to fit. |
| `--size` | — | Explicit `WxH`, overrides `--aspect`. |
| `--transition` | `dissolve` | `dissolve` or `wipe` (feathered left-to-right reveal). |
| `--transition-ratio` | `0.55` | Share of the timeline spent moving rather than holding. |
| `--zoom` | `1.08` | Ken Burns push-in across the whole video. `1.0` disables it. |
| `--crf` | `18` | x264 quality; lower is better, larger. |

### Try the bundled sample

`input/sample-before.jpg` and `input/sample-after.jpg` are the example frames
from the upstream template:

```bash
python3 render_timelapse.py -f input/sample-before.jpg input/sample-after.jpg
```

### Getting a good result

- **Shoot from the same spot.** The renderer does not correct for perspective
  drift; a shifted camera reads as a jump cut, not a timelapse.
- **Give it a middle frame** if you have one. Two frames a year apart dissolve
  into mush in the middle; three frames read as progress.
- **Match the crop.** Two images with very different aspect ratios get
  cover-cropped differently and appear to shift.
- `--transition wipe` suits construction before/afters better than `dissolve`
  when the two frames are structurally very different.

---

## 3. AI pipeline

`ai_pipeline.py` is a runnable port of the n8n graphs in `n8n/`, which are
workflow definitions rather than code and need an n8n instance to do anything.
The original template is by
[Alex Safari](https://github.com/Alex-safari/AI-Timelapse-Video) — see
[`n8n/CREDITS.md`](n8n/CREDITS.md).

```bash
cp .env.example .env      # fill in the three keys
python3 ai_pipeline.py --before site.jpg --after render.jpg --dry-run
python3 ai_pipeline.py --before site.jpg --after render.jpg
```

`--dry-run` prints every prompt and request that would be sent, touches no
network and costs nothing. Run it first.

The port drops three of the six services the template used: the Airtable job
queue is unnecessary for a single render, Gemini returns structured JSON so the
OpenRouter parsing agent is redundant, and stitching is done locally with
ffmpeg instead of Shotstack. Gemini, Fal.ai and Kie.ai remain.

> The n8n subworkflow submits its image edit to `fal-ai/nano-banana-pro/edit`
> but polls `fal-ai/nano-banana/requests/...` — mismatched model paths.
> `ai_pipeline.py` follows the `status_url` the queue returns instead.

### How it works

Rather than asking a video model to jump straight from before to after — which
produces morphing and flicker — it generates a **middle bridge frame** at
50–60% completion first, then writes three cohesive clip prompts and renders
them:

1. Airtable queue supplies the Initial and Final images (`Status = Pending`).
2. Gemini 2.5 Flash writes a prompt for the halfway state.
3. Fal.ai Nanobanana2 renders that middle frame.
4. Gemini writes three director-style clip prompts (start→mid, mid→end, reveal).
5. Kie.ai Veo 3.1 fast renders three 8-second clips from frame pairs.
6. Kie.ai Suno generates a matching music bed.
7. Shotstack stitches clips + music into a 24-second video.
8. The final URL goes back to Airtable and `Status` flips to `Done`.

### Setup

1. Install n8n (`npx n8n`) or use n8n Cloud.
2. Import the workflows in numeric order — the subworkflows (`03`, `04`, `05`)
   must exist before `01` can call them.
3. Copy the [Airtable base template](https://airtable.com/appP9Tan7f1mONBsR/shruypLYIy5GxVVMH)
   and match the field names listed below.
4. Copy `.env.example` to `.env`, fill it in, and set the matching credentials
   in n8n. Six services are required: Airtable, Google Gemini, OpenRouter,
   Fal.ai, Kie.ai, Shotstack.
5. **Repoint the Suno callback.** Workflow `01` ships with the template
   author's webhook URL (`https://loopsera.app.n8n.cloud/webhook/suno-callback`).
   Replace it with your own instance's URL for the webhook in workflow `02`,
   or the music step will never call you back.
6. Add a row with `Status = Pending` and both image URLs, then run workflow `01`.

### Required Airtable fields

`ID`, `Status`, `Initial Image`, `Final Image`, `Middle Image`,
`Middle Image Prompt`, `First Video Prompt`, `Second Video Prompt`,
`Third Video Prompt`, `Video Clip 1`, `Video Clip 2`, `Video Clip 3`,
`Music URL`, `Final Video`.

The image fields need publicly reachable URLs — Fal.ai and Kie.ai fetch them
directly, so local file paths will not work.

---

## Layout

```
ai-timelapse/
├── render_timelapse.py     # local renderer, no API keys
├── requirements.txt
├── .env.example            # credentials for the n8n pipeline
├── input/                  # source photos (samples tracked, yours ignored)
├── output/                 # rendered videos (gitignored)
└── n8n/                    # AI pipeline workflow graphs + credits
```
