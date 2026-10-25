"""Guard the CI test environment against drift from the Docker runtime pins.

requirements-test.txt installs only the dependencies the backend tests need, without
the GPU ASR stack. Every shared package must keep the exact version from
requirements.txt, otherwise CI would validate a different environment than the image
that actually ships.
"""
from __future__ import annotations

import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PRODUCTION_REQUIREMENTS = BACKEND_DIR / "requirements.txt"
TEST_REQUIREMENTS = BACKEND_DIR / "requirements-test.txt"

TEST_ONLY_PACKAGES = {"pytest"}

_REQUIREMENT = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$")


def _canonical(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def _entries(path: Path) -> list[str]:
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            entries.append(entry)
    return entries


def _parse(entry: str) -> tuple[str, str | None]:
    match = _REQUIREMENT.match(entry)
    assert match, f"cannot parse requirement {entry!r}"
    name, specifier = match.groups()
    version = None
    if specifier.startswith("==") and specifier[2:].strip():
        version = specifier[2:].strip()
    return _canonical(name), version


def test_test_requirements_match_production_pins():
    production = dict(_parse(entry) for entry in _entries(PRODUCTION_REQUIREMENTS))
    mismatches = {}
    for entry in _entries(TEST_REQUIREMENTS):
        name, version = _parse(entry)
        if name in TEST_ONLY_PACKAGES:
            continue
        if version is None:
            mismatches[name] = (entry, "requirements-test.txt must pin an exact version")
        elif production.get(name) != version:
            mismatches[name] = (entry, f"requirements.txt pins {production.get(name)!r}")
    assert not mismatches, f"requirements-test.txt drifted from requirements.txt: {mismatches}"
