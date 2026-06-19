"""Filesystem path helpers for runtime state."""

from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    """Return the directory used for local run artifacts and SQLite state."""

    configured = os.getenv("HIVEMIND_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return ROOT_DIR / "data"
