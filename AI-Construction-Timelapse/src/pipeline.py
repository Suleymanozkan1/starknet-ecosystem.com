"""End-to-end orchestration: two stills in, one MP4 out.

Kept separate from the Gradio layer so the whole run is callable from tests and
from a script, and so the UI holds no logic of its own.

Multi-segment generation deserves an explanation. Wan2.1 FLF2V produces 81
frames per call, a little over five seconds, and it needs a real first and last
frame — but the user supplies only two. A ten or fifteen second video therefore
runs in two passes. The first is a draft over the whole transformation, from
BEFORE to AFTER. Intermediate keyframes are then lifted out of that draft at the
stage boundaries the planner chose, and each consecutive pair is regenerated at
full length with the prompt for just those stages. Every segment shares its
boundary frame with its neighbour, so the joins are seamless, and each stage
gets its own 81 frames of attention instead of a few frames inside one rushed
clip.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from PIL import Image

from .analysis.construction_detector import align_images, compare_construction
from .analysis.image_analyzer import ImageAnalysis, analyze_image
from .models.wan_flf2v import (
    NATIVE_FPS,
    NATIVE_FRAME_COUNT,
    GenerationResult,
    WanFLF2VGenerator,
    WanGenerationError,
)
from .planning.prompt_engine import annotate_plan
from .planning.stage_planner import ConstructionPlan, plan_construction
from .utils import gpu_utils, image_utils
from .utils.config import Settings, get_settings
from .video.exporter import ExportResult, export_video, join_segments
from .video.postprocess import EncodeOptions

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str], None]

TOTAL_STEPS = 6


@dataclass
class GenerationRequest:
    """Everything the UI collects before a run."""

    before_path: Path
    after_path: Path
    aspect: str = "9:16"
    duration: int = 5
    construction_type: str = "building"
    speed: str = "realistic"
    camera_mode: str = "locked"
    resolution: str = "720p"
    seed: int = -1
    sampling_steps: int = 40
    guidance_scale: float = 5.5
    output_fps: int = 24
    timelapse_speed: int = 1
    interpolate: bool = False
    motion_blur: bool = False
    bitrate: str = ""
    start_stage: str | None = None
    extra_positive: str = ""
    extra_negative: str = ""
    auto_align: bool = True


@dataclass
class PipelineResult:
    """What a completed run produced."""

    video_path: Path | None
    plan: ConstructionPlan | None
    before_analysis: ImageAnalysis | None
    after_analysis: ImageAnalysis | None
    export: ExportResult | None
    similarity: image_utils.SimilarityReport | None
    warnings: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    mocked: bool = False
    elapsed_seconds: float = 0.0

    @property
    def succeeded(self) -> bool:
        return self.video_path is not None


class PipelineError(RuntimeError):
    """A run stopped for a reason worth showing the user verbatim."""


def _noop(_message: str) -> None:
    return None


class TimelapsePipeline:
    """Runs the six-step generation flow."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.settings.ensure_directories()
        self._generator: WanFLF2VGenerator | None = None

    def _get_generator(self) -> WanFLF2VGenerator:
        if self._generator is None:
            import os

            self._generator = WanFLF2VGenerator(
                checkpoint_dir=self.settings.wan_model_path,
                task=self.settings.wan_task,
                offload_model=self.settings.offload_model,
                t5_cpu=self.settings.t5_cpu,
                wan_repo_path=Path(os.environ["WAN_REPO_PATH"])
                if os.environ.get("WAN_REPO_PATH")
                else None,
                mock=self.settings.mock_mode,
            )
        return self._generator

    def preflight(self, request: GenerationRequest) -> list[str]:
        """Check the host can do the run; return blocking problems."""
        problems: list[str] = []
        try:
            gpu_utils.check_ffmpeg(self.settings.ffmpeg_path)
        except RuntimeError as exc:
            problems.append(str(exc))

        if not self.settings.mock_mode:
            problems.extend(
                gpu_utils.check_vram(request.resolution, self.settings.offload_model)
            )
        return problems

    def run(self, request: GenerationRequest, progress: ProgressFn | None = None) -> PipelineResult:
        """Execute the full pipeline.

        Raises:
            PipelineError: for anything the user can act on.
        """
        emit = progress or _noop
        log: list[str] = []
        started = time.monotonic()

        def step(index: int, message: str) -> None:
            line = f"[{index}/{TOTAL_STEPS}] {message}"
            log.append(line)
            logger.info(message)
            emit(line)

        environment = gpu_utils.describe_environment()
        log.append(f"      GPU: {environment['gpu']}")
        log.append(f"      torch: {environment['torch']}   ffmpeg: {environment['ffmpeg']}")
        if self.settings.mock_mode:
            log.append("      MOCK_MODE is on: Wan2.1 will not be loaded.")

        blocking = self.preflight(request)
        if blocking:
            raise PipelineError("\n".join(blocking))

        # -- 1. images -----------------------------------------------------
        step(1, "Loading images")
        try:
            before = image_utils.load_image(
                image_utils.validate_image_file(
                    request.before_path,
                    max_mb=self.settings.max_upload_mb,
                    max_pixels=self.settings.max_image_pixels,
                )
            )
            after = image_utils.load_image(
                image_utils.validate_image_file(
                    request.after_path,
                    max_mb=self.settings.max_upload_mb,
                    max_pixels=self.settings.max_image_pixels,
                )
            )
        except image_utils.ImageValidationError as exc:
            raise PipelineError(str(exc)) from exc

        export_size = self.settings.export_size(request.aspect, request.resolution)
        log.append(f"      before {before.size}, after {after.size}, target {export_size}")

        # -- 2. analysis ---------------------------------------------------
        step(2, "Analyzing construction")
        before_analysis = analyze_image(before)
        after_analysis = analyze_image(after)
        comparison = compare_construction(
            before, after, before_analysis, after_analysis,
            self.settings.camera_similarity_threshold,
        )
        warnings = list(comparison.warnings)
        log.extend(f"      BEFORE  {line}" for line in before_analysis.summary_lines())
        log.extend(f"      AFTER   {line}" for line in after_analysis.summary_lines())
        log.append(f"      camera: {comparison.camera.message}")

        if request.auto_align and comparison.camera.needs_alignment:
            aligned, ok, note = align_images(before, after)
            log.append(f"      {note}")
            if ok:
                after = aligned

        before, after = image_utils.prepare_frames(before, after, request.aspect, export_size)

        # -- 3. planning ---------------------------------------------------
        step(3, "Planning stages")
        plan = plan_construction(
            before_analysis, after_analysis, comparison,
            construction_type=request.construction_type,
            duration_seconds=request.duration,
            camera_mode=request.camera_mode,
            start_stage_override=request.start_stage,
        )
        plan = annotate_plan(
            plan, before_analysis, request.speed, request.extra_positive, request.extra_negative
        )
        warnings.extend(plan.warnings)
        log.append(
            f"      {len(plan.stages)} stages across {len(plan.segments)} segment(s): "
            + " -> ".join(stage.key for stage in plan.stages)
        )

        # -- 4. generation -------------------------------------------------
        step(4, "Generating video")
        wan_size = self.settings.wan_size(request.aspect, request.resolution)
        shift = self.settings.shift_for(request.resolution)
        log.append(
            f"      model={self.settings.wan_task} size={wan_size} frames={NATIVE_FRAME_COUNT} "
            f"steps={request.sampling_steps} guidance={request.guidance_scale} "
            f"shift={shift} seed={request.seed}"
        )

        try:
            segment_frames, mocked = self._generate_segments(
                before, after, plan, request, wan_size, shift, emit
            )
        except WanGenerationError as exc:
            raise PipelineError(str(exc)) from exc

        frames = join_segments(segment_frames)
        log.append(f"      {len(frames)} frames from {len(segment_frames)} segment(s)")

        # -- 5. post-processing --------------------------------------------
        step(5, "Post-processing")
        similarity = image_utils.compare_frames(
            frames[-1], after, self.settings.final_frame_ssim_threshold
        )
        log.append(f"      {similarity.message}")
        if not similarity.passed:
            warnings.append(
                f"The generated final frame differs from the AFTER image "
                f"(SSIM {similarity.ssim:.3f}, below the {similarity.threshold:.2f} threshold). "
                "The building geometry may have drifted. Try more sampling steps, a different "
                "seed, or uploads that share a viewpoint."
            )

        options = EncodeOptions(
            fps=request.output_fps,
            speed=request.timelapse_speed,
            interpolate=request.interpolate,
            motion_blur=request.motion_blur,
            bitrate=request.bitrate,
            width=export_size[0],
            height=export_size[1],
        )

        # -- 6. export -----------------------------------------------------
        step(6, "Export complete")
        ffmpeg = gpu_utils.check_ffmpeg(self.settings.ffmpeg_path)
        export = export_video(
            frames, self.settings.output_dir, options, source_fps=NATIVE_FPS, ffmpeg=ffmpeg
        )
        log.append(f"      {export.summary()}")

        elapsed = time.monotonic() - started
        log.append(f"      total generation time {elapsed:.1f}s")

        return PipelineResult(
            video_path=export.path,
            plan=plan,
            before_analysis=before_analysis,
            after_analysis=after_analysis,
            export=export,
            similarity=similarity,
            warnings=warnings,
            log=log,
            mocked=mocked,
            elapsed_seconds=elapsed,
        )

    def _generate_segments(
        self,
        before: Image.Image,
        after: Image.Image,
        plan: ConstructionPlan,
        request: GenerationRequest,
        wan_size: str,
        shift: float,
        emit: ProgressFn,
    ) -> tuple[list[list[Image.Image]], bool]:
        """Generate every segment, chaining keyframes when there is more than one."""
        generator = self._get_generator()
        segment_count = len(plan.segments)

        def run(first: Image.Image, last: Image.Image, prompt: str, negative: str) -> GenerationResult:
            return generator.generate(
                first_frame=first,
                last_frame=last,
                prompt=prompt,
                negative_prompt=negative,
                seed=request.seed,
                resolution=wan_size,
                frame_count=NATIVE_FRAME_COUNT,
                sampling_steps=request.sampling_steps,
                guidance_scale=request.guidance_scale,
                shift=shift,
                progress_callback=emit,
            )

        if segment_count == 1:
            segment = plan.segments[0]
            emit("      segment 1/1: whole transformation")
            result = run(before, after, segment.prompt, segment.negative_prompt)
            return [result.frames], result.mocked

        # Draft pass, only to source intermediate keyframes.
        emit(f"      draft pass: sourcing {segment_count - 1} intermediate keyframe(s)")
        draft = run(before, after, plan.segments[0].prompt, plan.segments[0].negative_prompt)
        draft_frames = draft.frames

        keyframes = [before]
        for index in range(1, segment_count):
            position = round(index * (len(draft_frames) - 1) / segment_count)
            keyframes.append(draft_frames[position])
        keyframes.append(after)

        segments: list[list[Image.Image]] = []
        mocked = draft.mocked
        for index, segment in enumerate(plan.segments):
            emit(f"      segment {index + 1}/{segment_count}: {segment.label}")
            result = run(
                keyframes[index], keyframes[index + 1], segment.prompt, segment.negative_prompt
            )
            segments.append(result.frames)
            mocked = mocked or result.mocked
        return segments, mocked

    def close(self) -> None:
        """Release the model, if one was loaded."""
        if self._generator is not None:
            self._generator.unload()
