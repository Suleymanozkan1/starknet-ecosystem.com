"""Gradio front end.

The UI collects settings, hands them to :class:`~src.pipeline.TimelapsePipeline`
and renders what comes back. It holds no generation logic of its own, so the
same run is reproducible from a script or a test.
"""

from __future__ import annotations

import logging
import random
from pathlib import Path

import gradio as gr

from ..analysis.image_analyzer import ImageAnalysis
from ..planning.stage_planner import CATALOGUES, CONSTRUCTION_TYPES
from ..pipeline import GenerationRequest, PipelineError, PipelineResult, TimelapsePipeline
from ..utils import gpu_utils, image_utils
from ..utils.config import Settings, get_settings

logger = logging.getLogger(__name__)

CSS = """
.acl-header { padding: 4px 0 12px; }
.acl-header h1 { margin: 0 0 4px; font-size: 1.45rem; }
.acl-header p { margin: 0; opacity: 0.75; font-size: 0.9rem; }
.acl-status textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem; line-height: 1.45; }
"""

#: Gradio 6 takes styling on launch() rather than on the Blocks constructor,
#: so app.py passes these through when it starts the server.
THEME = gr.themes.Soft()


def _stage_choices(construction_type: str) -> list[tuple[str, str]]:
    """Catalogue entries for the start-stage override, as (label, value)."""
    catalogue = CATALOGUES.get(construction_type.lower(), CATALOGUES["building"])
    return [(template.name, template.key) for template in catalogue]


def _analysis_markdown(label: str, analysis: ImageAnalysis | None) -> str:
    if analysis is None:
        return ""
    lines = "\n".join(f"- {line}" for line in analysis.summary_lines())
    notes = "\n".join(f"- _{note}_" for note in analysis.notes)
    return f"**{label}**\n{lines}\n{notes}" if notes else f"**{label}**\n{lines}"


def build_interface(settings: Settings | None = None) -> gr.Blocks:
    """Construct the Gradio application."""
    settings = settings or get_settings()
    settings.ensure_directories()
    pipeline = TimelapsePipeline(settings)

    environment = gpu_utils.describe_environment()
    if settings.mock_mode:
        banner = (
            "**MOCK MODE is on.** Wan2.1 will not be loaded and the output is a labelled "
            "placeholder, not generated video. Unset `MOCK_MODE` in `.env` to generate for real."
        )
    elif not environment["gpu_available"]:
        banner = (
            f"**No CUDA GPU detected** ({environment['gpu']}). Wan2.1 FLF2V-14B needs roughly "
            "60 GB of VRAM (about 20 GB with offloading). Set `MOCK_MODE=true` to try the "
            "pipeline without it."
        )
    else:
        banner = f"**GPU:** {environment['gpu']}"

    def on_generate(
        before_file, after_file, aspect, duration, construction_type, speed, camera_mode,
        resolution, seed, randomise_seed, sampling_steps, guidance_scale, output_fps,
        timelapse_speed, interpolate, motion_blur, bitrate, start_stage, auto_align,
        extra_positive, extra_negative,
        progress=gr.Progress(),
    ):
        """Validate the form, run the pipeline and render the result."""
        if not before_file or not after_file:
            raise gr.Error("Upload both a BEFORE and an AFTER image before generating.")

        try:
            before_path = image_utils.store_upload(
                before_file, settings.input_dir, "before",
                max_mb=settings.max_upload_mb, max_pixels=settings.max_image_pixels,
            )
            after_path = image_utils.store_upload(
                after_file, settings.input_dir, "after",
                max_mb=settings.max_upload_mb, max_pixels=settings.max_image_pixels,
            )
        except image_utils.ImageValidationError as exc:
            raise gr.Error(str(exc)) from exc

        resolved_seed = random.randint(0, 2**31 - 1) if randomise_seed else int(seed)

        request = GenerationRequest(
            before_path=before_path,
            after_path=after_path,
            aspect=aspect,
            duration=int(duration),
            construction_type=construction_type,
            speed=speed,
            camera_mode="locked" if camera_mode.startswith("Locked") else "cinematic",
            resolution=resolution,
            seed=resolved_seed,
            sampling_steps=int(sampling_steps),
            guidance_scale=float(guidance_scale),
            output_fps=int(output_fps),
            timelapse_speed=int(timelapse_speed),
            interpolate=bool(interpolate),
            motion_blur=bool(motion_blur),
            bitrate=bitrate.strip(),
            start_stage=start_stage or None,
            extra_positive=extra_positive,
            extra_negative=extra_negative,
            auto_align=bool(auto_align),
        )

        lines: list[str] = []

        def report(message: str) -> None:
            lines.append(message)
            progress(len(lines) / 12.0, desc=message.strip())

        try:
            result: PipelineResult = pipeline.run(request, progress=report)
        except PipelineError as exc:
            raise gr.Error(str(exc)) from exc
        except Exception as exc:  # unexpected: still surface something usable
            logger.exception("Unhandled failure during generation")
            raise gr.Error(f"Generation failed unexpectedly: {exc}") from exc

        timeline = result.plan.timeline_markdown() if result.plan else ""
        if result.warnings:
            warnings = "\n".join(f"- ⚠️ {item}" for item in result.warnings)
            timeline = f"**Warnings**\n{warnings}\n\n{timeline}"

        analyses = "\n\n".join(
            filter(
                None,
                [
                    _analysis_markdown("BEFORE", result.before_analysis),
                    _analysis_markdown("AFTER", result.after_analysis),
                ],
            )
        )
        video = str(result.video_path) if result.video_path else None
        return video, video, timeline, analyses, "\n".join(result.log)

    with gr.Blocks(title="AI Construction Timelapse") as demo:
        gr.Markdown(
            "<div class='acl-header'><h1>AI Construction Timelapse</h1>"
            "<p>Two stills in, one accelerated construction sequence out, "
            "generated with Wan2.1 FLF2V.</p></div>"
        )
        gr.Markdown(banner)

        with gr.Row():
            with gr.Column(scale=4):
                before_input = gr.Image(
                    label="BEFORE image", type="filepath", sources=["upload"], height=200
                )
                after_input = gr.Image(
                    label="AFTER image (target final state)", type="filepath",
                    sources=["upload"], height=200,
                )

                aspect = gr.Radio(["16:9", "9:16", "1:1"], value="16:9", label="Aspect ratio")
                duration = gr.Radio([5, 10, 15], value=5, label="Video duration (seconds)")
                construction_type = gr.Dropdown(
                    list(CONSTRUCTION_TYPES), value="building", label="Construction type"
                )
                speed = gr.Radio(
                    ["realistic", "fast", "hyperlapse"], value="realistic",
                    label="Construction speed",
                )
                camera_mode = gr.Radio(
                    ["Locked / static", "Slight cinematic movement"],
                    value="Locked / static", label="Camera",
                )
                resolution = gr.Radio(["480p", "720p"], value="720p", label="Quality")

                with gr.Row():
                    seed = gr.Number(value=42, precision=0, label="Seed", scale=2)
                    randomise_seed = gr.Checkbox(value=False, label="Random", scale=1)

                with gr.Accordion("Advanced settings", open=False):
                    start_stage = gr.Dropdown(
                        choices=_stage_choices("building"), value=None,
                        label="Start stage (overrides detection)", allow_custom_value=False,
                    )
                    auto_align = gr.Checkbox(
                        value=True,
                        label="Auto-align AFTER onto BEFORE when viewpoints differ slightly",
                    )
                    sampling_steps = gr.Slider(10, 60, value=40, step=1, label="Sampling steps")
                    guidance_scale = gr.Slider(
                        1.0, 12.0, value=5.5, step=0.1, label="Guidance scale"
                    )
                    output_fps = gr.Radio([24, 30], value=24, label="Output frame rate")
                    timelapse_speed = gr.Radio(
                        [1, 2, 4, 8, 16], value=1, label="Timelapse speed multiplier"
                    )
                    interpolate = gr.Checkbox(
                        value=False, label="Motion-compensated interpolation (slower encode)"
                    )
                    motion_blur = gr.Checkbox(value=False, label="Add motion blur")
                    bitrate = gr.Textbox(
                        value="", label="Bitrate (e.g. 8M; empty uses constant quality)"
                    )
                    extra_positive = gr.Textbox(
                        value="", lines=2, label="Extra prompt text (appended)"
                    )
                    extra_negative = gr.Textbox(
                        value="", lines=2, label="Extra negative prompt terms"
                    )

                generate_button = gr.Button("Generate timelapse", variant="primary", size="lg")

            with gr.Column(scale=6):
                with gr.Row():
                    before_preview = gr.Image(label="BEFORE preview", height=190, interactive=False)
                    after_preview = gr.Image(label="AFTER preview", height=190, interactive=False)

                video_output = gr.Video(label="Generated timelapse", height=380)
                download = gr.File(label="Download MP4", interactive=False)
                timeline_output = gr.Markdown("Upload two images and press generate.",
                                              label="Construction stage timeline")
                analysis_output = gr.Markdown(label="Image analysis")
                status_output = gr.Textbox(
                    label="Log", lines=14, interactive=False, elem_classes=["acl-status"]
                )

        before_input.change(lambda path: path, before_input, before_preview)
        after_input.change(lambda path: path, after_input, after_preview)
        construction_type.change(
            lambda value: gr.update(choices=_stage_choices(value), value=None),
            construction_type,
            start_stage,
        )
        generate_button.click(
            on_generate,
            inputs=[
                before_input, after_input, aspect, duration, construction_type, speed,
                camera_mode, resolution, seed, randomise_seed, sampling_steps, guidance_scale,
                output_fps, timelapse_speed, interpolate, motion_blur, bitrate, start_stage,
                auto_align, extra_positive, extra_negative,
            ],
            outputs=[video_output, download, timeline_output, analysis_output, status_output],
        )

    return demo
