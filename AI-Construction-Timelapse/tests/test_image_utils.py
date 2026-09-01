"""Upload validation, filename hardening, aspect handling and similarity."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from src.utils import image_utils
from src.utils.image_utils import ImageValidationError


class TestSafeFilename:
    @pytest.mark.parametrize(
        "raw,forbidden",
        [
            ("../../etc/passwd", ".."),
            ("/absolute/path/x.png", "/"),
            ("..\\..\\windows\\system32\\a.png", "\\"),
            ("nul\x00byte.png", "\x00"),
        ],
    )
    def test_strips_traversal_and_separators(self, raw: str, forbidden: str) -> None:
        assert forbidden not in image_utils.safe_filename(raw)

    def test_keeps_a_usable_name(self) -> None:
        assert image_utils.safe_filename("Site Photo 01.JPG") == "Site_Photo_01.JPG"

    def test_falls_back_when_nothing_survives(self) -> None:
        assert image_utils.safe_filename("///", fallback="upload") == "upload"

    def test_caps_length(self) -> None:
        assert len(image_utils.safe_filename("a" * 400 + ".png")) <= 120


class TestValidation:
    def test_accepts_a_real_image(self, site_path: Path) -> None:
        assert image_utils.validate_image_file(site_path) == site_path

    def test_rejects_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(ImageValidationError, match="No such file"):
            image_utils.validate_image_file(tmp_path / "nope.jpg")

    def test_rejects_wrong_extension(self, tmp_path: Path) -> None:
        path = tmp_path / "payload.exe"
        path.write_bytes(b"MZ\x90\x00")
        with pytest.raises(ImageValidationError, match="unsupported file type"):
            image_utils.validate_image_file(path)

    def test_rejects_corrupted_image(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"garbage" * 40)
        with pytest.raises(ImageValidationError, match="not a readable image"):
            image_utils.validate_image_file(path)

    def test_rejects_empty_file(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.png"
        path.write_bytes(b"")
        with pytest.raises(ImageValidationError):
            image_utils.validate_image_file(path)

    def test_rejects_oversized_file(self, site_path: Path) -> None:
        with pytest.raises(ImageValidationError, match="above the"):
            image_utils.validate_image_file(site_path, max_mb=0.000001)

    def test_rejects_too_many_pixels(self, site_path: Path) -> None:
        with pytest.raises(ImageValidationError, match="MP limit"):
            image_utils.validate_image_file(site_path, max_pixels=100)

    def test_rejects_tiny_image(self, tmp_path: Path) -> None:
        path = tmp_path / "tiny.png"
        Image.new("RGB", (16, 16), "red").save(path)
        with pytest.raises(ImageValidationError, match="minimum is 64x64"):
            image_utils.validate_image_file(path)


class TestStoreUpload:
    def test_name_comes_from_the_stem_not_the_upload(self, site_path: Path, tmp_path: Path) -> None:
        stored = image_utils.store_upload(site_path, tmp_path / "store", "../../evil")
        assert stored.parent == tmp_path / "store"
        assert ".." not in stored.name
        assert stored.exists()


class TestAspect:
    @pytest.mark.parametrize("aspect,expected", [("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0)])
    def test_fit_to_aspect(self, aspect: str, expected: float) -> None:
        result = image_utils.fit_to_aspect(Image.new("RGB", (800, 600)), aspect)
        assert result.width / result.height == pytest.approx(expected, rel=0.02)

    def test_unknown_aspect_rejected(self) -> None:
        with pytest.raises(ValueError, match="Unknown aspect"):
            image_utils.fit_to_aspect(Image.new("RGB", (100, 100)), "3:2")

    def test_no_upscaling_distortion(self) -> None:
        source = Image.new("RGB", (1000, 100))
        assert image_utils.fit_to_aspect(source, "1:1").size == (100, 100)

    def test_resize_hits_the_exact_target(self) -> None:
        assert image_utils.resize_to(Image.new("RGB", (1234, 567)), (480, 832)).size == (480, 832)

    def test_prepare_frames_matches_sizes(self, site_image, finished_image) -> None:
        first, last = image_utils.prepare_frames(site_image, finished_image, "9:16", (480, 832))
        assert first.size == last.size == (480, 832)


class TestSimilarity:
    def test_identical_frames_score_one(self, finished_image) -> None:
        report = image_utils.compare_frames(finished_image, finished_image)
        assert report.ssim == pytest.approx(1.0, abs=1e-6)
        assert report.passed

    def test_different_frames_fail(self, site_image, noise_image) -> None:
        report = image_utils.compare_frames(site_image, noise_image, threshold=0.7)
        assert not report.passed
        assert "does NOT match" in report.message

    def test_handles_mismatched_sizes(self, finished_image) -> None:
        smaller = finished_image.resize((160, 90))
        assert image_utils.compare_frames(finished_image, smaller).ssim > 0.3

    def test_threshold_is_respected(self, site_image, noise_image) -> None:
        assert image_utils.compare_frames(site_image, noise_image, threshold=0.0).passed
