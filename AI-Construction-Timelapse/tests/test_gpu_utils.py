"""GPU detection, VRAM budgeting and ffmpeg discovery."""

from __future__ import annotations

import builtins

import pytest

from src.utils import gpu_utils
from src.utils.gpu_utils import GpuInfo


class TestDetectGpu:
    def test_never_raises_on_this_host(self) -> None:
        info = gpu_utils.detect_gpu()
        assert isinstance(info, GpuInfo)
        assert isinstance(info.summary(), str)

    def test_reports_missing_torch_rather_than_crashing(self, monkeypatch) -> None:
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "torch":
                raise ImportError("no torch here")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        info = gpu_utils.detect_gpu()
        assert not info.available
        assert "PyTorch is not installed" in info.reason

    def test_summary_explains_absence(self) -> None:
        info = GpuInfo(available=False, reason="driver missing")
        assert "No CUDA GPU available" in info.summary()
        assert "driver missing" in info.summary()

    def test_summary_describes_a_present_card(self) -> None:
        info = GpuInfo(
            available=True, device_count=1, name="NVIDIA H100",
            total_vram_gb=80.0, free_vram_gb=79.0, cuda_version="12.4",
        )
        assert "H100" in info.summary() and "80.0 GB" in info.summary()


class TestVramBudget:
    def test_offloading_lowers_the_requirement(self) -> None:
        assert gpu_utils.required_vram_gb("720p", True) < gpu_utils.required_vram_gb("720p", False)

    def test_480p_is_cheaper_than_720p(self) -> None:
        assert gpu_utils.required_vram_gb("480p", True) < gpu_utils.required_vram_gb("720p", True)

    def test_unknown_resolution_falls_back_to_the_worst_case(self) -> None:
        assert gpu_utils.required_vram_gb("4k", True) == 60.0

    def test_no_gpu_is_a_blocking_problem(self) -> None:
        problems = gpu_utils.check_vram("720p", True, GpuInfo(available=False, reason="none"))
        assert len(problems) == 1
        assert "MOCK_MODE" in problems[0]

    def test_small_card_is_rejected(self) -> None:
        info = GpuInfo(available=True, name="RTX 4090", total_vram_gb=24.0, free_vram_gb=23.0)
        problems = gpu_utils.check_vram("720p", False, info)
        assert problems and "24.0 GB" in problems[0]

    def test_large_card_passes(self) -> None:
        info = GpuInfo(available=True, name="H100", total_vram_gb=80.0, free_vram_gb=78.0)
        assert gpu_utils.check_vram("720p", True, info) == []

    def test_busy_card_is_reported_separately(self) -> None:
        info = GpuInfo(available=True, name="A100", total_vram_gb=80.0, free_vram_gb=4.0)
        problems = gpu_utils.check_vram("720p", True, info)
        assert problems and "free right now" in problems[0]


class TestFfmpeg:
    def test_finds_an_ffmpeg(self) -> None:
        assert gpu_utils.check_ffmpeg()

    def test_bad_explicit_path_is_rejected(self) -> None:
        with pytest.raises(RuntimeError, match="not executable"):
            gpu_utils.check_ffmpeg("/definitely/not/ffmpeg")


def test_describe_environment_has_the_expected_keys() -> None:
    environment = gpu_utils.describe_environment()
    assert {"gpu", "gpu_available", "torch", "ffmpeg"} <= set(environment)
