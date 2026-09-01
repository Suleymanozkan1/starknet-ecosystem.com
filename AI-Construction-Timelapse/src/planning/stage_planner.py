"""Turning two analysed stills into an ordered construction plan.

The catalogue below is per construction type, because a road and an apartment
block share almost no intermediate states. The planner never emits the whole
catalogue: it selects the span between where the BEFORE image already sits and
where the AFTER image ends up, then distributes that span across however many
video segments the requested duration allows.
"""

from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from ..analysis.construction_detector import ConstructionComparison, Stage
from ..analysis.image_analyzer import ImageAnalysis

logger = logging.getLogger(__name__)

ConstructionType = Literal[
    "building",
    "house",
    "apartment",
    "commercial building",
    "industrial building",
    "interior renovation",
    "road",
    "bridge",
    "other",
]

CONSTRUCTION_TYPES: tuple[ConstructionType, ...] = (
    "building",
    "house",
    "apartment",
    "commercial building",
    "industrial building",
    "interior renovation",
    "road",
    "bridge",
    "other",
)

Speed = Literal["realistic", "fast", "hyperlapse"]
CameraMode = Literal["locked", "cinematic"]


class StageTemplate(BaseModel):
    """One entry in a construction catalogue."""

    key: str
    name: str
    description: str
    #: Position on the 0-1 completion scale, used to select the relevant span.
    progress: float = Field(ge=0.0, le=1.0)
    #: Concrete nouns handed to the prompt engine.
    activity: str
    machinery: str
    materials: str


#: The canonical vertical-build sequence, matching the Stage enum.
BUILDING_STAGES: list[StageTemplate] = [
    StageTemplate(
        key="empty_site", name="Empty site / ground preparation", progress=0.00,
        description="Bare plot, vegetation cleared, site fenced and set out.",
        activity="surveyors setting out, ground being cleared and levelled",
        machinery="a bulldozer and a compactor", materials="bare soil, gravel, site fencing",
    ),
    StageTemplate(
        key="excavation", name="Excavation", progress=0.08,
        description="Excavators cut the foundation pit and remove spoil.",
        activity="excavators digging the foundation pit, trucks hauling spoil away",
        machinery="tracked excavators and dump trucks", materials="exposed earth, shoring boards",
    ),
    StageTemplate(
        key="foundation", name="Foundation and underground structure", progress=0.16,
        description="Reinforcement cages set, formwork erected, concrete poured.",
        activity="steel reinforcement being tied, formwork erected, concrete poured and vibrated",
        machinery="a concrete pump and mixer trucks", materials="rebar cages, plywood formwork, wet concrete",
    ),
    StageTemplate(
        key="structural_frame", name="Columns and structural frame", progress=0.28,
        description="Vertical columns and the primary frame rise from the foundation.",
        activity="columns being cast and stripped, the frame rising storey by storey",
        machinery="a tower crane lifting formwork", materials="reinforced concrete columns, scaffolding",
    ),
    StageTemplate(
        key="floor_slabs", name="Floor slabs", progress=0.38,
        description="Slab formwork, reinforcement and pours for each level.",
        activity="slab formwork being set, reinforcement laid, concrete poured and levelled",
        machinery="a tower crane and concrete pump", materials="slab formwork, mesh reinforcement, concrete",
    ),
    StageTemplate(
        key="upper_floors", name="Upper floors", progress=0.48,
        description="The structure reaches its full height, floor by floor.",
        activity="successive storeys being formed, poured and stripped",
        machinery="a climbing tower crane", materials="concrete, scaffolding, safety netting",
    ),
    StageTemplate(
        key="roof", name="Roof", progress=0.58,
        description="Roof structure, decking and waterproofing complete the envelope top.",
        activity="roof structure being assembled, decking and waterproofing laid",
        machinery="a crane lifting roof trusses", materials="timber or steel trusses, membrane, tiles",
    ),
    StageTemplate(
        key="exterior_walls", name="Exterior walls", progress=0.68,
        description="Infill masonry and blockwork close the envelope.",
        activity="masons laying blockwork, walls closing the open frame",
        machinery="material hoists and mortar mixers", materials="blockwork, brick, mortar, insulation",
    ),
    StageTemplate(
        key="windows_doors", name="Windows and doors", progress=0.78,
        description="Glazing units and door sets are fitted into the openings.",
        activity="glazing units lifted into openings and sealed, door frames fitted",
        machinery="glazing robots and scissor lifts", materials="glass units, aluminium frames, sealant",
    ),
    StageTemplate(
        key="facade_finishing", name="Facade finishing", progress=0.87,
        description="Cladding, render and paint bring the facade to its final appearance.",
        activity="cladding panels fixed, render applied and finished, scaffolding struck",
        machinery="mast climbers and scissor lifts", materials="cladding panels, render, stone, paint",
    ),
    StageTemplate(
        key="landscaping", name="Landscaping", progress=0.94,
        description="Paving, planting and lighting complete the setting.",
        activity="paving laid, trees and shrubs planted, lighting installed",
        machinery="small loaders and compactors", materials="paving, topsoil, planting, lighting columns",
    ),
    StageTemplate(
        key="completed", name="Final completed building", progress=1.00,
        description="The finished building, clean and occupied, with no site activity.",
        activity="no construction activity; the completed building stands finished and pristine",
        machinery="none", materials="finished facade, glazing, mature planting",
    ),
]

INTERIOR_STAGES: list[StageTemplate] = [
    StageTemplate(
        key="strip_out", name="Strip-out", progress=0.00,
        description="The existing interior is removed back to structure.",
        activity="old finishes stripped out, debris carried away",
        machinery="hand tools and waste bins", materials="exposed structure, dust sheeting",
    ),
    StageTemplate(
        key="framing", name="Framing and partitions", progress=0.20,
        description="Stud partitions and ceiling framing are erected.",
        activity="stud walls framed, ceiling grid set out",
        machinery="nail guns and laser levels", materials="timber or metal studs, joists",
    ),
    StageTemplate(
        key="services", name="Services rough-in", progress=0.38,
        description="Electrical, plumbing and ventilation are run through the frame.",
        activity="cables pulled, pipework run, ducts fitted between studs",
        machinery="hand tools", materials="conduit, copper and plastic pipe, ductwork",
    ),
    StageTemplate(
        key="boarding", name="Boarding and plastering", progress=0.55,
        description="Walls and ceilings are boarded, taped and skimmed.",
        activity="plasterboard fixed, joints taped, surfaces skimmed smooth",
        machinery="board lifts and sanders", materials="plasterboard, jointing compound, plaster",
    ),
    StageTemplate(
        key="flooring", name="Flooring", progress=0.68,
        description="Floor finishes are laid across the space.",
        activity="floor finish laid plank by plank and trimmed in",
        machinery="flooring saws", materials="engineered timber, tile, underlay",
    ),
    StageTemplate(
        key="joinery", name="Cabinetry and joinery", progress=0.80,
        description="Fitted furniture, cabinetry and worktops are installed.",
        activity="cabinet carcasses set and levelled, worktops fitted",
        machinery="hand tools", materials="cabinetry, stone worktops, hardware",
    ),
    StageTemplate(
        key="decoration", name="Decoration", progress=0.90,
        description="Paint, tiling and trim complete the surfaces.",
        activity="walls painted, splashbacks tiled, trim fixed",
        machinery="spray equipment", materials="paint, tile, timber trim",
    ),
    StageTemplate(
        key="fit_out", name="Fixtures and styling", progress=1.00,
        description="Lighting, appliances and furnishings finish the room.",
        activity="no construction activity; the finished room is lit and styled",
        machinery="none", materials="light fittings, appliances, furniture",
    ),
]

ROAD_STAGES: list[StageTemplate] = [
    StageTemplate(
        key="clearing", name="Site clearing", progress=0.00,
        description="The corridor is cleared and set out.", activity="vegetation cleared, the alignment set out",
        machinery="bulldozers", materials="bare ground, marker stakes",
    ),
    StageTemplate(
        key="earthworks", name="Earthworks", progress=0.20,
        description="Cut and fill bring the corridor to level.",
        activity="earth cut, moved and filled to grade", machinery="excavators, graders and dump trucks",
        materials="subsoil, fill material",
    ),
    StageTemplate(
        key="subbase", name="Sub-base", progress=0.42,
        description="Granular sub-base is spread and compacted.",
        activity="crushed stone spread and rolled to a dense mat",
        machinery="graders and vibrating rollers", materials="crushed stone, geotextile",
    ),
    StageTemplate(
        key="binder", name="Binder course", progress=0.62,
        description="The structural asphalt layer is paved.",
        activity="hot asphalt laid by the paver and rolled behind it",
        machinery="an asphalt paver and rollers", materials="hot bitumen macadam",
    ),
    StageTemplate(
        key="surface", name="Surface course", progress=0.80,
        description="The wearing course is laid to final level.",
        activity="the wearing course paved in a continuous ribbon",
        machinery="an asphalt paver", materials="fine asphalt",
    ),
    StageTemplate(
        key="markings", name="Markings and furniture", progress=0.92,
        description="Line markings, signs and barriers are installed.",
        activity="line marking machines painting, signs and barriers erected",
        machinery="line marking rigs", materials="thermoplastic paint, signage, barriers",
    ),
    StageTemplate(
        key="open", name="Completed road", progress=1.00,
        description="The finished road, clean and open.",
        activity="no construction activity; traffic flows on the finished road",
        machinery="none", materials="finished asphalt, markings, planting",
    ),
]

BRIDGE_STAGES: list[StageTemplate] = [
    StageTemplate(
        key="site", name="Site preparation", progress=0.00,
        description="Access, cofferdams and working platforms are established.",
        activity="access roads and working platforms built", machinery="excavators and cranes",
        materials="bare ground, sheet piling",
    ),
    StageTemplate(
        key="piers", name="Piles and piers", progress=0.22,
        description="Piles are driven and pier bases cast.", activity="piles driven, pile caps poured",
        machinery="piling rigs and concrete pumps", materials="steel piles, rebar, concrete",
    ),
    StageTemplate(
        key="columns", name="Piers and abutments", progress=0.42,
        description="Piers rise and abutments are formed.",
        activity="pier columns climbing in successive formwork lifts",
        machinery="tower cranes and climbing formwork", materials="reinforced concrete",
    ),
    StageTemplate(
        key="girders", name="Girders", progress=0.62,
        description="Main girders are lifted into place across the spans.",
        activity="girders lifted and landed span by span",
        machinery="crawler cranes and launching gantries", materials="steel or precast concrete girders",
    ),
    StageTemplate(
        key="deck", name="Deck", progress=0.78,
        description="The deck slab is formed and poured.", activity="deck formwork set, reinforcement laid, concrete poured",
        machinery="concrete pumps", materials="rebar, concrete",
    ),
    StageTemplate(
        key="surfacing", name="Surfacing and parapets", progress=0.90,
        description="Waterproofing, surfacing and parapets complete the deck.",
        activity="waterproofing and asphalt laid, parapets and railings fixed",
        machinery="pavers", materials="waterproof membrane, asphalt, steel railings",
    ),
    StageTemplate(
        key="complete", name="Completed bridge", progress=1.00,
        description="The finished bridge in use.", activity="no construction activity; the finished bridge carries traffic",
        machinery="none", materials="finished deck, railings, lighting",
    ),
]

CATALOGUES: dict[str, list[StageTemplate]] = {
    "building": BUILDING_STAGES,
    "house": BUILDING_STAGES,
    "apartment": BUILDING_STAGES,
    "commercial building": BUILDING_STAGES,
    "industrial building": BUILDING_STAGES,
    "other": BUILDING_STAGES,
    "interior renovation": INTERIOR_STAGES,
    "road": ROAD_STAGES,
    "bridge": BRIDGE_STAGES,
}

#: Wan2.1 FLF2V generates 81 frames per call at 16 fps, a little over 5 seconds.
#: Longer targets are built from several chained segments.
SEGMENTS_FOR_DURATION: dict[int, int] = {5: 1, 10: 2, 15: 3}


class PlannedStage(BaseModel):
    """One stage as it appears in the emitted plan."""

    key: str
    name: str
    description: str
    prompt: str = ""
    progress: float


class SegmentPlan(BaseModel):
    """One Wan2.1 generation covering a contiguous run of stages."""

    index: int
    stages: list[PlannedStage]
    prompt: str = ""
    negative_prompt: str = ""

    @property
    def label(self) -> str:
        return " -> ".join(stage.name for stage in self.stages)


class ConstructionPlan(BaseModel):
    """The full plan handed to the prompt engine and then to Wan."""

    construction_type: str
    camera: dict[str, object]
    stages: list[PlannedStage]
    segments: list[SegmentPlan]
    warnings: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)

    @field_validator("stages")
    @classmethod
    def _non_empty(cls, value: list[PlannedStage]) -> list[PlannedStage]:
        if not value:
            raise ValueError("A construction plan needs at least one stage.")
        return value

    def timeline_markdown(self) -> str:
        """Render the plan as a table for the UI."""
        rows = ["| # | Stage | What happens |", "| --- | --- | --- |"]
        for index, stage in enumerate(self.stages, 1):
            rows.append(f"| {index} | **{stage.name}** | {stage.description} |")
        return "\n".join(rows)


def _catalogue(construction_type: str) -> list[StageTemplate]:
    return CATALOGUES.get(construction_type.lower(), BUILDING_STAGES)


def _nearest_index(catalogue: list[StageTemplate], progress: float) -> int:
    return min(range(len(catalogue)), key=lambda i: abs(catalogue[i].progress - progress))


def _distribute(count: int, buckets: int) -> list[int]:
    """Split `count` items into `buckets` as evenly as possible, front-loaded."""
    base, extra = divmod(count, buckets)
    return [base + (1 if i < extra else 0) for i in range(buckets)]


def plan_construction(
    before_analysis: ImageAnalysis,
    after_analysis: ImageAnalysis,
    comparison: ConstructionComparison,
    construction_type: str = "building",
    duration_seconds: int = 5,
    camera_mode: CameraMode = "locked",
    start_stage_override: str | None = None,
) -> ConstructionPlan:
    """Build the stage plan between the two uploaded states.

    Args:
        before_analysis: Measurements from the BEFORE still.
        after_analysis: Measurements from the AFTER still, the target state.
        comparison: Stage and camera verdicts from the detector.
        construction_type: Selects the stage catalogue.
        duration_seconds: 5, 10 or 15; decides how many segments are generated.
        camera_mode: Locked or slight cinematic movement.
        start_stage_override: Catalogue key to start from, overriding detection.

    Returns:
        A plan whose stages run from the detected starting state to completion.
    """
    catalogue = _catalogue(construction_type)
    warnings = list(comparison.warnings)
    notes: list[str] = []

    if start_stage_override:
        keys = [template.key for template in catalogue]
        if start_stage_override not in keys:
            raise ValueError(
                f"Unknown start stage {start_stage_override!r} for {construction_type}. "
                f"Valid keys: {', '.join(keys)}"
            )
        start = keys.index(start_stage_override)
        notes.append(f"Starting stage overridden by the user: {catalogue[start].name}.")
    else:
        start = _nearest_index(catalogue, before_analysis.construction_progress)
        if before_analysis.progress_confidence < 0.35:
            warnings.append(
                f"Starting stage was detected with low confidence "
                f"({before_analysis.progress_confidence:.2f}); it was read as "
                f"'{catalogue[start].name}'. Override it in Advanced settings if that is wrong."
            )

    # The AFTER image is the target final state by definition, so the plan always
    # runs to the end of the catalogue regardless of what the detector scored it.
    end = len(catalogue) - 1
    if start >= end:
        start = max(0, end - 1)
        notes.append(
            "The BEFORE image already reads as complete; starting one stage back "
            "so there is a visible transformation to generate."
        )

    span = catalogue[start : end + 1]
    segment_count = SEGMENTS_FOR_DURATION.get(duration_seconds, 1)
    if len(span) < segment_count:
        segment_count = max(1, len(span) - 1) or 1
        notes.append(
            f"Only {len(span)} stages separate the two images, so the video is built "
            f"from {segment_count} segment(s)."
        )

    planned = [
        PlannedStage(
            key=template.key,
            name=template.name,
            description=template.description,
            progress=template.progress,
        )
        for template in span
    ]

    # Segments share their boundary stage, so consecutive clips join without a jump.
    boundaries = _distribute(len(planned) - 1, segment_count)
    segments: list[SegmentPlan] = []
    cursor = 0
    for index, width in enumerate(boundaries):
        chunk = planned[cursor : cursor + width + 1]
        if len(chunk) < 2:
            chunk = planned[cursor : cursor + 2] or planned[-2:]
        segments.append(SegmentPlan(index=index, stages=chunk))
        cursor += width

    plan = ConstructionPlan(
        construction_type=construction_type,
        camera={
            "locked": camera_mode == "locked",
            "perspective": before_analysis.perspective,
            "angle": before_analysis.camera_angle,
            "similarity": round(comparison.camera.similarity, 3),
            "verdict": comparison.camera.verdict,
        },
        stages=planned,
        segments=segments,
        warnings=warnings,
        notes=notes,
    )
    logger.info(
        "Planned %d stages across %d segment(s): %s",
        len(planned), len(segments), " -> ".join(s.key for s in planned),
    )
    return plan
