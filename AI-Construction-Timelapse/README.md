# AI Construction Timelapse

Upload a photo of a construction site and a render or photo of the finished
result. The application analyses both, works out a plausible construction
sequence between them, and generates an accelerated timelapse with
[Wan2.1 FLF2V](https://github.com/Wan-Video/Wan2.1) (First-Last-Frame-to-Video).

The point is not to morph one image into the other. The stage planner decides
what work actually has to happen — excavation, foundation, frame, slabs, roof,
envelope, glazing, facade, landscaping — and writes prompts that ask the model
for that sequence, with the final building geometry pinned to the AFTER image.

---

## 1. What it does

```
BEFORE image ─┐
              ├─> image analysis ─> construction stage planner ─> stage prompts
AFTER image ──┘                                                        │
                                                                       ▼
                                      Wan2.1 FLF2V ─> post-processing ─> MP4
```

- **Image analysis** measures camera angle, horizon, building footprint, floor
  banding, openings, sky, vegetation, ground, shadows and apparent construction
  progress from each still.
- **The planner** picks the stage catalogue for the construction type, then
  selects the span from where the BEFORE image already sits to completion. If
  the frame is already up, excavation and foundation are skipped.
- **The prompt engine** writes one prompt per segment naming the work in order,
  with the machinery and materials for each stage, plus a strong negative
  prompt and an explicit geometry lock.
- **Wan2.1 FLF2V** generates the frames. The AFTER image is the last frame, so
  it conditions the ending directly.
- **Verification** compares the generated final frame against the AFTER image
  with SSIM and warns if the building drifted.
- **Post-processing** retimes, optionally interpolates and blurs, and encodes
  H.264.

## 2. Architecture

```
AI-Construction-Timelapse/
├── app.py                        entry point and CLI flags
├── src/
│   ├── pipeline.py               six-step orchestration
│   ├── analysis/
│   │   ├── image_analyzer.py     per-image measurement
│   │   └── construction_detector.py  camera comparison, stage detection, alignment
│   ├── planning/
│   │   ├── stage_planner.py      stage catalogues and span selection
│   │   └── prompt_engine.py      positive and negative prompt construction
│   ├── models/
│   │   └── wan_flf2v.py          the only module that imports `wan`
│   ├── video/
│   │   ├── postprocess.py        ffmpeg filters and encoding
│   │   └── exporter.py           segment joining and export
│   ├── utils/
│   │   ├── config.py             pydantic settings from .env
│   │   ├── gpu_utils.py          CUDA detection, VRAM budget, ffmpeg discovery
│   │   └── image_utils.py        upload validation, aspect handling, SSIM
│   └── ui/interface.py           Gradio front end
└── tests/                        pytest suite, runs without the model
```

All Wan-specific code lives in `src/models/wan_flf2v.py`. Everything else talks
to `WanFLF2VGenerator`, so mock mode and real generation differ by configuration
alone.

### How longer videos are built

Wan2.1 FLF2V emits 81 frames per call at 16 fps, a little over five seconds, and
it needs a real first and last frame — but you only supply two. So a 10 or 15
second video runs in two passes. The first is a draft across the whole
transformation. Intermediate keyframes are lifted out of that draft at the stage
boundaries the planner chose, and each consecutive pair is regenerated at full
length with the prompt for just those stages. Segments share their boundary
frames, so the joins are seamless and each stage gets its own 81 frames instead
of a handful inside one rushed clip.

| Duration | Wan calls | Frames |
| --- | --- | --- |
| 5 s | 1 | 81 |
| 10 s | 1 draft + 2 | 161 |
| 15 s | 1 draft + 3 | 241 |

## 3. Requirements

- Python 3.11 or newer
- ffmpeg (a system install is preferred; `imageio-ffmpeg` is the fallback)
- For real generation: an NVIDIA GPU, CUDA 12.x, and the Wan2.1 checkpoint
- Roughly 90 GB of free disk for the checkpoint

## 4. GPU requirements

Wan2.1 FLF2V is a **14B** model and there is no smaller first-last-frame
variant. Peak VRAM, from the official README:

| Resolution | `OFFLOAD_MODEL=false` | `OFFLOAD_MODEL=true` |
| --- | --- | --- |
| 720p | ~60 GB | ~20 GB |
| 480p | ~45 GB | ~15 GB |

Practical guidance:

- **80 GB (A100, H100):** 720p with offloading off; fastest.
- **40–48 GB (A6000, A100 40GB, L40S):** 720p with `OFFLOAD_MODEL=true`.
- **24 GB (RTX 3090/4090):** 480p with `OFFLOAD_MODEL=true` and `T5_CPU=true`.
  Expect it to be tight.
- **Under 16 GB:** not usable. Use `MOCK_MODE=true` for the UI, or rent a GPU.

**CPU generation is not supported and will not be made to work.** The 14B model
needs well over 60 GB of system RAM and would take days per clip. The
application detects this and refuses with an explanation rather than starting a
run that cannot finish. `MOCK_MODE` exists precisely so the rest of the
application can be developed and tested on any machine.

## 5. Installation

```bash
git clone <your-fork-url> AI-Construction-Timelapse
cd AI-Construction-Timelapse

python3.11 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate

# Install PyTorch for your CUDA version FIRST, so nothing overwrites it later.
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
# CPU only (MOCK_MODE and tests):
# pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

pip install -r requirements.txt
cp .env.example .env
```

ffmpeg, if you do not have it:

```bash
sudo apt install ffmpeg          # Debian / Ubuntu
brew install ffmpeg              # macOS
```

## 6. Wan2.1 model installation

Two pieces are needed: the code and the weights.

**Code** — clone the official repository and either install it or point
`WAN_REPO_PATH` at the clone:

```bash
git clone https://github.com/Wan-Video/Wan2.1 /opt/Wan2.1
cd /opt/Wan2.1
pip install -r requirements.txt
```

`flash_attn` in that file needs a CUDA toolchain and often fails to build. It is
optional: Wan falls back to `torch.nn.functional.scaled_dot_product_attention`.

Then, in `.env`:

```ini
WAN_REPO_PATH=/opt/Wan2.1
```

**Weights** — roughly **82 GB**:

```bash
pip install "huggingface_hub[cli]"
hf download Wan-AI/Wan2.1-FLF2V-14B-720P \
    --local-dir ./models/Wan2.1-FLF2V-14B-720P
```

or from ModelScope:

```bash
pip install modelscope
modelscope download Wan-AI/Wan2.1-FLF2V-14B-720P \
    --local_dir ./models/Wan2.1-FLF2V-14B-720P
```

The application checks the directory before loading and tells you exactly what
is missing if the download was interrupted.

**Note on resolution:** the official FLF2V checkpoint is
`Wan2.1-FLF2V-14B-720P` and targets 720p. Its supported sizes are `1280*720`,
`720*1280`, `832*480` and `480*832`. There is no 1080p first-last-frame
checkpoint, and no 1.3B one — the small `T2V-1.3B` model is text-to-video and
cannot take your images as input. Square 1:1 output is produced by generating
at the nearest supported portrait size and cropping during post-processing.

## 7. Configuration

Every setting lives in `.env`; see `.env.example` for the annotated list. The
ones that matter most:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAN_MODEL_PATH` | `./models/Wan2.1-FLF2V-14B-720P` | Checkpoint directory |
| `WAN_REPO_PATH` | unset | Your Wan2.1 clone, if not pip-installed |
| `MOCK_MODE` | `false` | Skip Wan2.1, emit a labelled placeholder |
| `OFFLOAD_MODEL` | `true` | Trade speed for a much lower VRAM peak |
| `T5_CPU` | `false` | Keep the text encoder off the GPU |
| `FINAL_FRAME_SSIM_THRESHOLD` | `0.70` | Final-frame match gate |
| `CAMERA_SIMILARITY_THRESHOLD` | `0.55` | Viewpoint-mismatch gate |

## 8. Running the application

```bash
# Try everything without the model:
python app.py --mock

# Real generation:
python app.py

# Options:
python app.py --host 0.0.0.0 --port 7860 --share --log-level DEBUG
```

Then open <http://127.0.0.1:7860>.

Docker:

```bash
docker compose up --build          # needs the NVIDIA Container Toolkit
```

For a CPU-only mock run, set `MOCK_MODE=true` in `.env` and comment out the
`deploy:` block in `docker-compose.yml`.

## 9. Example usage

A hillside plot with a poured slab and columns, becoming a finished venue:

1. **BEFORE** — the drone photo of the slab and columns.
2. **AFTER** — the render of the finished building, *from the same camera
   position*. This matters more than any other setting; see Known limitations.
3. Aspect **16:9**, duration **10 sec**, type **commercial building**,
   speed **fast**, camera **Locked / static**, quality **720p**, seed **42**.
4. Open **Advanced settings** and set the start stage to *Columns and structural
   frame*, since the slab and columns are already up.
5. Generate.

The prompt the engine produces for the first segment looks like this:

> Photorealistic construction time-lapse, 4K, sharp textures, realistic daylight
> and realistic shadows. Scene: elevated or drone view of a commercial building
> construction site, 3 neighbouring building(s) that must stay unchanged,
> surrounding trees and vegetation that stay in place, open sky above the site,
> daytime with neutral daylight, consistent shadows falling toward the left.
> Camera: locked-off static camera on a rigid tripod, identical camera position,
> framing and focal length in every frame, absolutely no pan, tilt, zoom or
> parallax. Construction sequence, strictly in this order: columns being cast
> and stripped, the frame rising storey by storey, with a tower crane lifting
> formwork, reinforced concrete columns, scaffolding visible; then slab formwork
> being set, reinforcement laid, concrete poured and levelled … The final
> building geometry is fixed and must match the last frame exactly: same
> footprint, same number of floors, same roof line, same window grid, same
> facade materials and same proportions. Do not invent a different building. …

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No CUDA GPU detected` | No NVIDIA GPU, or a CPU-only PyTorch build. Reinstall torch from the CUDA index, or use `--mock`. |
| `Wan2.1 checkpoint not found` | `WAN_MODEL_PATH` is wrong or the download did not finish. The message includes the exact download command. |
| `does not look like a complete … checkpoint` | Partial transfer. Re-run the download; it resumes. |
| `The official Wan2.1 package is not importable` | Clone the repo and set `WAN_REPO_PATH`, or `pip install -e` it. |
| CUDA out of memory on load | Set `OFFLOAD_MODEL=true`, then `T5_CPU=true`, then drop to 480p. |
| CUDA out of memory during sampling | Lower sampling steps, use 480p, close other CUDA processes. |
| `ffmpeg was not found` | Install ffmpeg or set `FFMPEG_PATH`. |
| `Final frame does NOT match the AFTER image` | Geometry drifted. Raise sampling steps, change the seed, or supply uploads that share a viewpoint. |
| `significantly different camera perspectives` | The real problem, not a nuisance warning. See Known limitations. |
| `flash_attn` fails to build | Skip it. Wan falls back to PyTorch attention. |
| Blank or flickering output | Guidance too high or too low. Try 5.0–6.0 at 720p. |

## 11. Performance optimization

- `OFFLOAD_MODEL=true` is the single biggest VRAM saving, and costs perhaps 30%
  speed. `T5_CPU=true` adds a few more GB.
- 480p is roughly three times faster than 720p and uses far less memory. Draft
  at 480p, then re-run the settings you like at 720p.
- Sampling steps are linear in time. 40 is the default; 25 is usually
  serviceable for drafts, and above 50 gains little.
- A 5-second video is a single Wan call. 10 and 15 second videos cost 3 and 4
  calls respectively, because of the draft pass — budget accordingly.
- Motion-compensated interpolation (`minterpolate`) is CPU-bound and slow on
  long clips. Leave it off unless you are also using a speed multiplier.
- Keep the model loaded between runs: the Gradio process reuses one generator,
  so back-to-back generations skip the load.

## 12. Known limitations

- **Camera agreement dominates everything.** Wan interpolates between your two
  frames. If the BEFORE photo and the AFTER render are from different positions,
  angles or focal lengths, the model has to move the camera *and* build the
  building, and it will morph rather than construct. The application measures
  this and warns, but no setting fixes it. The reliable fix is to re-render the
  AFTER image from the BEFORE photo's camera. This is the most common cause of
  disappointing output.
- **The analyser is classical computer vision, not scene understanding.** It
  measures colour, gradients, lines and blobs. It reports a confidence and says
  when it is guessing, and the start stage can be overridden in Advanced
  settings — do so whenever the detected stage looks wrong.
- **81 frames is the model's native length.** Longer videos are built from
  chained segments, which is why a 15-second run costs four generations.
- **720p is the ceiling** for the official FLF2V checkpoint. Upscaling is out of
  scope here.
- **1:1 output is cropped, not generated square.** Wan has no square bucket.
- **Mock mode is a labelled cross-fade,** deliberately. It exists to test the
  pipeline, not to imitate generated video.
- **No audio.** The pipeline is video only.

## 13. License considerations

This application is released under the Apache License 2.0; see `LICENSE`.

It does **not** bundle Wan2.1 or its weights. Wan2.1 is a separate project with
its own licence, and the model weights carry their own terms — review both
before any commercial use:

- Code: <https://github.com/Wan-Video/Wan2.1>
- Weights: <https://huggingface.co/Wan-AI/Wan2.1-FLF2V-14B-720P>

You are responsible for holding the rights to the images you upload, and for
how generated footage is presented. A generated construction sequence is a
plausible illustration, not a record of how a building was actually built;
labelling it accordingly matters if it is shown to clients, investors or
planning authorities.

---

## Testing

```bash
pip install -r requirements-dev.txt
pytest                       # the whole suite, no GPU and no model needed
pytest tests/test_planning.py -v
pytest --cov=src             # with coverage
```

The suite runs entirely in mock mode against synthetic images, so it needs
neither the 82 GB checkpoint nor a GPU.
