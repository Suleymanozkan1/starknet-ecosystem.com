"""Settings, size mapping and logging configuration."""

from __future__ import annotations

import pytest

from src.utils.config import EXPORT_SIZES, WAN_SIZES, Settings, configure_logging


class TestSettings:
    def test_defaults_are_usable(self) -> None:
        settings = Settings()
        assert settings.wan_task == "flf2v-14B"
        assert settings.mock_mode is False
        assert settings.final_frame_ssim_threshold == pytest.approx(0.70)

    def test_env_overrides(self, monkeypatch) -> None:
        monkeypatch.setenv("MOCK_MODE", "true")
        monkeypatch.setenv("SERVER_PORT", "9001")
        settings = Settings()
        assert settings.mock_mode is True
        assert settings.server_port == 9001

    def test_rejects_bad_log_level(self, monkeypatch) -> None:
        monkeypatch.setenv("LOG_LEVEL", "CHATTY")
        with pytest.raises(ValueError, match="logging level"):
            Settings()

    def test_rejects_out_of_range_port(self, monkeypatch) -> None:
        monkeypatch.setenv("SERVER_PORT", "70000")
        with pytest.raises(ValueError):
            Settings()

    def test_directories_are_created(self, tmp_path) -> None:
        settings = Settings(input_dir=tmp_path / "in", output_dir=tmp_path / "out")
        settings.ensure_directories()
        assert settings.input_dir.is_dir() and settings.output_dir.is_dir()


class TestSizeMapping:
    @pytest.mark.parametrize("aspect", ["16:9", "9:16", "1:1"])
    @pytest.mark.parametrize("resolution", ["480p", "720p"])
    def test_every_combination_is_mapped(self, aspect: str, resolution: str) -> None:
        settings = Settings()
        assert settings.wan_size(aspect, resolution)
        width, height = settings.export_size(aspect, resolution)
        assert width % 2 == 0 and height % 2 == 0

    def test_sizes_are_ones_wan_accepts(self) -> None:
        # Mirrors SUPPORTED_SIZES['flf2v-14B'] in the official Wan2.1 repository.
        supported = {"720*1280", "1280*720", "480*832", "832*480"}
        assert set(WAN_SIZES.values()) <= supported

    def test_export_and_wan_tables_agree_on_keys(self) -> None:
        assert set(WAN_SIZES) == set(EXPORT_SIZES)

    def test_unknown_pair_raises(self) -> None:
        with pytest.raises(ValueError, match="Unsupported"):
            Settings().wan_size("21:9", "720p")

    def test_480p_uses_the_recommended_shift(self) -> None:
        settings = Settings()
        assert settings.shift_for("480p") == pytest.approx(3.0)
        assert settings.shift_for("720p") > settings.shift_for("480p")


def test_configure_logging_accepts_a_level() -> None:
    configure_logging("DEBUG")
