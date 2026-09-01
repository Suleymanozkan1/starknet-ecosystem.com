"""Stage planning and prompt construction."""

from __future__ import annotations

import pytest

from src.analysis.construction_detector import compare_construction
from src.analysis.image_analyzer import analyze_image
from src.planning.prompt_engine import (
    GEOMETRY_LOCK,
    NEGATIVE_PROMPT_TERMS,
    annotate_plan,
    build_negative_prompt,
)
from src.planning.stage_planner import (
    CATALOGUES,
    CONSTRUCTION_TYPES,
    SEGMENTS_FOR_DURATION,
    plan_construction,
)


@pytest.fixture
def inputs(site_image, finished_image):
    before = analyze_image(site_image)
    after = analyze_image(finished_image)
    comparison = compare_construction(site_image, finished_image, before, after)
    return before, after, comparison


class TestCatalogues:
    def test_every_construction_type_resolves(self) -> None:
        for name in CONSTRUCTION_TYPES:
            assert CATALOGUES.get(name, CATALOGUES["building"])

    def test_stage_progress_is_monotonic(self) -> None:
        for catalogue in CATALOGUES.values():
            values = [template.progress for template in catalogue]
            assert values == sorted(values)
            assert values[0] == 0.0 and values[-1] == 1.0

    def test_stage_keys_are_unique(self) -> None:
        for catalogue in CATALOGUES.values():
            keys = [template.key for template in catalogue]
            assert len(keys) == len(set(keys))

    def test_road_and_building_differ(self) -> None:
        building = {t.key for t in CATALOGUES["building"]}
        road = {t.key for t in CATALOGUES["road"]}
        assert not building & road


class TestPlanner:
    def test_plan_runs_to_completion(self, inputs) -> None:
        plan = plan_construction(*inputs, construction_type="apartment", duration_seconds=5)
        assert plan.stages[-1].progress == 1.0

    @pytest.mark.parametrize("duration,expected", sorted(SEGMENTS_FOR_DURATION.items()))
    def test_duration_sets_segment_count(self, inputs, duration: int, expected: int) -> None:
        plan = plan_construction(
            *inputs, construction_type="apartment", duration_seconds=duration,
            start_stage_override="empty_site",
        )
        assert len(plan.segments) == expected

    def test_segments_share_boundary_stages(self, inputs) -> None:
        plan = plan_construction(
            *inputs, construction_type="apartment", duration_seconds=15,
            start_stage_override="empty_site",
        )
        for first, second in zip(plan.segments, plan.segments[1:]):
            assert first.stages[-1].key == second.stages[0].key

    def test_segments_cover_every_stage(self, inputs) -> None:
        plan = plan_construction(
            *inputs, construction_type="apartment", duration_seconds=15,
            start_stage_override="empty_site",
        )
        covered = {stage.key for segment in plan.segments for stage in segment.stages}
        assert covered == {stage.key for stage in plan.stages}

    def test_every_segment_has_at_least_two_stages(self, inputs) -> None:
        plan = plan_construction(
            *inputs, construction_type="building", duration_seconds=15,
            start_stage_override="empty_site",
        )
        assert all(len(segment.stages) >= 2 for segment in plan.segments)

    def test_start_override_skips_earlier_stages(self, inputs) -> None:
        plan = plan_construction(
            *inputs, construction_type="apartment", duration_seconds=5,
            start_stage_override="roof",
        )
        keys = [stage.key for stage in plan.stages]
        assert keys[0] == "roof"
        assert "excavation" not in keys

    def test_unknown_override_is_rejected(self, inputs) -> None:
        with pytest.raises(ValueError, match="Unknown start stage"):
            plan_construction(*inputs, construction_type="road", start_stage_override="roof")

    def test_interior_uses_the_interior_catalogue(self, inputs) -> None:
        plan = plan_construction(*inputs, construction_type="interior renovation")
        assert {stage.key for stage in plan.stages} <= {t.key for t in CATALOGUES["interior renovation"]}

    def test_low_confidence_produces_a_warning(self, inputs, noise_image) -> None:
        before, after, comparison = inputs
        before.progress_confidence = 0.1
        plan = plan_construction(before, after, comparison, construction_type="building")
        assert any("low confidence" in warning for warning in plan.warnings)

    def test_camera_block_records_the_verdict(self, inputs) -> None:
        plan = plan_construction(*inputs, camera_mode="cinematic")
        assert plan.camera["locked"] is False
        assert plan.camera["verdict"] in {"locked", "align", "mismatched"}

    def test_timeline_renders_every_stage(self, inputs) -> None:
        plan = plan_construction(*inputs, construction_type="bridge")
        table = plan.timeline_markdown()
        assert all(stage.name in table for stage in plan.stages)


class TestPrompts:
    def test_negative_prompt_covers_the_required_failures(self) -> None:
        negative = build_negative_prompt()
        for term in ("distorted building", "camera jump", "melting walls", "temporal inconsistency"):
            assert term in negative

    def test_negative_prompt_accepts_extra_terms(self) -> None:
        assert "purple sky" in build_negative_prompt("purple sky")

    def test_negative_terms_are_unique(self) -> None:
        assert len(NEGATIVE_PROMPT_TERMS) == len(set(NEGATIVE_PROMPT_TERMS))

    def test_every_segment_gets_a_prompt(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(
            plan_construction(*inputs, construction_type="apartment", duration_seconds=15,
                              start_stage_override="empty_site"),
            before,
        )
        assert all(segment.prompt and segment.negative_prompt for segment in plan.segments)
        assert all(stage.prompt for stage in plan.stages)

    def test_prompt_locks_the_geometry(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs), before)
        assert GEOMETRY_LOCK.split(".")[0] in plan.segments[0].prompt

    def test_locked_camera_forbids_movement(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs, camera_mode="locked"), before)
        assert "no pan, tilt, zoom or parallax" in plan.segments[0].prompt

    def test_cinematic_camera_allows_a_push_in(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs, camera_mode="cinematic"), before)
        assert "push-in" in plan.segments[0].prompt

    @pytest.mark.parametrize("speed", ["realistic", "fast", "hyperlapse"])
    def test_speed_changes_the_pacing_clause(self, inputs, speed: str) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs), before, speed=speed)
        assert "time-lapse" in plan.segments[0].prompt or "hyperlapse" in plan.segments[0].prompt

    def test_prompt_names_the_stages_in_order(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(
            plan_construction(*inputs, construction_type="road", start_stage_override="clearing"),
            before,
        )
        prompt = plan.segments[0].prompt
        assert "asphalt" in prompt.lower()

    def test_extra_positive_text_is_appended(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs), before, extra_positive="autumn light")
        assert "autumn light" in plan.segments[0].prompt

    def test_article_agreement(self, inputs) -> None:
        before, _, _ = inputs
        plan = annotate_plan(plan_construction(*inputs, construction_type="apartment"), before)
        assert "an apartment" in plan.segments[0].prompt
        assert "view view" not in plan.segments[0].prompt
