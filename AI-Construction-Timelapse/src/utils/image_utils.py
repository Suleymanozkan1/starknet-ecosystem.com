"""Loading, validating and reshaping the uploaded stills.

Uploads are untrusted input: everything here assumes the file may be the wrong
type, enormous, truncated, or carrying a hostile filename.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

logger = logging.getLogger(__name__)

ALLOWED_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})
ALLOWED_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "BMP"})

ASPECT_VALUES: dict[str, float] = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0}

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class ImageValidationError(ValueError):
    """An upload could not be accepted, with a message meant for the user."""


def safe_filename(name: str, fallback: str = "upload") -> str:
    """Reduce an arbitrary filename to a harmless basename.

    Path separators, traversal segments, control characters and unicode
    lookalikes are all stripped, so the result can never escape its directory.
    """
    base = Path(str(name)).name
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode()
    base = _UNSAFE.sub("_", base).strip("._-")
    if not base or set(base) <= {"_"}:
        base = fallback
    stem, dot, suffix = base.rpartition(".")
    if not dot:
        return base[:120]
    return f"{stem[:100]}.{suffix[:10]}"


def validate_image_file(
    path: str | Path, *, max_mb: float = 25.0, max_pixels: int = 50_000_000
) -> Path:
    """Check that `path` is an image this application is willing to open.

    Raises:
        ImageValidationError: with a message describing what is wrong.
    """
    resolved = Path(path).expanduser()
    if not resolved.is_file():
        raise ImageValidationError(f"No such file: {resolved}")

    suffix = resolved.suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        allowed = ", ".join(sorted(ALLOWED_SUFFIXES))
        raise ImageValidationError(
            f"{resolved.name}: unsupported file type {suffix or '(none)'}. Allowed: {allowed}"
        )

    size_mb = resolved.stat().st_size / (1024**2)
    if size_mb > max_mb:
        raise ImageValidationError(
            f"{resolved.name} is {size_mb:.1f} MB, above the {max_mb:.0f} MB limit."
        )
    if size_mb == 0:
        raise ImageValidationError(f"{resolved.name} is empty.")

    try:
        with Image.open(resolved) as probe:
            probe.verify()  # detects truncation and most malformed files
        with Image.open(resolved) as probe:
            fmt, (width, height) = probe.format, probe.size
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ImageValidationError(f"{resolved.name} is not a readable image ({exc}).") from exc

    if fmt not in ALLOWED_FORMATS:
        raise ImageValidationError(f"{resolved.name}: unsupported image format {fmt}.")
    if width < 64 or height < 64:
        raise ImageValidationError(f"{resolved.name} is only {width}x{height}; minimum is 64x64.")
    if width * height > max_pixels:
        raise ImageValidationError(
            f"{resolved.name} is {width}x{height} ({width * height / 1e6:.0f} MP), "
            f"above the {max_pixels / 1e6:.0f} MP limit."
        )
    return resolved


def load_image(path: str | Path) -> Image.Image:
    """Open an image as RGB with EXIF rotation already applied."""
    with Image.open(path) as handle:
        return ImageOps.exif_transpose(handle).convert("RGB")


def store_upload(
    source: str | Path, destination_dir: Path, stem: str, *, max_mb: float = 25.0,
    max_pixels: int = 50_000_000,
) -> Path:
    """Validate an upload and copy it into a directory we control.

    The stored name is derived from `stem`, never from the uploaded filename, so
    nothing user-supplied reaches the filesystem as a path.
    """
    validated = validate_image_file(source, max_mb=max_mb, max_pixels=max_pixels)
    destination_dir.mkdir(parents=True, exist_ok=True)
    target = destination_dir / f"{safe_filename(stem)}{validated.suffix.lower()}"
    load_image(validated).save(target)
    logger.debug("Stored upload %s -> %s", validated.name, target.name)
    return target


def fit_to_aspect(image: Image.Image, aspect: str) -> Image.Image:
    """Centre-crop an image to an aspect ratio without distorting it."""
    if aspect not in ASPECT_VALUES:
        raise ValueError(f"Unknown aspect ratio {aspect!r}")
    target = ASPECT_VALUES[aspect]
    width, height = image.size
    current = width / height

    if abs(current - target) < 1e-3:
        return image.copy()
    if current > target:  # too wide, trim the sides
        new_width = max(1, round(height * target))
        left = (width - new_width) // 2
        return image.crop((left, 0, left + new_width, height))
    new_height = max(1, round(width / target))  # too tall, trim top and bottom
    top = (height - new_height) // 2
    return image.crop((0, top, width, top + new_height))


def resize_to(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Cover-crop then resize so the result exactly matches `size`."""
    target_w, target_h = size
    fitted = fit_to_aspect(image, _nearest_aspect(target_w / target_h))
    return fitted.resize((target_w, target_h), Image.LANCZOS)


def _nearest_aspect(ratio: float) -> str:
    return min(ASPECT_VALUES, key=lambda key: abs(ASPECT_VALUES[key] - ratio))


def prepare_frames(
    before: Image.Image, after: Image.Image, aspect: str, size: tuple[int, int]
) -> tuple[Image.Image, Image.Image]:
    """Bring both stills to identical dimensions.

    Wan crops a mismatched last frame itself, but doing it here keeps the two
    frames aligned the same way and makes the previews match what is generated.
    """
    return resize_to(fit_to_aspect(before, aspect), size), resize_to(
        fit_to_aspect(after, aspect), size
    )


@dataclass(frozen=True)
class SimilarityReport:
    """Result of comparing two frames."""

    ssim: float
    mse: float
    passed: bool
    threshold: float

    @property
    def message(self) -> str:
        verdict = "matches" if self.passed else "does NOT match"
        return (
            f"Final frame {verdict} the AFTER image "
            f"(SSIM {self.ssim:.3f}, threshold {self.threshold:.2f})"
        )


def compare_frames(a: Image.Image, b: Image.Image, threshold: float = 0.70) -> SimilarityReport:
    """Score how closely two frames agree, using SSIM over greyscale."""
    from skimage.metrics import structural_similarity

    if a.size != b.size:
        b = b.resize(a.size, Image.LANCZOS)
    left = np.asarray(a.convert("L"), dtype=np.float64)
    right = np.asarray(b.convert("L"), dtype=np.float64)

    # SSIM needs an odd window that fits inside the image.
    win = min(7, min(left.shape) - (1 - min(left.shape) % 2))
    win = max(3, win if win % 2 else win - 1)
    score = float(structural_similarity(left, right, data_range=255.0, win_size=win))
    mse = float(np.mean((left - right) ** 2))
    return SimilarityReport(ssim=score, mse=mse, passed=score >= threshold, threshold=threshold)
