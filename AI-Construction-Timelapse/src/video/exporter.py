"""Assembling generated segments into the delivered MP4."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image

from .postprocess import EncodeOptions, PostProcessError, encode, probe_duration, write_frames

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ExportResult:
    """Where the finished video landed and what it contains."""

    path: Path
    frame_count: int
    fps: int
    duration_seconds: float
    size_mb: float

    def summary(self) -> str:
        return (
            f"{self.path.name}: {self.frame_count} frames, {self.fps} fps, "
            f"{self.duration_seconds:.1f}s, {self.size_mb:.1f} MB"
        )


def join_segments(segments: list[list[Image.Image]]) -> list[Image.Image]:
    """Concatenate segment frame lists, dropping shared boundary frames.

    Consecutive segments are generated so that one ends where the next begins.
    Keeping both copies would show a repeated frame at every join.
    """
    if not segments:
        return []
    joined = list(segments[0])
    for following in segments[1:]:
        joined.extend(following[1:] if following else [])
    return joined


def export_video(
    frames: list[Image.Image],
    output_dir: Path,
    options: EncodeOptions,
    *,
    source_fps: int = 16,
    ffmpeg: str = "ffmpeg",
    stem: str = "timelapse",
) -> ExportResult:
    """Write frames to a timestamped MP4 under `output_dir`."""
    if not frames:
        raise PostProcessError("Nothing to export: the frame list is empty.")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    work_dir = output_dir / f".frames-{stamp}"
    output_path = output_dir / f"{stem}-{stamp}.mp4"

    try:
        write_frames(frames, work_dir)
        encode(work_dir, output_path, options, source_fps=source_fps, ffmpeg=ffmpeg)
    finally:
        for leftover in work_dir.glob("frame_*.png"):
            leftover.unlink()
        if work_dir.exists():
            work_dir.rmdir()

    duration = probe_duration(output_path, ffmpeg) or (len(frames) / options.fps)
    result = ExportResult(
        path=output_path,
        frame_count=len(frames),
        fps=options.fps,
        duration_seconds=duration,
        size_mb=output_path.stat().st_size / 1e6,
    )
    logger.info("Exported %s", result.summary())
    return result
