"""Wrapper around Wan2.1 First-Last-Frame-to-Video.

This is the only module that imports the ``wan`` package. Everything else in
the application talks to :class:`WanFLF2VGenerator`, so the official
implementation can be upgraded, swapped for a different checkpoint, or replaced
by mock mode without touching the pipeline.

The official model is cloned from https://github.com/Wan-Video/Wan2.1 and its
weights from https://huggingface.co/Wan-AI/Wan2.1-FLF2V-14B-720P. Nothing here
reimplements the model: ``generate`` forwards to ``wan.WanFLF2V.generate`` with
the arguments that method actually declares.
"""

from __future__ import annotations

import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

#: Wan samples 4n+1 frames; 81 is what the FLF2V checkpoint was trained on.
NATIVE_FRAME_COUNT = 81
#: Output frame rate of the Wan sampler, from ``configs.wan_i2v_14B.sample_fps``.
NATIVE_FPS = 16


class WanGenerationError(RuntimeError):
    """Raised when generation cannot start or does not finish."""


class WanModelNotFoundError(WanGenerationError):
    """The checkpoint directory is missing or does not look like a checkpoint."""


@dataclass(frozen=True)
class GenerationResult:
    """Frames produced by one call, plus what it cost."""

    frames: list[Image.Image]
    fps: int
    seed: int
    duration_seconds: float
    mocked: bool

    @property
    def frame_count(self) -> int:
        return len(self.frames)


def normalise_frame_count(requested: int) -> int:
    """Round to the nearest valid 4n+1 frame count, at least 5."""
    if requested < 5:
        return 5
    return int(round((requested - 1) / 4)) * 4 + 1


def _validate_checkpoint(path: Path) -> None:
    """Fail early and specifically when the checkpoint is not usable."""
    if not path.exists():
        raise WanModelNotFoundError(
            f"Wan2.1 checkpoint not found at {path}.\n"
            "Download it with:\n"
            "  pip install 'huggingface_hub[cli]'\n"
            "  hf download Wan-AI/Wan2.1-FLF2V-14B-720P --local-dir "
            f"{path}\n"
            "The download is roughly 82 GB. Set WAN_MODEL_PATH in .env to point elsewhere, "
            "or set MOCK_MODE=true to run the pipeline without it."
        )
    if not path.is_dir():
        raise WanModelNotFoundError(f"WAN_MODEL_PATH must be a directory, but {path} is a file.")

    expected = ["models_t5_umt5-xxl-enc-bf16.pth", "Wan2.1_VAE.pth"]
    missing = [name for name in expected if not (path / name).exists()]
    shards = list(path.glob("diffusion_pytorch_model*.safetensors"))
    if missing or not shards:
        detail = ", ".join(missing) if missing else "diffusion_pytorch_model*.safetensors"
        raise WanModelNotFoundError(
            f"{path} exists but does not look like a complete Wan2.1 FLF2V checkpoint "
            f"(missing: {detail}). Re-run the download; a partial transfer is the usual cause."
        )


class WanFLF2VGenerator:
    """Loads Wan2.1 FLF2V once and generates clips from frame pairs.

    The model is loaded lazily on the first :meth:`generate` call, so the UI can
    start and the plan can be reviewed before roughly 30 GB of weights are read
    from disk.
    """

    def __init__(
        self,
        checkpoint_dir: Path,
        *,
        task: str = "flf2v-14B",
        device_id: int = 0,
        offload_model: bool = True,
        t5_cpu: bool = False,
        wan_repo_path: Path | None = None,
        mock: bool = False,
    ) -> None:
        self.checkpoint_dir = Path(checkpoint_dir)
        self.task = task
        self.device_id = device_id
        self.offload_model = offload_model
        self.t5_cpu = t5_cpu
        self.wan_repo_path = Path(wan_repo_path) if wan_repo_path else None
        self.mock = mock
        self._pipeline = None
        self._config = None

    # -- loading -----------------------------------------------------------

    def _import_wan(self):
        """Import the official ``wan`` package, with a precise error if absent."""
        if self.wan_repo_path and str(self.wan_repo_path) not in sys.path:
            sys.path.insert(0, str(self.wan_repo_path))
        try:
            import wan
            from wan.configs import MAX_AREA_CONFIGS, WAN_CONFIGS
        except ImportError as exc:
            raise WanGenerationError(
                "The official Wan2.1 package is not importable "
                f"({exc}). Install it with:\n"
                "  git clone https://github.com/Wan-Video/Wan2.1\n"
                "  cd Wan2.1 && pip install -r requirements.txt && pip install -e .\n"
                "or set WAN_REPO_PATH in .env to point at your clone."
            ) from exc
        return wan, WAN_CONFIGS, MAX_AREA_CONFIGS

    def load(self) -> None:
        """Load the checkpoint. Idempotent, and a no-op in mock mode."""
        if self.mock or self._pipeline is not None:
            return
        _validate_checkpoint(self.checkpoint_dir)
        wan, wan_configs, _ = self._import_wan()

        if self.task not in wan_configs:
            raise WanGenerationError(
                f"Unknown Wan task {self.task!r}. Available: {', '.join(sorted(wan_configs))}"
            )
        self._config = wan_configs[self.task]

        logger.info("Loading Wan2.1 %s from %s", self.task, self.checkpoint_dir)
        started = time.monotonic()
        try:
            self._pipeline = wan.WanFLF2V(
                config=self._config,
                checkpoint_dir=str(self.checkpoint_dir),
                device_id=self.device_id,
                rank=0,
                t5_fsdp=False,
                dit_fsdp=False,
                use_usp=False,
                t5_cpu=self.t5_cpu,
            )
        except Exception as exc:  # torch, CUDA and safetensors all raise their own types
            raise WanGenerationError(self._explain_load_failure(exc)) from exc
        logger.info("Model loaded in %.1fs", time.monotonic() - started)

    @staticmethod
    def _explain_load_failure(exc: Exception) -> str:
        text = str(exc).lower()
        if "out of memory" in text or "cuda oom" in text:
            return (
                "Ran out of GPU memory while loading Wan2.1. The 14B checkpoint needs roughly "
                "60 GB of VRAM, or about 20 GB with OFFLOAD_MODEL=true. Free the card, enable "
                f"offloading, or drop to 480p. Original error: {exc}"
            )
        if "no cuda" in text or "cuda" in text and "available" in text:
            return (
                "Wan2.1 requires an NVIDIA GPU; CUDA is not available in this process. "
                f"Set MOCK_MODE=true to exercise the pipeline without it. Original error: {exc}"
            )
        if "safetensors" in text or "checkpoint" in text or "state_dict" in text:
            return (
                "The checkpoint failed to load, which usually means an incomplete or corrupted "
                f"download. Re-download it into {'the model directory'}. Original error: {exc}"
            )
        return f"Wan2.1 failed to load: {exc}"

    # -- generation --------------------------------------------------------

    def generate(
        self,
        first_frame: Image.Image,
        last_frame: Image.Image,
        prompt: str,
        negative_prompt: str = "",
        seed: int = -1,
        resolution: str = "720*1280",
        frame_count: int = NATIVE_FRAME_COUNT,
        sampling_steps: int = 40,
        guidance_scale: float = 5.5,
        shift: float = 16.0,
        sample_solver: str = "unipc",
        progress_callback=None,
    ) -> GenerationResult:
        """Generate one clip that starts at `first_frame` and ends at `last_frame`.

        Args:
            first_frame: The opening frame, as RGB.
            last_frame: The closing frame. Wan crops it to match the first if the
                sizes differ.
            prompt: Positive prompt describing the construction sequence.
            negative_prompt: Terms to suppress; empty uses the model default.
            seed: Sampling seed, or -1 for a random one.
            resolution: A Wan size key such as ``"720*1280"``.
            frame_count: Number of frames; rounded to the nearest 4n+1.
            sampling_steps: Diffusion steps. Higher is slower and cleaner.
            guidance_scale: Classifier-free guidance strength.
            shift: Noise schedule shift. The official README recommends 3.0 at 480p.
            sample_solver: ``"unipc"`` or ``"dpm++"``.
            progress_callback: Optional ``callable(str)`` for status updates.

        Returns:
            The generated frames and the metadata describing the run.

        Raises:
            WanGenerationError: on any failure to load or sample.
        """
        frame_count = normalise_frame_count(frame_count)
        started = time.monotonic()

        if self.mock:
            frames = _mock_frames(first_frame, last_frame, frame_count)
            return GenerationResult(
                frames=frames, fps=NATIVE_FPS, seed=seed,
                duration_seconds=time.monotonic() - started, mocked=True,
            )

        self.load()
        _, _, max_area_configs = self._import_wan()
        if resolution not in max_area_configs:
            raise WanGenerationError(
                f"Wan2.1 does not support size {resolution!r} for {self.task}. "
                f"Supported: {', '.join(sorted(max_area_configs))}"
            )

        if progress_callback:
            progress_callback(f"Sampling {frame_count} frames at {resolution}")

        try:
            tensor = self._pipeline.generate(
                prompt,
                first_frame,
                last_frame,
                max_area=max_area_configs[resolution],
                frame_num=frame_count,
                shift=shift,
                sample_solver=sample_solver,
                sampling_steps=sampling_steps,
                guide_scale=guidance_scale,
                n_prompt=negative_prompt,
                seed=seed,
                offload_model=self.offload_model,
            )
        except Exception as exc:
            raise WanGenerationError(self._explain_generation_failure(exc)) from exc

        if tensor is None:
            raise WanGenerationError(
                "Wan2.1 returned no frames. On a multi-GPU launch only rank 0 receives output; "
                "this application expects a single-process run."
            )

        frames = _tensor_to_frames(tensor)
        elapsed = time.monotonic() - started
        logger.info("Generated %d frames in %.1fs", len(frames), elapsed)
        return GenerationResult(
            frames=frames, fps=NATIVE_FPS, seed=seed, duration_seconds=elapsed, mocked=False
        )

    @staticmethod
    def _explain_generation_failure(exc: Exception) -> str:
        text = str(exc).lower()
        if "out of memory" in text:
            return (
                "GPU ran out of memory during sampling. Try 480p, reduce sampling steps, "
                "keep OFFLOAD_MODEL=true, and make sure nothing else is using the card. "
                f"Original error: {exc}"
            )
        if "expected" in text and "channel" in text:
            return f"Wan rejected the input frames; check they are RGB. Original error: {exc}"
        return f"Wan2.1 generation failed: {exc}"

    def unload(self) -> None:
        """Drop the pipeline and free GPU memory."""
        if self._pipeline is None:
            return
        self._pipeline = None
        try:
            import gc

            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        logger.info("Model unloaded")


def _tensor_to_frames(tensor) -> list[Image.Image]:
    """Convert Wan's ``(C, N, H, W)`` output in ``[-1, 1]`` to PIL frames."""
    array = tensor.detach().to("cpu").float().numpy()
    if array.ndim != 4:
        raise WanGenerationError(f"Expected a 4D (C, N, H, W) tensor, got shape {array.shape}")
    array = np.transpose(array, (1, 2, 3, 0))  # -> (N, H, W, C)
    array = np.clip((array + 1.0) / 2.0, 0.0, 1.0)
    return [Image.fromarray((frame * 255).round().astype(np.uint8)) for frame in array]


def _mock_frames(first: Image.Image, last: Image.Image, count: int) -> list[Image.Image]:
    """Synthesise a placeholder clip for MOCK_MODE.

    This is deliberately a labelled cross-fade, not an imitation of generated
    video. Mock mode exists to exercise the pipeline, the UI and the export path
    without 82 GB of weights; passing its output off as a construction timelapse
    would defeat the point of having it.
    """
    from PIL import ImageDraw

    if last.size != first.size:
        last = last.resize(first.size, Image.LANCZOS)
    start = np.asarray(first.convert("RGB"), dtype=np.float32)
    end = np.asarray(last.convert("RGB"), dtype=np.float32)

    frames: list[Image.Image] = []
    for index in range(count):
        t = index / max(1, count - 1)
        eased = t * t * (3.0 - 2.0 * t)
        blended = Image.fromarray(
            np.clip(start + (end - start) * eased, 0, 255).astype(np.uint8)
        )
        draw = ImageDraw.Draw(blended, "RGBA")
        bar = max(24, blended.height // 22)
        draw.rectangle([0, 0, blended.width, bar], fill=(0, 0, 0, 170))
        draw.text(
            (8, max(2, bar // 5)),
            f"MOCK MODE - not AI generated - frame {index + 1}/{count}",
            fill=(255, 220, 90, 255),
        )
        frames.append(blended)
    return frames
