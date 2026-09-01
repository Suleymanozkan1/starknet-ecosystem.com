"""End-to-end pipeline behaviour, exercised entirely in mock mode."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.pipeline import GenerationRequest, PipelineError, TimelapsePipeline
from src.utils.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        mock_mode=True,
        input_dir=tmp_path / "inputs",
        output_dir=tmp_path / "outputs",
        wan_model_path=tmp_path / "no-model",
    )


@pytest.fixture
def request_factory(site_path: Path, finished_path: Path):
    def make(**overrides) -> GenerationRequest:
        base = dict(
            before_path=site_path,
            after_path=finished_path,
            aspect="16:9",
            duration=5,
            construction_type="apartment",
            resolution="480p",
            start_stage="empty_site",
        )
        base.update(overrides)
        return GenerationRequest(**base)

    return make


class TestMockRun:
    def test_completes_and_writes_a_video(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(request_factory())
        assert result.succeeded
        assert result.video_path.exists()
        assert result.mocked is True

    def test_reports_all_six_steps(self, settings, request_factory) -> None:
        steps: list[str] = []
        TimelapsePipeline(settings).run(request_factory(), progress=steps.append)
        numbered = [line for line in steps if line.startswith("[")]
        assert [line[:5] for line in numbered] == [f"[{i}/6]" for i in range(1, 7)]

    def test_log_records_the_generation_parameters(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(request_factory(seed=1234))
        joined = "\n".join(result.log)
        for token in ("model=flf2v-14B", "size=", "frames=81", "seed=1234", "GPU:", "ffmpeg:"):
            assert token in joined

    def test_final_frame_is_verified_against_after(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(request_factory())
        assert result.similarity is not None
        assert result.similarity.ssim > 0.7
        assert any("Final frame" in line for line in result.log)

    @pytest.mark.parametrize("duration,segments", [(5, 1), (10, 2), (15, 3)])
    def test_duration_drives_segment_count(
        self, settings, request_factory, duration: int, segments: int
    ) -> None:
        result = TimelapsePipeline(settings).run(request_factory(duration=duration))
        assert len(result.plan.segments) == segments
        assert result.export.frame_count == 81 + (segments - 1) * 80

    @pytest.mark.parametrize("aspect", ["16:9", "9:16", "1:1"])
    def test_every_aspect_ratio(self, settings, request_factory, aspect: str) -> None:
        result = TimelapsePipeline(settings).run(request_factory(aspect=aspect))
        assert result.video_path.exists()

    @pytest.mark.parametrize("speed", [1, 2, 4, 8, 16])
    def test_timelapse_speed_multipliers(self, settings, request_factory, speed: int) -> None:
        result = TimelapsePipeline(settings).run(request_factory(timelapse_speed=speed))
        assert result.export.duration_seconds > 0

    def test_faster_speed_yields_a_shorter_file(self, settings, request_factory) -> None:
        slow = TimelapsePipeline(settings).run(request_factory(timelapse_speed=1))
        fast = TimelapsePipeline(settings).run(request_factory(timelapse_speed=8))
        assert fast.export.duration_seconds < slow.export.duration_seconds

    def test_interpolation_and_motion_blur(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(
            request_factory(interpolate=True, motion_blur=True, output_fps=30)
        )
        assert result.export.fps == 30

    def test_construction_type_selects_the_catalogue(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(
            request_factory(construction_type="road", start_stage="clearing")
        )
        assert [stage.key for stage in result.plan.stages][0] == "clearing"

    def test_plan_and_analyses_are_returned(self, settings, request_factory) -> None:
        result = TimelapsePipeline(settings).run(request_factory())
        assert result.plan is not None
        assert result.before_analysis is not None and result.after_analysis is not None
        assert result.plan.timeline_markdown().startswith("|")

    def test_elapsed_time_is_recorded(self, settings, request_factory) -> None:
        assert TimelapsePipeline(settings).run(request_factory()).elapsed_seconds > 0


class TestValidationErrors:
    def test_missing_input_is_reported_clearly(self, settings, request_factory, tmp_path) -> None:
        with pytest.raises(PipelineError, match="No such file"):
            TimelapsePipeline(settings).run(request_factory(before_path=tmp_path / "gone.jpg"))

    def test_corrupted_input_is_reported(self, settings, request_factory, tmp_path) -> None:
        broken = tmp_path / "broken.png"
        broken.write_bytes(b"\x89PNG\r\n\x1a\n" + b"junk" * 50)
        with pytest.raises(PipelineError, match="not a readable image"):
            TimelapsePipeline(settings).run(request_factory(after_path=broken))

    def test_unknown_start_stage_is_reported(self, settings, request_factory) -> None:
        with pytest.raises(ValueError, match="Unknown start stage"):
            TimelapsePipeline(settings).run(request_factory(start_stage="not_a_stage"))


class TestPreflight:
    def test_mock_mode_needs_no_gpu(self, settings, request_factory) -> None:
        assert TimelapsePipeline(settings).preflight(request_factory()) == []

    def test_real_mode_reports_the_missing_gpu(self, settings, request_factory) -> None:
        settings.mock_mode = False
        problems = TimelapsePipeline(settings).preflight(request_factory())
        assert problems and any("GPU" in problem for problem in problems)

    def test_real_mode_without_a_gpu_stops_before_generating(
        self, settings, request_factory
    ) -> None:
        settings.mock_mode = False
        with pytest.raises(PipelineError, match="GPU"):
            TimelapsePipeline(settings).run(request_factory())


class TestSwitchingOutOfMockMode:
    def test_only_configuration_separates_mock_from_real(self, settings, request_factory) -> None:
        """The switch to real Wan2.1 must be a config change, not a code change."""
        pipeline = TimelapsePipeline(settings)
        assert pipeline._get_generator().mock is True

        settings.mock_mode = False
        real = TimelapsePipeline(settings)
        generator = real._get_generator()
        assert generator.mock is False
        assert generator.checkpoint_dir == settings.wan_model_path
        assert generator.task == "flf2v-14B"
