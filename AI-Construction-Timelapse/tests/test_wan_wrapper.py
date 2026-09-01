"""The Wan2.1 wrapper: frame maths, checkpoint validation, mock mode."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from src.models.wan_flf2v import (
    NATIVE_FPS,
    WanFLF2VGenerator,
    WanGenerationError,
    WanModelNotFoundError,
    _tensor_to_frames,
    normalise_frame_count,
)


class TestFrameCount:
    @pytest.mark.parametrize("requested,expected", [(81, 81), (80, 81), (82, 81), (5, 5), (1, 5)])
    def test_rounds_to_4n_plus_1(self, requested: int, expected: int) -> None:
        assert normalise_frame_count(requested) == expected

    @pytest.mark.parametrize("value", range(5, 130))
    def test_result_is_always_valid(self, value: int) -> None:
        result = normalise_frame_count(value)
        assert (result - 1) % 4 == 0 and result >= 5


class TestCheckpointValidation:
    def test_missing_directory_explains_the_download(self, tmp_path: Path) -> None:
        generator = WanFLF2VGenerator(tmp_path / "absent")
        with pytest.raises(WanModelNotFoundError, match="hf download"):
            generator.load()

    def test_file_instead_of_directory(self, tmp_path: Path) -> None:
        path = tmp_path / "model"
        path.write_text("not a checkpoint")
        with pytest.raises(WanModelNotFoundError, match="must be a directory"):
            WanFLF2VGenerator(path).load()

    def test_partial_checkpoint_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "Wan2.1-FLF2V-14B-720P"
        path.mkdir()
        (path / "models_t5_umt5-xxl-enc-bf16.pth").write_bytes(b"x")
        with pytest.raises(WanModelNotFoundError, match="does not look like a complete"):
            WanFLF2VGenerator(path).load()

    def test_mock_mode_skips_validation(self, tmp_path: Path) -> None:
        WanFLF2VGenerator(tmp_path / "absent", mock=True).load()


class TestTensorConversion:
    def test_converts_channel_first_tensor(self) -> None:
        tensor = torch.zeros(3, 9, 16, 24)
        frames = _tensor_to_frames(tensor)
        assert len(frames) == 9
        assert frames[0].size == (24, 16)
        assert frames[0].mode == "RGB"

    def test_maps_minus_one_to_black_and_one_to_white(self) -> None:
        black = _tensor_to_frames(torch.full((3, 1, 4, 4), -1.0))[0]
        white = _tensor_to_frames(torch.full((3, 1, 4, 4), 1.0))[0]
        assert np.asarray(black).max() == 0
        assert np.asarray(white).min() == 255

    def test_values_outside_the_range_are_clipped(self) -> None:
        frame = _tensor_to_frames(torch.full((3, 1, 4, 4), 5.0))[0]
        assert np.asarray(frame).max() == 255

    def test_wrong_rank_is_rejected(self) -> None:
        with pytest.raises(WanGenerationError, match="4D"):
            _tensor_to_frames(torch.zeros(3, 16, 16))


class TestMockGeneration:
    def test_produces_the_requested_frame_count(self, site_image, finished_image) -> None:
        generator = WanFLF2VGenerator(Path("/nonexistent"), mock=True)
        result = generator.generate(site_image, finished_image, "prompt", frame_count=21)
        assert result.frame_count == 21
        assert result.mocked is True
        assert result.fps == NATIVE_FPS

    def test_first_and_last_frames_track_the_inputs(self, site_image, finished_image) -> None:
        generator = WanFLF2VGenerator(Path("/nonexistent"), mock=True)
        frames = generator.generate(site_image, finished_image, "p", frame_count=9).frames
        # The banner overwrites the top of every frame, so compare below it.
        band = frames[0].height // 6
        first = np.asarray(frames[0])[band:].astype(float)
        last = np.asarray(frames[-1])[band:].astype(float)
        start = np.asarray(site_image)[band:].astype(float)
        end = np.asarray(finished_image)[band:].astype(float)
        assert np.abs(first - start).mean() < np.abs(first - end).mean()
        assert np.abs(last - end).mean() < np.abs(last - start).mean()

    def test_frames_are_labelled_as_mock(self, site_image, finished_image) -> None:
        generator = WanFLF2VGenerator(Path("/nonexistent"), mock=True)
        frame = generator.generate(site_image, finished_image, "p", frame_count=5).frames[0]
        # The banner is a dark strip across the top; the source image is not.
        top = np.asarray(frame)[:4].mean()
        assert top < np.asarray(site_image)[:4].mean()

    def test_handles_mismatched_input_sizes(self, site_image, finished_image) -> None:
        generator = WanFLF2VGenerator(Path("/nonexistent"), mock=True)
        smaller = finished_image.resize((320, 180))
        result = generator.generate(site_image, smaller, "p", frame_count=5)
        assert result.frames[0].size == site_image.size

    def test_unload_is_safe_when_nothing_is_loaded(self) -> None:
        WanFLF2VGenerator(Path("/nonexistent"), mock=True).unload()
