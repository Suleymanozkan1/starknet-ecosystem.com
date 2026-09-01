"""Comparing the two stills: camera agreement and where each sits on the build.

The planner needs two verdicts from this module. First, whether the uploads
share a viewpoint, because Wan cannot invent a camera move between mismatched
frames without visible morphing. Second, which construction stage each image
already depicts, so the plan can skip work that is evidently done.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import IntEnum

import cv2
import numpy as np
from PIL import Image

from .image_analyzer import ImageAnalysis

logger = logging.getLogger(__name__)


class Stage(IntEnum):
    """The canonical construction sequence, in order.

    Ordering matters: the planner selects the contiguous span between where the
    BEFORE image sits and where the AFTER image sits.
    """

    EMPTY_SITE = 1
    EXCAVATION = 2
    FOUNDATION = 3
    STRUCTURAL_FRAME = 4
    FLOOR_SLABS = 5
    UPPER_FLOORS = 6
    ROOF = 7
    EXTERIOR_WALLS = 8
    WINDOWS_DOORS = 9
    FACADE_FINISHING = 10
    LANDSCAPING = 11
    COMPLETED = 12


#: Where each stage sits on the 0-1 progress scale produced by the analyzer.
STAGE_PROGRESS: dict[Stage, float] = {
    Stage.EMPTY_SITE: 0.00,
    Stage.EXCAVATION: 0.08,
    Stage.FOUNDATION: 0.16,
    Stage.STRUCTURAL_FRAME: 0.28,
    Stage.FLOOR_SLABS: 0.38,
    Stage.UPPER_FLOORS: 0.48,
    Stage.ROOF: 0.58,
    Stage.EXTERIOR_WALLS: 0.68,
    Stage.WINDOWS_DOORS: 0.78,
    Stage.FACADE_FINISHING: 0.87,
    Stage.LANDSCAPING: 0.94,
    Stage.COMPLETED: 1.00,
}


@dataclass(frozen=True)
class CameraComparison:
    """How well two stills agree on viewpoint."""

    similarity: float
    horizon_delta: float
    aspect_delta: float
    verdict: str  # "locked" | "align" | "mismatched"
    message: str

    @property
    def needs_alignment(self) -> bool:
        return self.verdict == "align"

    @property
    def is_mismatched(self) -> bool:
        return self.verdict == "mismatched"


def _colour_signature(image: Image.Image) -> np.ndarray:
    """Coarse HSV histogram, normalised, as a viewpoint fingerprint."""
    array = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2HSV)
    hist = cv2.calcHist([array], [0, 1], None, [24, 12], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist.flatten()


def _layout_signature(image: Image.Image) -> np.ndarray:
    """Downsampled luminance, describing where mass sits in the frame."""
    grey = np.asarray(image.convert("L").resize((32, 32), Image.LANCZOS), dtype=np.float32)
    grey -= grey.mean()
    norm = np.linalg.norm(grey)
    return (grey / norm).flatten() if norm > 1e-6 else grey.flatten()


def compare_cameras(
    before: Image.Image,
    after: Image.Image,
    before_analysis: ImageAnalysis,
    after_analysis: ImageAnalysis,
    threshold: float = 0.55,
) -> CameraComparison:
    """Judge whether the two stills were taken from the same viewpoint.

    Three signals are blended: horizon height, frame aspect, and the spatial
    layout of luminance. A construction site and its finished render legitimately
    differ in colour and detail, so colour agreement is weighted lightly.
    """
    horizon_delta = abs(before_analysis.horizon_y - after_analysis.horizon_y)
    aspect_before = before.width / before.height
    aspect_after = after.width / after.height
    aspect_delta = abs(aspect_before - aspect_after) / max(aspect_before, aspect_after)

    layout = float(np.dot(_layout_signature(before), _layout_signature(after)))
    layout = (layout + 1.0) / 2.0  # cosine in [-1, 1] -> [0, 1]
    colour = float(
        cv2.compareHist(
            _colour_signature(before).reshape(-1, 1),
            _colour_signature(after).reshape(-1, 1),
            cv2.HISTCMP_CORREL,
        )
    )
    colour = max(0.0, min(1.0, (colour + 1.0) / 2.0))

    similarity = (
        0.45 * layout
        + 0.30 * max(0.0, 1.0 - horizon_delta * 3.0)
        + 0.15 * max(0.0, 1.0 - aspect_delta * 2.0)
        + 0.10 * colour
    )
    similarity = float(np.clip(similarity, 0.0, 1.0))

    if similarity >= threshold + 0.15:
        verdict = "locked"
        message = (
            f"Viewpoints agree (similarity {similarity:.2f}). Using a locked camera."
        )
    elif similarity >= threshold:
        verdict = "align"
        message = (
            f"Viewpoints differ slightly (similarity {similarity:.2f}). "
            "A best-effort alignment will be applied before generation."
        )
    else:
        verdict = "mismatched"
        message = (
            "Before and after images have significantly different camera perspectives. "
            f"Results may be unstable (similarity {similarity:.2f}, "
            f"horizon differs by {horizon_delta:.2f} of frame height). "
            "For a convincing timelapse, re-shoot or re-render the AFTER image from the "
            "same camera position, angle and focal length as the BEFORE photo."
        )
    return CameraComparison(similarity, horizon_delta, aspect_delta, verdict, message)


def align_images(
    before: Image.Image, after: Image.Image
) -> tuple[Image.Image, bool, str]:
    """Warp `after` onto `before` using ORB feature matches.

    Returns the aligned image, whether alignment actually succeeded, and a note
    for the log. The original is returned untouched when too few features match,
    which is the common case for a photo paired with a render.
    """
    before_grey = np.asarray(before.convert("L"))
    after_grey = np.asarray(after.convert("L"))

    orb = cv2.ORB_create(nfeatures=2000)
    kp1, des1 = orb.detectAndCompute(after_grey, None)
    kp2, des2 = orb.detectAndCompute(before_grey, None)
    if des1 is None or des2 is None or len(kp1) < 12 or len(kp2) < 12:
        return after, False, "Alignment skipped: too few keypoints in one of the images."

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = sorted(matcher.match(des1, des2), key=lambda m: m.distance)[:120]
    if len(matches) < 12:
        return after, False, f"Alignment skipped: only {len(matches)} feature matches."

    src = np.float32([kp1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([kp2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if matrix is None or inliers is None or int(inliers.sum()) < 10:
        return after, False, "Alignment skipped: no stable transform between the images."

    warped = cv2.warpAffine(
        np.asarray(after.convert("RGB")),
        matrix,
        (before.width, before.height),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_REPLICATE,
    )
    note = f"Aligned AFTER onto BEFORE using {int(inliers.sum())} inlier feature matches."
    return Image.fromarray(warped), True, note


def detect_stage(analysis: ImageAnalysis) -> Stage:
    """Map a measured progress score onto the nearest canonical stage."""
    progress = analysis.construction_progress
    best = min(STAGE_PROGRESS, key=lambda stage: abs(STAGE_PROGRESS[stage] - progress))

    # An image with no building at all is an empty site regardless of the score.
    if analysis.building is None or analysis.building_footprint_ratio < 0.02:
        return Stage.EMPTY_SITE
    # A structure with many lines but almost no openings has not been clad yet.
    if best >= Stage.WINDOWS_DOORS and analysis.opening_count < 3:
        return Stage.STRUCTURAL_FRAME
    return best


@dataclass(frozen=True)
class ConstructionComparison:
    """Where the two stills sit relative to each other on the build."""

    before_stage: Stage
    after_stage: Stage
    camera: CameraComparison
    warnings: list[str]

    @property
    def is_regression(self) -> bool:
        """True when AFTER looks less complete than BEFORE."""
        return self.after_stage <= self.before_stage


def compare_construction(
    before: Image.Image,
    after: Image.Image,
    before_analysis: ImageAnalysis,
    after_analysis: ImageAnalysis,
    camera_threshold: float = 0.55,
) -> ConstructionComparison:
    """Full comparison feeding the stage planner."""
    camera = compare_cameras(before, after, before_analysis, after_analysis, camera_threshold)
    before_stage = detect_stage(before_analysis)
    after_stage = detect_stage(after_analysis)

    warnings: list[str] = []
    if camera.is_mismatched:
        warnings.append(camera.message)
    if after_stage <= before_stage:
        warnings.append(
            f"The AFTER image does not look more complete than the BEFORE image "
            f"(detected {before_stage.name} -> {after_stage.name}). "
            "Check that the two uploads are the right way round; the plan will assume "
            "the AFTER image is the intended final state regardless."
        )
    if after_analysis.construction_progress < 0.4:
        warnings.append(
            "The AFTER image scores low on completion cues. If it is a finished building, "
            "the analyser may be misreading it, and stage selection could be too short."
        )
    return ConstructionComparison(before_stage, after_stage, camera, warnings)
