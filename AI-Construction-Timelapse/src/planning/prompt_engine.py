"""Composing the Wan2.1 prompts from the analysis and the stage plan.

Two things dominate output quality for a first-last-frame model on this task.
The prompt has to name the construction work concretely, stage by stage, or the
model fills 81 frames with a slow dissolve. And it has to pin the camera and the
final geometry hard, or the building drifts into a different building on its way
to the last frame.
"""

from __future__ import annotations

import logging

from ..analysis.image_analyzer import ImageAnalysis
from .stage_planner import ConstructionPlan, SegmentPlan, Speed

logger = logging.getLogger(__name__)

#: Applied to every generation. Ordered roughly by how often each failure shows
#: up in first-last-frame construction transitions.
NEGATIVE_PROMPT_TERMS: tuple[str, ...] = (
    "distorted building",
    "warped architecture",
    "changing camera angle",
    "camera jump",
    "duplicated windows",
    "disappearing windows",
    "floating objects",
    "melting walls",
    "deformed workers",
    "extra floors",
    "missing floors",
    "changing roof",
    "changing facade",
    "unrealistic construction",
    "cartoon",
    "CGI look",
    "fantasy architecture",
    "unstable geometry",
    "flickering",
    "temporal inconsistency",
    "excessive camera movement",
    "object morphing",
    "blurry final building",
    "text",
    "watermark",
    "logo",
    "oversaturated colours",
)

SPEED_PHRASES: dict[Speed, str] = {
    "realistic": (
        "moderately accelerated time-lapse, roughly one construction day per second, "
        "workers and machinery moving at a brisk but readable pace"
    ),
    "fast": (
        "strongly accelerated time-lapse, workers and vehicles streaking with motion blur, "
        "clouds crossing the sky quickly, shadows sweeping across the site"
    ),
    "hyperlapse": (
        "extreme hyperlapse, workers reduced to blurred streaks, day and night cycling rapidly, "
        "materials appearing in fast bursts, shadows racing across the ground"
    ),
}

CAMERA_PHRASES: dict[bool, str] = {
    True: (
        "locked-off static camera on a rigid tripod, identical camera position, framing and "
        "focal length in every frame, absolutely no pan, tilt, zoom or parallax"
    ),
    False: (
        "very slow cinematic push-in on a motion-control rig, no more than a few percent of "
        "frame width over the whole shot, identical framing and focal length otherwise"
    ),
}

#: Non-negotiable, appended to every positive prompt.
GEOMETRY_LOCK = (
    "The final building geometry is fixed and must match the last frame exactly: same footprint, "
    "same number of floors, same roof line, same window grid, same facade materials and same "
    "proportions. Do not invent a different building. Materials appear progressively and "
    "additively, bolted, poured, lifted and fixed into place, never melting, morphing or "
    "growing organically"
)


def build_negative_prompt(extra: str = "") -> str:
    """Return the shared negative prompt, optionally extended by the user."""
    terms = ", ".join(NEGATIVE_PROMPT_TERMS)
    extra = extra.strip().strip(",")
    return f"{terms}, {extra}" if extra else terms


def _article(word: str) -> str:
    """Pick "a" or "an" for the next word."""
    return "an" if word[:1].lower() in "aeiou" else "a"


def _scene_context(analysis: ImageAnalysis, plan: ConstructionPlan) -> str:
    """Describe the setting so the model keeps the surroundings stable."""
    # analysis.perspective already ends in "view"/"level"; adding another
    # "view" here produced "interior room view view of a ...".
    kind = plan.construction_type
    parts = [f"{analysis.perspective} of {_article(kind)} {kind} construction site"]

    if analysis.neighbouring_structures:
        parts.append(
            f"{analysis.neighbouring_structures} neighbouring building(s) that must stay unchanged"
        )
    if analysis.vegetation_ratio > 0.08:
        parts.append("surrounding trees and vegetation that stay in place")
    if analysis.sky_ratio > 0.05:
        parts.append("open sky above the site")
    if analysis.road_ratio > 0.05:
        parts.append("an adjacent road that stays unchanged")

    parts.append(f"{analysis.time_of_day} with {analysis.colour_temperature}")
    if analysis.shadow_ratio > 0.05 and analysis.shadow_direction not in {"diffuse", "overhead"}:
        parts.append(f"consistent shadows falling toward {analysis.shadow_direction}")
    return ", ".join(parts)


def _stage_sentence(segment: SegmentPlan, catalogue_lookup: dict[str, dict[str, str]]) -> str:
    """Spell out the ordered work covered by one segment."""
    clauses: list[str] = []
    for position, stage in enumerate(segment.stages):
        details = catalogue_lookup.get(stage.key, {})
        activity = details.get("activity", stage.description)
        machinery = details.get("machinery", "")
        materials = details.get("materials", "")

        clause = activity
        if machinery and machinery != "none":
            clause += f", with {machinery}"
        if materials and materials != "none":
            clause += f", {materials} visible"
        clauses.append(f"then {clause}" if position else clause)
    return "; ".join(clauses)


def build_segment_prompt(
    segment: SegmentPlan,
    plan: ConstructionPlan,
    analysis: ImageAnalysis,
    speed: Speed = "realistic",
    catalogue_lookup: dict[str, dict[str, str]] | None = None,
    extra: str = "",
) -> str:
    """Compose the positive prompt for one Wan2.1 generation."""
    lookup = catalogue_lookup or {}
    locked = bool(plan.camera.get("locked", True))

    sections = [
        "Photorealistic construction time-lapse, 4K, sharp textures, realistic daylight and "
        "realistic shadows.",
        f"Scene: {_scene_context(analysis, plan)}.",
        f"Camera: {CAMERA_PHRASES[locked]}.",
        f"Construction sequence, strictly in this order: {_stage_sentence(segment, lookup)}.",
        f"Pacing: {SPEED_PHRASES.get(speed, SPEED_PHRASES['realistic'])}, "
        "with realistic motion blur on anything that moves.",
        f"{GEOMETRY_LOCK}.",
        "Scaffolding is erected and struck in the correct order. Concrete work, steel "
        "reinforcement and masonry read as real construction. The structure is continuously "
        "supported and never floats.",
    ]
    if extra.strip():
        sections.append(extra.strip().rstrip(".") + ".")

    prompt = " ".join(sections)
    logger.debug("Segment %d prompt (%d chars)", segment.index, len(prompt))
    return prompt


def annotate_plan(
    plan: ConstructionPlan,
    analysis: ImageAnalysis,
    speed: Speed = "realistic",
    extra_positive: str = "",
    extra_negative: str = "",
) -> ConstructionPlan:
    """Fill in every prompt on a plan, in place, and return it.

    Each stage also gets its own short prompt so the UI timeline can show what
    the model was told for that step.
    """
    from .stage_planner import CATALOGUES

    catalogue = CATALOGUES.get(plan.construction_type.lower(), CATALOGUES["building"])
    lookup = {
        template.key: {
            "activity": template.activity,
            "machinery": template.machinery,
            "materials": template.materials,
        }
        for template in catalogue
    }

    negative = build_negative_prompt(extra_negative)
    for stage in plan.stages:
        details = lookup.get(stage.key, {})
        stage.prompt = (
            f"{stage.name}: {details.get('activity', stage.description)}. "
            f"Materials: {details.get('materials', 'n/a')}."
        )
    for segment in plan.segments:
        segment.prompt = build_segment_prompt(
            segment, plan, analysis, speed, lookup, extra_positive
        )
        segment.negative_prompt = negative
    return plan
