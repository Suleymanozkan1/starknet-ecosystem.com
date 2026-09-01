"""Image analysis and the before/after comparison."""

from __future__ import annotations

from src.analysis.construction_detector import (
    Stage,
    align_images,
    compare_cameras,
    compare_construction,
    detect_stage,
)
from src.analysis.image_analyzer import ImageAnalysis, analyze_image


class TestAnalyzeImage:
    def test_returns_a_populated_analysis(self, finished_image) -> None:
        analysis = analyze_image(finished_image)
        assert isinstance(analysis, ImageAnalysis)
        assert analysis.width == finished_image.width
        assert 0.0 <= analysis.construction_progress <= 1.0
        assert 0.0 <= analysis.horizon_y <= 1.0
        assert len(analysis.summary_lines()) == 6

    def test_serialises_to_plain_data(self, finished_image) -> None:
        data = analyze_image(finished_image).as_dict()
        assert isinstance(data["building"], (dict, type(None)))
        assert isinstance(data["construction_progress"], float)

    def test_empty_site_scores_lower_than_finished(self, site_image, finished_image) -> None:
        empty = analyze_image(site_image)
        built = analyze_image(finished_image)
        assert empty.construction_progress < built.construction_progress

    def test_empty_site_finds_no_building(self, site_image) -> None:
        analysis = analyze_image(site_image)
        assert analysis.building is None or analysis.building_footprint_ratio < 0.1

    def test_finished_building_is_detected(self, finished_image) -> None:
        analysis = analyze_image(finished_image)
        assert analysis.building is not None
        assert analysis.opening_count > 0

    def test_handles_pure_noise_without_crashing(self, noise_image) -> None:
        analysis = analyze_image(noise_image)
        assert 0.0 <= analysis.construction_progress <= 1.0

    def test_ratios_are_fractions(self, finished_image) -> None:
        analysis = analyze_image(finished_image)
        for value in (analysis.sky_ratio, analysis.vegetation_ratio, analysis.ground_ratio):
            assert 0.0 <= value <= 1.0

    def test_low_confidence_carries_a_note(self, noise_image) -> None:
        analysis = analyze_image(noise_image)
        if analysis.progress_confidence < 0.35:
            assert analysis.notes


class TestDetectStage:
    def test_empty_site_maps_to_the_first_stage(self, site_image) -> None:
        assert detect_stage(analyze_image(site_image)) == Stage.EMPTY_SITE

    def test_stages_are_ordered(self) -> None:
        assert Stage.EXCAVATION < Stage.ROOF < Stage.COMPLETED


class TestCameraComparison:
    def test_identical_images_are_locked(self, finished_image) -> None:
        analysis = analyze_image(finished_image)
        result = compare_cameras(finished_image, finished_image, analysis, analysis)
        assert result.verdict == "locked"
        assert result.similarity > 0.9

    def test_unrelated_images_are_mismatched(self, finished_image, noise_image) -> None:
        result = compare_cameras(
            finished_image, noise_image, analyze_image(finished_image), analyze_image(noise_image)
        )
        assert result.is_mismatched
        assert "significantly different camera perspectives" in result.message

    def test_mismatch_surfaces_as_a_warning(self, finished_image, noise_image) -> None:
        comparison = compare_construction(
            finished_image, noise_image, analyze_image(finished_image), analyze_image(noise_image)
        )
        assert any("perspectives" in warning for warning in comparison.warnings)

    def test_regression_is_flagged(self, site_image, finished_image) -> None:
        comparison = compare_construction(
            finished_image, site_image, analyze_image(finished_image), analyze_image(site_image)
        )
        assert comparison.is_regression
        assert any("does not look more complete" in w for w in comparison.warnings)


class TestAlignment:
    def test_identical_images_align_or_decline_cleanly(self, finished_image) -> None:
        aligned, ok, note = align_images(finished_image, finished_image)
        assert aligned.size == finished_image.size
        assert isinstance(ok, bool) and note

    def test_unalignable_pair_returns_the_original(self, finished_image, noise_image) -> None:
        aligned, ok, note = align_images(finished_image, noise_image)
        if not ok:
            assert aligned is noise_image
            assert "skipped" in note.lower()
