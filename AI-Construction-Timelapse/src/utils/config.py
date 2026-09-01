"""Application configuration, loaded from the environment and ``.env``."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(PROJECT_ROOT / ".env")

Resolution = Literal["480p", "720p"]
AspectRatio = Literal["16:9", "9:16", "1:1"]

#: Wan2.1 accepts only these ``size`` strings for the FLF2V checkpoint, taken
#: from ``SUPPORTED_SIZES['flf2v-14B']`` in the official repository. Anything
#: else is rejected upstream, so the mapping is exhaustive by construction.
WAN_SIZES: dict[tuple[AspectRatio, Resolution], str] = {
    ("16:9", "720p"): "1280*720",
    ("16:9", "480p"): "832*480",
    ("9:16", "720p"): "720*1280",
    ("9:16", "480p"): "480*832",
    # Wan has no square bucket; the nearest supported frame is used and the
    # result is centre-cropped back to square during post-processing.
    ("1:1", "720p"): "720*1280",
    ("1:1", "480p"): "480*832",
}

#: Pixel dimensions each aspect/resolution pair is exported at.
EXPORT_SIZES: dict[tuple[AspectRatio, Resolution], tuple[int, int]] = {
    ("16:9", "720p"): (1280, 720),
    ("16:9", "480p"): (832, 480),
    ("9:16", "720p"): (720, 1280),
    ("9:16", "480p"): (480, 832),
    ("1:1", "720p"): (720, 720),
    ("1:1", "480p"): (480, 480),
}


class Settings(BaseSettings):
    """Runtime settings.

    Every field can be overridden through an environment variable of the same
    name (case-insensitive) or through ``.env`` at the project root.
    """

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", protected_namespaces=()
    )

    wan_model_path: Path = Field(
        default=PROJECT_ROOT / "models" / "Wan2.1-FLF2V-14B-720P",
        description="Directory holding the Wan2.1 FLF2V checkpoint.",
    )
    wan_task: str = Field(default="flf2v-14B", description="Wan2.1 task key.")
    mock_mode: bool = Field(
        default=False,
        description="Skip Wan2.1 entirely and synthesise a placeholder video instead.",
    )

    input_dir: Path = Field(default=PROJECT_ROOT / "inputs")
    output_dir: Path = Field(default=PROJECT_ROOT / "outputs")

    ffmpeg_path: str = Field(default="", description="ffmpeg binary; auto-detected when empty.")

    max_upload_mb: float = Field(default=25.0, gt=0)
    max_image_pixels: int = Field(default=50_000_000, gt=0)

    default_sampling_steps: int = Field(default=40, ge=1, le=100)
    default_guidance_scale: float = Field(default=5.5, ge=0.0, le=20.0)
    default_shift_720p: float = Field(default=16.0, ge=0.0)
    #: The official README recommends dropping shift to 3.0 for 480p output.
    default_shift_480p: float = Field(default=3.0, ge=0.0)

    #: Below this SSIM the generated last frame is not considered a match for
    #: the uploaded AFTER image and the user is warned.
    final_frame_ssim_threshold: float = Field(default=0.70, ge=0.0, le=1.0)
    #: Below this camera similarity the two uploads are treated as different
    #: viewpoints, which Wan cannot reconcile without visible morphing.
    camera_similarity_threshold: float = Field(default=0.55, ge=0.0, le=1.0)

    offload_model: bool = Field(
        default=True, description="Offload Wan submodules to CPU between steps to save VRAM."
    )
    t5_cpu: bool = Field(default=False, description="Keep the T5 text encoder on CPU.")

    server_name: str = Field(default="127.0.0.1")
    server_port: int = Field(default=7860, ge=1, le=65535)
    share: bool = Field(default=False)

    log_level: str = Field(default="INFO")

    @field_validator("log_level")
    @classmethod
    def _valid_log_level(cls, value: str) -> str:
        level = value.upper()
        if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError(f"log_level must be a Python logging level, got {value!r}")
        return level

    def ensure_directories(self) -> None:
        """Create the directories the application writes into."""
        self.input_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def wan_size(self, aspect: AspectRatio, resolution: Resolution) -> str:
        """Return the Wan2.1 ``size`` string for an aspect/resolution pair."""
        try:
            return WAN_SIZES[(aspect, resolution)]
        except KeyError:  # pragma: no cover - guarded by Literal types
            raise ValueError(f"Unsupported aspect/resolution: {aspect} {resolution}")

    def export_size(self, aspect: AspectRatio, resolution: Resolution) -> tuple[int, int]:
        """Return the exported pixel size for an aspect/resolution pair."""
        try:
            return EXPORT_SIZES[(aspect, resolution)]
        except KeyError:  # pragma: no cover - guarded by Literal types
            raise ValueError(f"Unsupported aspect/resolution: {aspect} {resolution}")

    def shift_for(self, resolution: Resolution) -> float:
        """Noise-schedule shift; 480p needs a much lower value than 720p."""
        return self.default_shift_720p if resolution == "720p" else self.default_shift_480p


_settings: Settings | None = None


def get_settings(reload: bool = False) -> Settings:
    """Return the process-wide settings, constructing them on first use."""
    global _settings
    if _settings is None or reload:
        _settings = Settings()
    return _settings


def configure_logging(level: str | None = None) -> None:
    """Install a single stream handler with a consistent format."""
    resolved = (level or get_settings().log_level).upper()
    logging.basicConfig(
        level=getattr(logging, resolved),
        format="%(asctime)s  %(levelname)-7s %(name)-28s %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
