"""Pro, then 2, then whatever the page says -- and only on a refusal.

Flow offers three image models. Pro is wanted; the others are what to fall
back to when Google refuses Pro by name. Two wire names are known; the third
is read off the Flow page. What these pin is the seam this service owns: the
order, what counts as a refusal, that a non-refusal stops the walk rather than
spending another captcha, that a refused model is tried again later, and that
a name read off the page which Flow does not recognise is dropped for good
after costing exactly one attempt.
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
BAD_NAME = {"error": "{'code': 400, 'message': 'Request contains an invalid argument.', "
                     "'status': 'INVALID_ARGUMENT'}"}

# What the page says when it carries a third name beside the two known ones.
PAGE_WITH_LITE = {"near": {
    "GEM_PIX_2": ["IMAGE_ASPECT_RATIO_SQUARE", "NARWHAL", "NARWHAL_LITE_X"],
    "NARWHAL": ["GEM_PIX_2", "NARWHAL_LITE_X", "PUBLIC_ERROR_QUOTA"],
}}
PAGE_WITHOUT = {"near": {"GEM_PIX_2": ["NARWHAL"], "NARWHAL": ["GEM_PIX_2"]}}


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "w.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    monkeypatch.setattr(processor, "IMAGE_USE_BATCH", True)
    monkeypatch.setattr(processor, "API_COOLDOWN", 0)
    monkeypatch.setattr(processor, "FLOW_PROJECT_ID", "PROJ-1")
    image_models.forget_all()
    asyncio.run(schema.init_db())
    yield
    image_models.forget_all()
    asyncio.run(schema.close_db())


def run_with(monkeypatch, answers: dict[str, dict], page=PAGE_WITH_LITE) -> tuple[dict, list[str]]:
    """One job through _run, with each model answering as `answers` says."""
    asked: list[str] = []

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            return page

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


def test_two_refusals_reach_the_name_read_off_the_page(monkeypatch):
    stored, asked = run_with(monkeypatch, {"NARWHAL_LITE_X": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL", "NARWHAL_LITE_X"]
    assert stored["status"] == "COMPLETED"


# ─── What the page said ─────────────────────────────────────

def test_only_a_name_near_every_known_one_is_taken():
    # NARWHAL_LITE_X sits near both; the aspect ratio and the error code sit
    # near one each. Sharing an enum is what being near all of them means.
    assert image_models.take_discovered(PAGE_WITH_LITE["near"]) == ["NARWHAL_LITE_X"]


def test_the_known_names_are_not_rediscovered():
    assert image_models.take_discovered(PAGE_WITHOUT["near"]) == []


def test_a_page_with_nothing_extra_leaves_the_two_known_names(monkeypatch):
    stored, asked = run_with(monkeypatch, {}, page=PAGE_WITHOUT)

    assert asked == ["GEM_PIX_2", "NARWHAL"]
    assert stored["status"] == "FAILED"


def test_a_page_that_does_not_answer_leaves_the_two_known_names(monkeypatch):
    asked: list[str] = []

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            raise RuntimeError("tab went away")

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            asked.append(image_model_name)
            return OK if image_model_name == "NARWHAL" else DENIED

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    job = asyncio.run(jobs.create("soup"))
    job["attempts"] = 1
    asyncio.run(processor.WorkerController()._run(job))

    assert asked == ["GEM_PIX_2", "NARWHAL"]


def test_the_page_is_asked_once_not_once_per_job(monkeypatch):
    asks = 0

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            nonlocal asks
            asks += 1
            return PAGE_WITH_LITE

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            return OK

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    for _ in range(3):
        job = asyncio.run(jobs.create("soup"))
        job["attempts"] = 1
        asyncio.run(processor.WorkerController()._run(job))

    assert asks == 1


# ─── A discovered name that was not a model ─────────────────

def test_a_discovered_name_flow_rejects_is_dropped_after_one_attempt(monkeypatch):
    run_with(monkeypatch, {"NARWHAL_LITE_X": BAD_NAME})

    _, asked = run_with(monkeypatch, {})

    # The second job never sent it again.
    assert "NARWHAL_LITE_X" not in asked


def test_a_known_name_is_not_dropped_for_invalid_argument(monkeypatch):
    # INVALID_ARGUMENT on a name Google definitely knows is a different fault.
    # Dropping Pro over it would be wrong, and the walk stops instead.
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": BAD_NAME, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "FAILED"
    assert image_models.plan()[0] == "GEM_PIX_2"


# ─── What is not a refusal ──────────────────────────────────

def test_a_captcha_failure_does_not_move_down_the_list(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": CAPTCHA, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "PENDING"  # captcha failures are retryable


# ─── Refusals are not forever ───────────────────────────────

def test_a_refused_model_is_skipped_next_time(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    _, asked = run_with(monkeypatch, {"NARWHAL": OK})

    assert asked == ["NARWHAL"]


def test_a_refused_model_is_tried_again_after_the_cooldown(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    monkeypatch.setattr(image_models, "RETRY_AFTER_S", 0)
    image_models.refused("GEM_PIX_2")  # re-stamp with the zero cooldown

    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})

    assert asked[0] == "GEM_PIX_2"


def test_when_everything_is_skipped_the_whole_list_is_tried():
    for m in ("GEM_PIX_2", "NARWHAL"):
        image_models.refused(m)

    assert image_models.plan() == ["GEM_PIX_2", "NARWHAL"]
