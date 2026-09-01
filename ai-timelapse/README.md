# AI Timelapse Video

Before → after timelapse videos from two construction photos, in two flavours:

| | Local renderer | AI pipeline |
| --- | --- | --- |
| Entry point | `render_timelapse.py` | `n8n/*.json` |
| Needs API keys | No | Yes (6 services) |
| Cost | Free | Per-render API cost |
| What it does | Interpolates *your* frames — dissolve/wipe plus a slow push-in | Invents a halfway frame and generates real motion with Veo 3.1 |
| Output | One MP4, any length | 3 × 8s clips + music, stitched to 24s |

Start with the local renderer to see the shot working, move to the AI pipeline
when you want workers moving and the structure genuinely rising.

---

## 1. Local renderer (works right now)

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

## 2. AI pipeline (n8n)

The `n8n/` directory holds the **AI Construction Timelapse Generator** template
by [Alex Safari](https://github.com/Alex-safari/AI-Timelapse-Video) — see
[`n8n/CREDITS.md`](n8n/CREDITS.md). These are n8n workflow graphs, not runnable
scripts: they have to be imported into an n8n instance.

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
