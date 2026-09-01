"""Shared fixtures. Synthetic images keep the suite fast and offline."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _site_image(size: tuple[int, int] = (640, 360)) -> Image.Image:
    """An empty plot: sky above, bare ground below, no structure."""
    width, height = size
    canvas = Image.new("RGB", size, (150, 190, 230))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, int(height * 0.55), width, height], fill=(150, 138, 118))
    for x in range(0, width, 37):
        draw.line([(x, int(height * 0.55)), (x + 11, height)], fill=(140, 128, 108), width=2)
    return canvas


def _finished_image(size: tuple[int, int] = (640, 360)) -> Image.Image:
    """A completed block: façade, a grid of windows, greenery at the base."""
    width, height = size
    canvas = Image.new("RGB", size, (150, 190, 230))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, int(height * 0.55), width, height], fill=(150, 138, 118))
    draw.rectangle(
        [int(width * 0.18), int(height * 0.18), int(width * 0.82), int(height * 0.78)],
        fill=(226, 220, 208),
    )
    for row in range(5):
        for column in range(7):
            x = int(width * 0.22) + column * int(width * 0.085)
            y = int(height * 0.23) + row * int(height * 0.105)
            draw.rectangle([x, y, x + int(width * 0.05), y + int(height * 0.06)], fill=(48, 62, 88))
    draw.rectangle([0, int(height * 0.86), width, height], fill=(72, 128, 66))
    return canvas


@pytest.fixture
def site_image() -> Image.Image:
    return _site_image()


@pytest.fixture
def finished_image() -> Image.Image:
    return _finished_image()


@pytest.fixture
def site_path(tmp_path: Path) -> Path:
    path = tmp_path / "before.jpg"
    _site_image().save(path, quality=92)
    return path


@pytest.fixture
def finished_path(tmp_path: Path) -> Path:
    path = tmp_path / "after.jpg"
    _finished_image().save(path, quality=92)
    return path


@pytest.fixture
def noise_image() -> Image.Image:
    rng = np.random.default_rng(0)
    return Image.fromarray(rng.integers(0, 255, (240, 320, 3), dtype=np.uint8))
