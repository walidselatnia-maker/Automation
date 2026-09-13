"""Pro, then 2, then whatever the page says -- or exactly the one that was picked.

Flow offers three image models. Two wire names are known; the third is read
off the Flow page. The platform's Settings page picks one, or Automatic. What
these pin is the seam this service owns: the automatic order, what counts as
a refusal, that a non-refusal stops the walk rather than spending another
captcha, that a picked model is sent alone, that every answer is recorded for
the page to show, and that a name read off the page which Flow does not
recognise is marked so after costing exactly one attempt.
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


def run_with(monkeypatch, answers, page=PAGE_WITH_LITE, choice="auto"):
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

    job = asyncio.run(jobs.create("soup", image_model=choice))
    job["attempts"] = 1
    asyncio.run(processor.WorkerController()._run(job))
    return asyncio.run(jobs.get(job["id"])), asked


def outcome(wire):
    return next(m for m in image_models.catalogue() if m["wire"] == wire)["outcome"]


# ─── Automatic ──────────────────────────────────────────────

def test_pro_is_asked_first_and_alone_when_it_works(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "COMPLETED"


def test_a_refused_pro_falls_back_to_2(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL"]
    assert stored["status"] == "COMPLETED"


def test_no_credits_on_pro_also_falls_back(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": NO_CREDITS, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL"]
    assert stored["status"] == "COMPLETED"


def test_two_refusals_reach_the_name_read_off_the_page(monkeypatch):
    stored, asked = run_with(monkeypatch, {"NARWHAL_LITE_X": OK})

    assert asked == ["GEM_PIX_2", "NARWHAL", "NARWHAL_LITE_X"]
    assert stored["status"] == "COMPLETED"


def test_a_captcha_failure_does_not_move_down_the_list(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": CAPTCHA, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "PENDING"  # captcha failures are retryable


def test_a_refused_model_is_skipped_next_time_and_tried_again_later(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})
    _, asked = run_with(monkeypatch, {"NARWHAL": OK})
    assert asked == ["NARWHAL"]

    monkeypatch.setattr(image_models, "RETRY_AFTER_S", 0)
    image_models.refused("GEM_PIX_2")
    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})
    assert asked[0] == "GEM_PIX_2"


# ─── Picked by hand ─────────────────────────────────────────

def test_a_picked_model_is_sent_alone(monkeypatch):
    stored, asked = run_with(monkeypatch, {"NARWHAL": OK}, choice="NANO_BANANA_2")

    assert asked == ["NARWHAL"]
    assert stored["status"] == "COMPLETED"


def test_picking_lite_sends_the_name_read_off_the_page(monkeypatch):
    # This is the verification: a person picks the third model on the Settings
    # page and runs one article. It is sent alone, and its answer is recorded.
    stored, asked = run_with(monkeypatch, {"NARWHAL_LITE_X": OK}, choice="NANO_BANANA_2_LITE")

    assert asked == ["NARWHAL_LITE_X"]
    assert stored["status"] == "COMPLETED"
    assert outcome("NARWHAL_LITE_X") == image_models.ACCEPTED


def test_a_picked_model_is_not_skipped_for_a_recent_refusal(monkeypatch):
    # The person picked it; the point may be to see what it says now.
    image_models.refused("GEM_PIX_2")
    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK}, choice="NANO_BANANA_PRO")

    assert asked == ["GEM_PIX_2"]


def test_picking_lite_before_it_is_found_fails_plainly(monkeypatch):
    stored, asked = run_with(monkeypatch, {}, page=PAGE_WITHOUT, choice="NANO_BANANA_2_LITE")

    assert asked == []
    assert stored["status"] == "FAILED"
    assert "not been found on the Flow page" in stored["error_message"]


def test_an_unknown_choice_is_treated_as_automatic_by_the_api():
    from agent.api import v1  # noqa: F401 - the guard lives in the route
    keys = {image_models.AUTO, *(m["key"] for m in image_models.MODELS)}
    assert "NANO_BANANA_2_LITE" in keys and "SOMETHING_ELSE" not in keys


# ─── What the page shows ────────────────────────────────────

def test_every_answer_is_recorded_for_the_settings_page(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "NARWHAL": OK})

    assert outcome("GEM_PIX_2") == image_models.REFUSED
    assert outcome("NARWHAL") == image_models.ACCEPTED
    assert outcome("NARWHAL_LITE_X") == image_models.UNTRIED


def test_a_discovered_name_flow_rejects_is_marked_and_left_out_of_automatic(monkeypatch):
    run_with(monkeypatch, {"NARWHAL_LITE_X": BAD_NAME})
    assert outcome("NARWHAL_LITE_X") == image_models.REJECTED

    _, asked = run_with(monkeypatch, {})
    assert "NARWHAL_LITE_X" not in asked


def test_a_known_name_is_not_marked_rejected_for_invalid_argument(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": BAD_NAME, "NARWHAL": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "FAILED"
    assert outcome("GEM_PIX_2") == image_models.UNTRIED  # a different fault, not recorded against it


def test_the_catalogue_names_all_three_and_says_which_was_discovered(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": OK})

    cat = image_models.catalogue()
    assert [m["key"] for m in cat] == ["NANO_BANANA_PRO", "NANO_BANANA_2", "NANO_BANANA_2_LITE"]
    assert [m["discovered"] for m in cat] == [False, False, True]
    assert cat[2]["wire"] == "NARWHAL_LITE_X"


def test_the_catalogue_says_when_lite_has_no_name_yet(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": OK}, page=PAGE_WITHOUT)

    lite = image_models.catalogue()[2]
    assert lite["wire"] is None
    assert lite["outcome"] == "unknown"


# ─── Discovery ──────────────────────────────────────────────

def test_only_a_name_near_every_known_one_is_taken():
    assert image_models.take_discovered(PAGE_WITH_LITE["near"]) == ["NARWHAL_LITE_X"]


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
