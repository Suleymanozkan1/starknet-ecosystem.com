"""GPU detection and VRAM budgeting for Wan2.1.

Wan2.1 FLF2V is a 14B model: it is unusable without a large NVIDIA card, and
saying so up front is far kinder than letting a run die twenty minutes in with
a CUDA out-of-memory traceback.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: Approximate peak VRAM, in GiB, for Wan2.1-FLF2V-14B-720P. Measured figures
#: from the official README: the 14B models need roughly 60 GB unoptimised,
#: dropping to about 20 GB once submodules are offloaded to CPU between steps.
VRAM_REQUIREMENTS: dict[tuple[str, bool], float] = {
    ("720p", False): 60.0,
    ("720p", True): 20.0,
    ("480p", False): 45.0,
    ("480p", True): 15.0,
}

#: Weight download size for the FLF2V checkpoint, in GiB.
CHECKPOINT_SIZE_GB = 82.3


@dataclass(frozen=True)
class GpuInfo:
    """What the host offers for generation."""

    available: bool
    device_count: int = 0
    name: str = ""
    total_vram_gb: float = 0.0
    free_vram_gb: float = 0.0
    torch_version: str = ""
    capability: str = ""
    cuda_version: str = ""
    reason: str = ""
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if not self.available:
            return f"No CUDA GPU available ({self.reason})"
        return (
            f"{self.name} - {self.total_vram_gb:.1f} GB VRAM "
            f"({self.free_vram_gb:.1f} GB free), CUDA {self.cuda_version}"
        )


def detect_gpu() -> GpuInfo:
    """Inspect the host for a usable CUDA device.

    Never raises: a missing or broken PyTorch install is reported as "no GPU"
    so the UI can still start in mock mode.
    """
    try:
        import torch
    except ImportError:
        return GpuInfo(available=False, reason="PyTorch is not installed")

    torch_version = torch.__version__
    try:
        if not torch.cuda.is_available():
            return GpuInfo(
                available=False,
                reason="torch.cuda.is_available() returned False",
                torch_version=torch_version,
            )
        count = torch.cuda.device_count()
        props = torch.cuda.get_device_properties(0)
        total = props.total_memory / (1024**3)
        free_bytes, _ = torch.cuda.mem_get_info(0)
        free = free_bytes / (1024**3)
    except Exception as exc:  # pragma: no cover - depends on host drivers
        return GpuInfo(
            available=False,
            reason=f"CUDA query failed: {exc}",
            torch_version=torch_version,
        )

    warnings: list[str] = []
    if count > 1:
        warnings.append(
            f"{count} GPUs detected; this application uses device 0 only. "
            "Use the official Wan2.1 multi-GPU scripts for FSDP or sequence parallelism."
        )

    return GpuInfo(
        available=True,
        device_count=count,
        name=props.name,
        total_vram_gb=total,
        free_vram_gb=free,
        torch_version=torch_version,
        capability=f"sm_{props.major}{props.minor}",
        cuda_version=getattr(torch.version, "cuda", "") or "unknown",
        warnings=warnings,
    )


def required_vram_gb(resolution: str, offload_model: bool) -> float:
    """Approximate peak VRAM for a generation at this resolution."""
    return VRAM_REQUIREMENTS.get((resolution, offload_model), 60.0)


def check_vram(resolution: str, offload_model: bool, gpu: GpuInfo | None = None) -> list[str]:
    """Return human-readable problems that would stop a real generation.

    An empty list means the host looks capable. The caller decides whether that
    is fatal, because mock mode does not need a GPU at all.
    """
    gpu = detect_gpu() if gpu is None else gpu
    needed = required_vram_gb(resolution, offload_model)

    if not gpu.available:
        return [
            f"No CUDA GPU detected ({gpu.reason}). Wan2.1 FLF2V-14B needs roughly "
            f"{needed:.0f} GB of VRAM. Generation on CPU is not a supported path: "
            "the 14B model would need well over 60 GB of system RAM and days per clip. "
            "Set MOCK_MODE=true to exercise the pipeline without the model."
        ]

    problems: list[str] = []
    if gpu.total_vram_gb + 0.5 < needed:
        hint = (
            "Try 480p, or keep OFFLOAD_MODEL=true."
            if not offload_model or resolution == "720p"
            else "This card is below the practical floor for the 14B checkpoint."
        )
        problems.append(
            f"{gpu.name} has {gpu.total_vram_gb:.1f} GB VRAM but roughly {needed:.0f} GB "
            f"is needed for {resolution} with offload_model={offload_model}. {hint}"
        )
    elif gpu.free_vram_gb + 0.5 < needed:
        problems.append(
            f"{gpu.name} has {gpu.total_vram_gb:.1f} GB VRAM but only "
            f"{gpu.free_vram_gb:.1f} GB is free right now; about {needed:.0f} GB is needed. "
            "Close other CUDA processes and retry."
        )
    return problems


def check_ffmpeg(explicit_path: str = "") -> str:
    """Resolve an ffmpeg binary, preferring an explicit path, then the bundle.

    Raises:
        RuntimeError: if no usable ffmpeg can be found.
    """
    if explicit_path:
        if shutil.which(explicit_path) or shutil.os.path.isfile(explicit_path):
            return explicit_path
        raise RuntimeError(f"FFMPEG_PATH points at {explicit_path!r}, which is not executable.")

    found = shutil.which("ffmpeg")
    if found:
        return found

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass

    raise RuntimeError(
        "ffmpeg was not found. Install it (apt install ffmpeg / brew install ffmpeg), "
        "or set FFMPEG_PATH in .env, or pip install imageio-ffmpeg for a bundled build."
    )


def describe_environment() -> dict[str, object]:
    """Collect the facts worth logging at the start of every run."""
    gpu = detect_gpu()
    try:
        ffmpeg = check_ffmpeg()
    except RuntimeError as exc:
        ffmpeg = f"MISSING ({exc})"
    return {
        "gpu": gpu.summary(),
        "gpu_available": gpu.available,
        "torch": gpu.torch_version or "not installed",
        "ffmpeg": ffmpeg,
    }
