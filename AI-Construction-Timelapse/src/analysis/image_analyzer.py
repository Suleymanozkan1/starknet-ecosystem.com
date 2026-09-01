"""Structural analysis of a single still.

Everything here is classical computer vision: colour statistics, gradients,
Hough lines and connected components. No vision-language model is involved, so
each field is a measurement with a stated method rather than a description
invented by a model. Fields carry a ``confidence`` where the heuristic is weak,
and the docstrings say plainly what each one keys off.

The output feeds two consumers: the stage planner, which needs to know how far
along each image already is, and the prompt engine, which needs concrete nouns
to put in the Wan prompt.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Literal

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

CameraAngle = Literal["aerial", "elevated", "eye-level", "low-angle", "interior"]

#: Analysis runs at this width; larger inputs are downscaled first so the
#: gradient and Hough thresholds mean the same thing for every upload.
ANALYSIS_WIDTH = 960


@dataclass(frozen=True)
class Region:
    """A normalised bounding box, origin at the top-left."""

    x: float
    y: float
    width: float
    height: float

    @property
    def area(self) -> float:
        return self.width * self.height

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


@dataclass
class ImageAnalysis:
    """Everything measured from one still.

    Ratios are fractions of the frame area; positions are normalised to
    ``[0, 1]`` with ``y=0`` at the top.
    """

    width: int
    height: int

    camera_angle: CameraAngle
    perspective: str
    horizon_y: float
    horizon_confidence: float

    building: Region | None
    building_footprint_ratio: float
    estimated_floors: int
    floors_confidence: float
    roof_line_y: float | None
    roof_flat: bool

    facade_complexity: float
    opening_count: int
    balcony_bands: int

    sky_ratio: float
    vegetation_ratio: float
    ground_ratio: float
    road_ratio: float
    neighbouring_structures: int

    mean_brightness: float
    shadow_ratio: float
    shadow_direction: str
    time_of_day: str
    colour_temperature: str

    structural_edge_density: float
    vertical_line_count: int
    horizontal_line_count: int
    material_rawness: float

    construction_progress: float
    progress_confidence: float
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        data = {
            key: (value.as_dict() if isinstance(value, Region) else value)
            for key, value in self.__dict__.items()
        }
        return data

    def summary_lines(self) -> list[str]:
        """Short human-readable digest for the UI."""
        floors = f"~{self.estimated_floors}" if self.estimated_floors else "n/a"
        return [
            f"Camera: {self.camera_angle} ({self.perspective}), horizon at y={self.horizon_y:.2f}",
            f"Building footprint: {self.building_footprint_ratio * 100:.0f}% of frame, floors {floors}",
            f"Openings detected: {self.opening_count}, facade complexity {self.facade_complexity:.2f}",
            f"Sky {self.sky_ratio * 100:.0f}%  vegetation {self.vegetation_ratio * 100:.0f}%  "
            f"ground {self.ground_ratio * 100:.0f}%",
            f"Light: {self.time_of_day}, {self.colour_temperature}, shadows from {self.shadow_direction}",
            f"Construction progress: {self.construction_progress * 100:.0f}% "
            f"(confidence {self.progress_confidence:.2f})",
        ]


def _prepare(image: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return BGR, HSV and greyscale arrays at the analysis width."""
    rgb = np.asarray(image.convert("RGB"))
    height, width = rgb.shape[:2]
    if width > ANALYSIS_WIDTH:
        scale = ANALYSIS_WIDTH / width
        rgb = cv2.resize(
            rgb, (ANALYSIS_WIDTH, max(1, round(height * scale))), interpolation=cv2.INTER_AREA
        )
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    return bgr, cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV), cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


def _sky_mask(hsv: np.ndarray, grey: np.ndarray) -> np.ndarray:
    """Sky is the unbroken run of sky-coloured pixels from the top of each column.

    An earlier version kept any connected component touching the top edge, which
    leaked badly in both directions: a pale building facade adjoining the sky was
    swallowed into the same component and counted as sky, and a lit interior
    ceiling registered as overcast. Walking down each column instead means the
    mask stops at the first non-sky pixel and cannot reach past a roofline.
    """
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    blue = (hue > 90) & (hue < 135) & (sat > 30) & (val > 90)
    # Deliberately strict: a lit interior ceiling sits around value 180 with a
    # warm cast, and used to register as overcast sky.
    pale = (sat < 25) & (val > 205)
    qualify = (blue | pale).astype(np.uint8)

    # Bridge thin interruptions (a wire, an aerial) so they do not truncate a
    # column's sky run, without bridging a whole roofline.
    qualify = cv2.morphologyEx(qualify, cv2.MORPH_CLOSE, np.ones((5, 1), np.uint8))
    return np.cumprod(qualify, axis=0).astype(np.uint8)


def _vegetation_mask(hsv: np.ndarray) -> np.ndarray:
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (((hue > 25) & (hue < 90) & (sat > 40) & (val > 25))).astype(np.uint8)


def _ground_mask(hsv: np.ndarray, sky: np.ndarray, vegetation: np.ndarray) -> np.ndarray:
    """Bare earth and hardstanding: low saturation, mid value, lower half."""
    sat, val = hsv[..., 1], hsv[..., 2]
    mask = ((sat < 70) & (val > 50) & (val < 220)).astype(np.uint8)
    mask[: mask.shape[0] // 2, :] = 0
    return (mask & ~sky.astype(bool) & ~vegetation.astype(bool)).astype(np.uint8)


def _horizon(sky: np.ndarray, grey: np.ndarray) -> tuple[float, float]:
    """Estimate the horizon as the lowest row still dominated by sky."""
    rows, _ = sky.shape
    coverage = sky.mean(axis=1)
    below = np.where(coverage < 0.25)[0]
    if below.size and below[0] > 0 and coverage[: below[0]].mean() > 0.4:
        return float(below[0] / rows), 0.8

    # No usable sky: fall back to the strongest horizontal gradient band, which
    # in interiors tends to be the wall/floor junction.
    gradient = np.abs(np.diff(grey.mean(axis=1)))
    if gradient.size == 0:
        return 0.5, 0.1
    band = int(np.argmax(gradient))
    return float(band / rows), 0.3


def _structure_lines(grey: np.ndarray) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    """Count near-vertical and near-horizontal line segments."""
    edges = cv2.Canny(grey, 60, 170, apertureSize=3)
    segments = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=70, minLineLength=grey.shape[0] // 12, maxLineGap=12
    )
    vertical = horizontal = 0
    kept: list[tuple[int, int, int, int]] = []
    if segments is None or len(segments) == 0:
        return 0, 0, kept
    for x1, y1, x2, y2 in np.asarray(segments).reshape(-1, 4):
        angle = abs(math.degrees(math.atan2(y2 - y1, x2 - x1)))
        if angle > 90:
            angle = 180 - angle
        if angle > 70:
            vertical += 1
            kept.append((x1, y1, x2, y2))
        elif angle < 20:
            horizontal += 1
            kept.append((x1, y1, x2, y2))
    return vertical, horizontal, kept


def _building_region(grey: np.ndarray, sky: np.ndarray, vegetation: np.ndarray) -> Region | None:
    """Largest built-looking blob: high edge density, not sky, not foliage.

    The smoothing kernel has to be wide enough to merge a grid of windows into a
    single facade. With a narrow kernel the gaps between windows survive
    thresholding and the largest blob collapses onto one column of glazing,
    which then makes every window look oversized relative to its own patch.
    Kernels therefore scale with the frame width rather than being fixed.
    """
    rows, cols = grey.shape
    blur = max(15, int(round(cols * 0.086)) | 1)
    close = max(11, int(round(cols * 0.070)))

    edges = cv2.Canny(grey, 50, 150)
    density = cv2.blur(edges.astype(np.float32) / 255.0, (blur, blur))
    built = (density > max(0.04, float(np.percentile(density, 70)))).astype(np.uint8)
    built &= (~sky.astype(bool)).astype(np.uint8)
    built &= (~vegetation.astype(bool)).astype(np.uint8)
    built = cv2.morphologyEx(built, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))

    contours, _ = cv2.findContours(built, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < grey.size * 0.01:
        return None
    x, y, w, h = cv2.boundingRect(largest)
    return Region(x / cols, y / rows, w / cols, h / rows)


def _count_openings(grey: np.ndarray, region: Region | None) -> tuple[int, int]:
    """Count window-like rectangles, and the rows they cluster into.

    Windows read as compact, roughly rectangular regions that contrast with the
    facade. Rows of them at similar heights suggest storeys or balcony bands.
    """
    if region is None or region.area < 0.01:
        return 0, 0
    rows, cols = grey.shape
    x0, y0 = int(region.x * cols), int(region.y * rows)
    x1, y1 = int((region.x + region.width) * cols), int((region.y + region.height) * rows)
    patch = grey[max(0, y0) : min(rows, y1), max(0, x0) : min(cols, x1)]
    if patch.size < 400:
        return 0, 0

    binary = cv2.adaptiveThreshold(
        patch, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 8
    )
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    centres: list[int] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if area < patch.size * 0.0008 or area > patch.size * 0.08:
            continue
        ratio = w / max(1, h)
        if 0.25 < ratio < 4.0 and cv2.contourArea(contour) > 0.55 * area:
            centres.append(y + h // 2)

    if not centres:
        return 0, 0
    tolerance = max(4, patch.shape[0] // 25)
    bands = 1
    for previous, current in zip(sorted(centres), sorted(centres)[1:]):
        if current - previous > tolerance:
            bands += 1
    return len(centres), bands


def _shadows(grey: np.ndarray, bgr: np.ndarray) -> tuple[float, str]:
    """Shadow coverage, and which side of bright regions they fall on."""
    threshold = max(35.0, float(np.percentile(grey, 22)))
    shadow = (grey < threshold).astype(np.uint8)
    ratio = float(shadow.mean())
    if ratio < 0.02:
        return ratio, "diffuse"

    columns = shadow.mean(axis=0)
    half = len(columns) // 2
    left, right = columns[:half].mean(), columns[half:].mean()
    if abs(left - right) < 0.02:
        return ratio, "overhead"
    return ratio, "the left" if left > right else "the right"


def _material_rawness(bgr: np.ndarray, hsv: np.ndarray) -> float:
    """How much of the frame looks like bare concrete, soil or formwork.

    Raw construction materials sit in a narrow grey-brown band with low
    saturation; finished facades are either much lighter or much more colourful.
    """
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    concrete = (sat < 55) & (val > 70) & (val < 200)
    earth = (hue > 5) & (hue < 30) & (sat > 40) & (sat < 170) & (val > 50) & (val < 190)
    return float((concrete | earth).mean())


def _time_of_day(mean_v: float, hsv: np.ndarray) -> tuple[str, str]:
    warmth = float(np.mean((hsv[..., 0] < 30) | (hsv[..., 0] > 160)))
    if mean_v < 60:
        return "night", "cool artificial light"
    if mean_v < 110:
        return "dusk or dawn", "warm low light"
    if warmth > 0.45:
        return "golden hour", "warm light"
    return "daytime", "neutral daylight"


def _progress(
    building: Region | None,
    openings: int,
    rawness: float,
    vegetation: float,
    facade_complexity: float,
    vertical_lines: int,
    horizontal_lines: int,
) -> tuple[float, float, list[str]]:
    """Estimate how complete the construction looks, on a 0-1 scale.

    This is a decision tree rather than a weighted sum, because the underlying
    cues are not monotonic in completion. Edge density is the clearest example:
    an empty site has very few edges, a structural frame has the most of any
    stage (studs, joists, rebar, formwork), and a finished building settles
    back to a moderate level as cladding covers the structure. Averaging that
    against other signals loses the distinction entirely.

    Confidence is deliberately capped low. These are appearance heuristics, not
    scene understanding, and the caller is expected to let the user override the
    result rather than treat it as ground truth.
    """
    notes: list[str] = []
    if building is None or building.area < 0.02:
        notes.append("No building-like region found; treating this as an empty or cleared site.")
        return 0.03, 0.55, notes

    footprint = min(1.0, building.area / 0.45)
    lines = vertical_lines + horizontal_lines
    skeletal = lines > 45 and facade_complexity > 0.05 and openings < 6
    furnished = openings >= 6 and facade_complexity < 0.06
    landscaped = vegetation > 0.10

    if skeletal:
        notes.append(
            f"High line count ({lines}) with few openings ({openings}): "
            "reads as exposed structure, not a finished envelope."
        )
        progress = 0.28 + 0.10 * footprint
        confidence = 0.5
    elif furnished and landscaped:
        notes.append("Openings, low edge density and surrounding greenery: reads as completed.")
        progress = 0.95
        confidence = 0.55
    elif furnished:
        notes.append("Openings present with a settled facade: reads as finishing or complete.")
        progress = 0.85
        confidence = 0.45
    elif openings >= 3:
        notes.append("Some openings visible: reads as the walls-and-windows phase.")
        progress = 0.70
        confidence = 0.35
    else:
        notes.append(
            "Few distinguishing cues; falling back to footprint alone. "
            "Set the starting stage manually if this is wrong."
        )
        progress = 0.30 + 0.25 * footprint
        confidence = 0.2

    if rawness > 0.55 and openings < 4:
        progress = min(progress, 0.45)
        notes.append(
            f"Large areas of bare concrete or earth ({rawness * 100:.0f}% of frame) "
            "cap the estimate below the finishing stages."
        )
    return float(np.clip(progress, 0.0, 1.0)), confidence, notes


def analyze_image(image: Image.Image) -> ImageAnalysis:
    """Measure the structural and environmental properties of one still."""
    bgr, hsv, grey = _prepare(image)
    rows, cols = grey.shape

    sky = _sky_mask(hsv, grey)
    vegetation = _vegetation_mask(hsv)
    ground = _ground_mask(hsv, sky, vegetation)

    horizon_y, horizon_confidence = _horizon(sky, grey)
    vertical_lines, horizontal_lines, _ = _structure_lines(grey)
    building = _building_region(grey, sky, vegetation)
    openings, bands = _count_openings(grey, building)

    edges = cv2.Canny(grey, 50, 150)
    facade_complexity = float(edges.mean() / 255.0)
    rawness = _material_rawness(bgr, hsv)
    mean_brightness = float(hsv[..., 2].mean())
    shadow_ratio, shadow_direction = _shadows(grey, bgr)
    time_of_day, colour_temperature = _time_of_day(mean_brightness, hsv)

    sky_ratio = float(sky.mean())
    vegetation_ratio = float(vegetation.mean())
    ground_ratio = float(ground.mean())

    if sky_ratio < 0.02 and horizon_y > 0.55:
        camera_angle: CameraAngle = "interior"
        perspective = "interior room view"
    elif horizon_y < 0.22:
        camera_angle = "low-angle"
        perspective = "looking up from ground level"
    elif horizon_y < 0.45:
        camera_angle = "eye-level"
        perspective = "street-level"
    elif horizon_y < 0.68:
        camera_angle = "elevated"
        perspective = "elevated or drone view"
    else:
        camera_angle = "aerial"
        perspective = "high aerial view"

    floors = max(0, bands if bands > 1 else (1 if building else 0))
    floors_confidence = 0.5 if bands > 1 else 0.25

    roof_line_y = building.y if building else None
    roof_flat = horizontal_lines > vertical_lines * 0.8 if building else False

    # Distinct built blobs other than the main one, as a proxy for neighbours.
    neighbours = 0
    if building is not None:
        density = cv2.blur(edges.astype(np.float32) / 255.0, (25, 25))
        built = ((density > 0.08) & (~sky.astype(bool)) & (~vegetation.astype(bool))).astype(np.uint8)
        contours, _ = cv2.findContours(built, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        neighbours = max(0, sum(1 for c in contours if cv2.contourArea(c) > grey.size * 0.008) - 1)

    # Road-like: desaturated horizontal ground bands below the horizon.
    road_band = ground.copy()
    road_band[: int(horizon_y * rows), :] = 0
    road_ratio = float(road_band.mean() * 0.5)

    progress, progress_confidence, notes = _progress(
        building, openings, rawness, vegetation_ratio, facade_complexity,
        vertical_lines, horizontal_lines,
    )

    analysis = ImageAnalysis(
        width=image.width,
        height=image.height,
        camera_angle=camera_angle,
        perspective=perspective,
        horizon_y=horizon_y,
        horizon_confidence=horizon_confidence,
        building=building,
        building_footprint_ratio=building.area if building else 0.0,
        estimated_floors=floors,
        floors_confidence=floors_confidence,
        roof_line_y=roof_line_y,
        roof_flat=roof_flat,
        facade_complexity=facade_complexity,
        opening_count=openings,
        balcony_bands=bands,
        sky_ratio=sky_ratio,
        vegetation_ratio=vegetation_ratio,
        ground_ratio=ground_ratio,
        road_ratio=road_ratio,
        neighbouring_structures=neighbours,
        mean_brightness=mean_brightness,
        shadow_ratio=shadow_ratio,
        shadow_direction=shadow_direction,
        time_of_day=time_of_day,
        colour_temperature=colour_temperature,
        structural_edge_density=facade_complexity,
        vertical_line_count=vertical_lines,
        horizontal_line_count=horizontal_lines,
        material_rawness=rawness,
        construction_progress=progress,
        progress_confidence=progress_confidence,
        notes=notes,
    )
    logger.debug("Analysis: %s", analysis.summary_lines())
    return analysis
