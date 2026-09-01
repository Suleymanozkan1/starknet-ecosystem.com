"""Encoding options, filter construction and export."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from src.utils.gpu_utils import check_ffmpeg
from src.video.exporter import export_video, join_segments
from src.video.postprocess import EncodeOptions, PostProcessError, _build_filters, write_frames

FFMPEG = check_ffmpeg()


def _frames(count: int, size=(96, 64)) -> list[Image.Image]:
    return [
        Image.new("RGB", size, (index * 7 % 255, 90, 160)) for index in range(count)
    ]


class TestEncodeOptions:
    def test_defaults_are_valid(self) -> None:
        assert EncodeOptions().fps == 24

    @pytest.mark.parametrize("fps", [12, 25, 60])
    def test_rejects_unsupported_fps(self, fps: int) -> None:
        with pytest.raises(ValueError, match="fps must be"):
            EncodeOptions(fps=fps)

    @pytest.mark.parametrize("speed", [3, 5, 32, 0])
    def test_rejects_unsupported_speed(self, speed: int) -> None:
        with pytest.raises(ValueError, match="speed must be"):
            EncodeOptions(speed=speed)

    def test_rejects_out_of_range_crf(self) -> None:
        with pytest.raises(ValueError, match="crf"):
            EncodeOptions(crf=99)

    @pytest.mark.parametrize("speed", [1, 2, 4, 8, 16])
    def test_accepts_every_documented_speed(self, speed: int) -> None:
        assert EncodeOptions(speed=speed).speed == speed


class TestFilters:
    def test_speed_one_adds_no_setpts(self) -> None:
        assert "setpts" not in _build_filters(EncodeOptions(speed=1), 16)

    def test_speed_scales_presentation_timestamps(self) -> None:
        assert "setpts=PTS/4" in _build_filters(EncodeOptions(speed=4), 16)

    def test_interpolation_replaces_the_plain_fps_filter(self) -> None:
        chain = _build_filters(EncodeOptions(interpolate=True, fps=30), 16)
        assert "minterpolate=fps=30" in chain
        assert ",fps=30" not in chain

    def test_motion_blur_uses_tmix(self) -> None:
        assert "tmix" in _build_filters(EncodeOptions(motion_blur=True), 16)

    def test_scaling_is_emitted_when_requested(self) -> None:
        chain = _build_filters(EncodeOptions(width=480, height=832), 16)
        assert "scale=480:832" in chain and "crop=480:832" in chain

    def test_even_dimension_padding_is_always_last(self) -> None:
        assert _build_filters(EncodeOptions(), 16).split(",")[-1].startswith("pad=")

    def test_setpts_precedes_fps(self) -> None:
        chain = _build_filters(EncodeOptions(speed=2), 16).split(",")
        assert chain.index("setpts=PTS/2") < next(
            index for index, part in enumerate(chain) if part.startswith("fps=")
        )


class TestWriteFrames:
    def test_writes_zero_padded_files(self, tmp_path: Path) -> None:
        directory = write_frames(_frames(3), tmp_path / "f")
        assert sorted(p.name for p in directory.glob("*.png")) == [
            "frame_00000.png", "frame_00001.png", "frame_00002.png",
        ]

    def test_clears_stale_frames_first(self, tmp_path: Path) -> None:
        directory = tmp_path / "f"
        write_frames(_frames(5), directory)
        write_frames(_frames(2), directory)
        assert len(list(directory.glob("frame_*.png"))) == 2

    def test_empty_list_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(PostProcessError, match="No frames"):
            write_frames([], tmp_path / "f")


class TestJoinSegments:
    def test_drops_shared_boundary_frames(self) -> None:
        first, second = _frames(5), _frames(5)
        assert len(join_segments([first, second])) == 9

    def test_single_segment_is_unchanged(self) -> None:
        assert len(join_segments([_frames(7)])) == 7

    def test_empty_input(self) -> None:
        assert join_segments([]) == []

    def test_three_segments(self) -> None:
        assert len(join_segments([_frames(5)] * 3)) == 13


class TestExport:
    def test_produces_a_playable_file(self, tmp_path: Path) -> None:
        result = export_video(_frames(24), tmp_path, EncodeOptions(fps=24), ffmpeg=FFMPEG)
        assert result.path.exists() and result.size_mb > 0
        assert result.frame_count == 24
        assert result.duration_seconds > 0
        assert "24 fps" in result.summary()

    def test_speed_shortens_the_result(self, tmp_path: Path) -> None:
        slow = export_video(_frames(32), tmp_path, EncodeOptions(speed=1), ffmpeg=FFMPEG)
        fast = export_video(_frames(32), tmp_path, EncodeOptions(speed=4), ffmpeg=FFMPEG)
        assert fast.duration_seconds < slow.duration_seconds

    def test_target_size_is_honoured(self, tmp_path: Path) -> None:
        result = export_video(
            _frames(12), tmp_path, EncodeOptions(width=480, height=832), ffmpeg=FFMPEG
        )
        assert result.path.exists()

    def test_odd_dimensions_are_padded(self, tmp_path: Path) -> None:
        odd = [Image.new("RGB", (65, 33), "navy") for _ in range(8)]
        assert export_video(odd, tmp_path, EncodeOptions(), ffmpeg=FFMPEG).path.exists()

    def test_empty_frames_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(PostProcessError, match="empty"):
            export_video([], tmp_path, EncodeOptions(), ffmpeg=FFMPEG)

    def test_intermediate_frames_are_cleaned_up(self, tmp_path: Path) -> None:
        export_video(_frames(8), tmp_path, EncodeOptions(), ffmpeg=FFMPEG)
        assert not list(tmp_path.glob(".frames-*"))
