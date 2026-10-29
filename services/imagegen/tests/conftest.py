"""Shared defaults for the worker tests.

Image jobs go through Flow's composer now, because Google's frontend build of
2026-09-22 refuses the captcha-gated call the extension used to send. The tests
that predate that change are about the captcha path -- the model walk, the
refusal handling, the name discovery -- so they run with it selected, the way a
deployment would with IMAGE_USE_UI=0. The composer path has its own tests in
test_ui_generate.py.
"""
import pytest

from agent.worker import processor


@pytest.fixture(autouse=True)
def captcha_image_path(monkeypatch):
    monkeypatch.setattr(processor, "IMAGE_USE_UI", False)
    # Clips by clicking have their own tests, which turn it back on.
    monkeypatch.setattr(processor, "VIDEO_USE_UI", False)


@pytest.fixture(autouse=True)
def no_random_cooldown(monkeypatch):
    """The random part of the gap between jobs is real time; tests have none."""
    monkeypatch.setattr(processor, "API_COOLDOWN_JITTER", 0)


@pytest.fixture(autouse=True)
def hold_file_of_its_own(monkeypatch, tmp_path):
    """Each test starts with no generation hold, kept out of the real data dir."""
    from agent import generation_hold

    monkeypatch.setattr(generation_hold, "HOLD_PATH", tmp_path / "generation_hold.json")
