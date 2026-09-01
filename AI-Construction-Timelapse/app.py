#!/usr/bin/env python3
"""Entry point for the AI Construction Timelapse web application."""

from __future__ import annotations

import argparse
import logging
import sys

from src.ui.interface import CSS, THEME, build_interface
from src.utils.config import configure_logging, get_settings
from src.utils.gpu_utils import describe_environment

logger = logging.getLogger("app")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=None, help="Bind address (default: SERVER_NAME)")
    parser.add_argument("--port", type=int, default=None, help="Port (default: SERVER_PORT)")
    parser.add_argument("--share", action="store_true", help="Create a public Gradio share link")
    parser.add_argument("--mock", action="store_true", help="Force MOCK_MODE for this run")
    parser.add_argument("--log-level", default=None, help="DEBUG, INFO, WARNING, ERROR")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = get_settings()
    if args.mock:
        settings.mock_mode = True

    configure_logging(args.log_level)
    settings.ensure_directories()

    environment = describe_environment()
    logger.info("AI Construction Timelapse starting")
    logger.info("  GPU:      %s", environment["gpu"])
    logger.info("  torch:    %s", environment["torch"])
    logger.info("  ffmpeg:   %s", environment["ffmpeg"])
    logger.info("  model:    %s", settings.wan_model_path)
    logger.info("  mock:     %s", settings.mock_mode)

    if settings.mock_mode:
        logger.warning("MOCK_MODE is on; output will be a labelled placeholder, not generated video.")
    elif not environment["gpu_available"]:
        logger.warning(
            "No CUDA GPU detected. Real generation will fail; start with --mock to try the UI."
        )

    demo = build_interface(settings)
    demo.queue().launch(
        server_name=args.host or settings.server_name,
        server_port=args.port or settings.server_port,
        share=args.share or settings.share,
        show_error=True,
        css=CSS,
        theme=THEME,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
