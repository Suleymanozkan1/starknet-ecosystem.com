"""FFmpeg post-processing: retiming, interpolation, motion blur, encoding.

Wan emits 81 frames at 16 fps, a little over five seconds. Everything that
turns that into a deliverable — target frame rate, timelapse speed, smoothing,
bitrate — happens here, through ffmpeg rather than in Python, because the
filters involved are far faster and better tested than an array reimplementation.
"""

from __future__ import annotations

import logging
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)

SPEED_FACTORS: tuple[int, ...] = (1, 2, 4, 8, 16)


class PostProcessError(RuntimeError):
    """FFmpeg refused to produce the requested output."""


@dataclass
class EncodeOptions:
    """How the final file should be written."""

    fps: int = 24
    speed: int = 1
    crf: int = 18
    bitrate: str = ""
    preset: str = "medium"
    interpolate: bool = False
    motion_blur: bool = False
    width: int | None = None
    height: int | None = None
    extra_filters: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.fps not in (24, 30):
            raise ValueError(f"fps must be 24 or 30, got {self.fps}")
        if self.speed not in SPEED_FACTORS:
            raise ValueError(f"speed must be one of {SPEED_FACTORS}, got {self.speed}")
        if not 0 <= self.crf <= 51:
            raise ValueError(f"crf must be between 0 and 51, got {self.crf}")


def write_frames(frames: list[Image.Image], directory: Path) -> Path:
    """Write frames as zero-padded PNGs and return the directory."""
    if not frames:
        raise PostProcessError("No frames to write.")
    directory.mkdir(parents=True, exist_ok=True)
    for existing in directory.glob("frame_*.png"):
        existing.unlink()
    for index, frame in enumerate(frames):
        frame.save(directory / f"frame_{index:05d}.png")
    logger.debug("Wrote %d frames to %s", len(frames), directory)
    return directory


def _build_filters(options: EncodeOptions, source_fps: int) -> str:
    """Assemble the filter chain, in the order the filters must run."""
    filters: list[str] = []

    # Speed first: setpts scales presentation timestamps, so everything after it
    # operates on the retimed stream.
    if options.speed > 1:
        filters.append(f"setpts=PTS/{options.speed}")

    if options.interpolate:
        # minterpolate synthesises intermediate frames using motion estimation,
        # which is what keeps a sped-up clip from looking like dropped frames.
        filters.append(
            f"minterpolate=fps={options.fps}:mi_mode=mci:mc_mode=aobmc:"
            "me_mode=bidir:vsbmc=1"
        )
    else:
        filters.append(f"fps={options.fps}")

    if options.motion_blur:
        # Averaging adjacent frames approximates a longer shutter.
        filters.append("tmix=frames=3:weights='1 1 1'")

    if options.width and options.height:
        filters.append(
            f"scale={options.width}:{options.height}:force_original_aspect_ratio=increase,"
            f"crop={options.width}:{options.height}"
        )

    filters.extend(options.extra_filters)
    # yuv420p needs even dimensions; this is a no-op when they already are.
    filters.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")
    return ",".join(filters)


def encode(
    frames_dir: Path,
    output_path: Path,
    options: EncodeOptions,
    source_fps: int = 16,
    ffmpeg: str = "ffmpeg",
) -> Path:
    """Encode a directory of PNG frames into an H.264 MP4.

    Raises:
        PostProcessError: with ffmpeg's own message when encoding fails.
    """
    frames = sorted(frames_dir.glob("frame_*.png"))
    if not frames:
        raise PostProcessError(f"No frames found in {frames_dir}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(source_fps),
        "-i", str(frames_dir / "frame_%05d.png"),
        "-vf", _build_filters(options, source_fps),
        "-c:v", "libx264",
        "-preset", options.preset,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ]
    if options.bitrate:
        command += ["-b:v", options.bitrate, "-maxrate", options.bitrate, "-bufsize", options.bitrate]
    else:
        command += ["-crf", str(options.crf)]
    command.append(str(output_path))

    logger.debug("ffmpeg: %s", " ".join(shlex.quote(part) for part in command))
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise PostProcessError(
            f"ffmpeg failed while encoding {output_path.name}:\n{result.stderr.strip()[-1500:]}"
        )
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise PostProcessError(f"ffmpeg reported success but {output_path} is empty.")
    logger.info("Encoded %s (%.1f MB)", output_path.name, output_path.stat().st_size / 1e6)
    return output_path


def probe_duration(path: Path, ffmpeg: str = "ffmpeg") -> float:
    """Return a clip's duration in seconds, or 0.0 if it cannot be read."""
    probe = Path(ffmpeg).with_name("ffprobe")
    command = (
        [str(probe)] if probe.exists() else [ffmpeg, "-hide_banner"]
    )
    if probe.exists():
        command += [
            "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        try:
            return float(result.stdout.strip())
        except ValueError:
            return 0.0

    # No ffprobe alongside ffmpeg: parse the duration ffmpeg prints on stderr.
    result = subprocess.run([ffmpeg, "-i", str(path)], capture_output=True, text=True)
    for line in result.stderr.splitlines():
        if "Duration:" in line:
            stamp = line.split("Duration:")[1].split(",")[0].strip()
            try:
                hours, minutes, seconds = stamp.split(":")
                return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            except ValueError:
                return 0.0
    return 0.0
