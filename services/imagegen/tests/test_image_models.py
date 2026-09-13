"""Pro, then 2, then Lite -- and only on a refusal.

Flow offers three image models. Pro is wanted; the others are what to fall
back to when Google refuses Pro by name. What these pin is the seam this
service owns: the order, what counts as a refusal, that a non-refusal stops
the walk rather than spending another captcha, and that a refused model is
tried again later rather than abandoned for good.
"""
import asyncio

import pytest

from agent import image_models
from agent.db import jobs, schema
from agent.worker import processor

MEDIA_UUID = "11111111-2222-4333-8444-555555555555"
CDN_URL = f"https://flow-content.google/image/{MEDIA_UUID}?sig=x"
OK = {"status": 200, "data": {"media": [
    {"name": MEDIA_UUID, "image": {"generatedImage": {"fifeUrl": CDN_URL}}}]}}
DENIED = {"error": "PUBLIC_ERROR_MODEL_ACCESS_DENIED: not for this account"}
NO_CREDITS = {"error": "code 8 PUBLIC_ERROR_USER_QUOTA_REACHED"}
CAPTCHA = {"error": "CAPTCHA_FAILED: grecaptcha not available"}


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "w.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    monkeypatch.setattr(processor, "IMAGE_USE_BATCH", True)
    monkeypatch.setattr(processor, "API_COOLDOWN", 0)
    monkeypatch.setattr(processor, "FLOW_PROJECT_ID", "PROJ-1")
    monkeypatch.setattr(image_models, "CANDIDATES", ("GEM_PIX_2", "NARWHAL", "LITE_X"))
    image_models.forget_all()
    asyncio.run(schema.init_db())
    yield
    image_models.forget_all()
    asyncio.run(schema.close_db())


def run_with(monkeypatch, answers: dict[str, dict]) -> tuple[dict, list[str]]:
    """One job through _run, with each model answering as `answers` says."""
    asked: list[str] = []

    class FakeClient:
        connected = True

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            asked.append(image_model_name)
            return answers.get(image_model_name, DENIED)

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())

    job = asyncio.run(jobs.create("soup"))
    job["attempts"] = 1
    asyncio.run(processor.WorkerController()._run(job))
    return asyncio.run(jobs.get(job["id"])), asked


# ─── The order ──────────────────────────────────────────────

def test_pro_is_asked_first_and_alone_when_it_works(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "COMPLETED"


def test_a_refused_pro_falls_back_to_2(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL"]
    assert stored["status"] == "COMPLETED"


def test_no_credits_on_pro_also_falls_back(monkeypatch):
    # Credits can be tiered by model; Pro being out does not mean 2 is.
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": NO_CREDITS, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL"]
    assert stored["status"] == "COMPLETED"


def test_two_refusals_reach_the_third(monkeypatch):
    stored, asked = run_with(monkeypatch, {"LITE_X": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL", "LITE_X"]
    assert stored["status"] == "COMPLETED"


# ─── What is not a refusal ──────────────────────────────────

def test_a_captcha_failure_does_not_move_down_the_list(monkeypatch):
    # Not about the model. The next one would spend a captcha on the same
    # problem, so the walk stops and the job takes the ordinary retry path.
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": CAPTCHA, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "PENDING"  # captcha failures are retryable


# ─── Refusals are not forever ───────────────────────────────

def test_a_refused_model_is_skipped_next_time(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    _, asked = run_with(monkeypatch, {"NARWHAL": OK})

    # The second job did not pay Pro's captcha again.
    assert asked == ["NARWHAL"]


def test_a_refused_model_is_tried_again_after_the_cooldown(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    # Time passes.
    monkeypatch.setattr(image_models, "RETRY_AFTER_S", 0)
    image_models.refused("GEM_PIX_2")  # re-stamp with the zero cooldown

    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})

    assert asked[0] == "GEM_PIX_2"


def test_when_everything_is_skipped_the_whole_list_is_tried(monkeypatch):
    for m in ("GEM_PIX_2", "NARWHAL", "LITE_X"):
        image_models.refused(m)

    assert image_models.plan() == ["GEM_PIX_2", "NARWHAL", "LITE_X"]


# ─── The names ──────────────────────────────────────────────

def test_the_order_can_be_written_in_flows_own_words():
    assert image_models._parse("NANO_BANANA_PRO, NANO_BANANA_2") == ["GEM_PIX_2", "NARWHAL"]


def test_an_unknown_name_is_passed_through_not_coerced():
    # A configured Lite name must reach Google as written. Coercing it to the
    # default would silently turn the third fallback back into Pro.
    assert image_models._parse("GEM_PIX_2,SOME_LITE_NAME") == ["GEM_PIX_2", "SOME_LITE_NAME"]
