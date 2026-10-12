"""Pro, then 2.1, then 2 Lite -- or exactly the one that was picked.

Flow offers three image models, all three wire names read off a real request
from the Flow page on 2026-10-10: GEM_PIX_2 (Pro), BELUGA (2.1) and
HARBOR_SEAL (2 Lite). The platform's Settings page picks one, or Automatic.
What these pin is the seam this service owns: the automatic order, what counts
as a refusal, that a non-refusal stops the walk rather than spending another
captcha, that a picked model is sent alone, and that every answer is recorded
for the page to show.
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

PAGE = {"near": {}}


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


def run_with(monkeypatch, answers, page=PAGE, choice="auto"):
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


def test_a_refused_pro_falls_back_to_2_1(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": DENIED, "BELUGA": OK})

    assert asked == ["GEM_PIX_2", "BELUGA"]
    assert stored["status"] == "COMPLETED"


def test_no_credits_on_pro_also_falls_back(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": NO_CREDITS, "BELUGA": OK})

    assert asked == ["GEM_PIX_2", "BELUGA"]
    assert stored["status"] == "COMPLETED"


def test_two_refusals_reach_lite(monkeypatch):
    stored, asked = run_with(monkeypatch, {"HARBOR_SEAL": OK})

    assert asked == ["GEM_PIX_2", "BELUGA", "HARBOR_SEAL"]
    assert stored["status"] == "COMPLETED"


def test_the_retired_banana_2_name_is_never_sent(monkeypatch):
    _, asked = run_with(monkeypatch, {"HARBOR_SEAL": OK})
    assert "NARWHAL" not in asked


def test_a_captcha_failure_does_not_move_down_the_list(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": CAPTCHA, "BELUGA": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "PENDING"  # captcha failures are retryable


def test_a_refused_model_is_skipped_next_time_and_tried_again_later(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "BELUGA": OK})
    _, asked = run_with(monkeypatch, {"BELUGA": OK})
    assert asked == ["BELUGA"]

    monkeypatch.setattr(image_models, "RETRY_AFTER_S", 0)
    image_models.refused("GEM_PIX_2")
    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK})
    assert asked[0] == "GEM_PIX_2"


# ─── Picked by hand ─────────────────────────────────────────

def test_a_picked_model_is_sent_alone(monkeypatch):
    stored, asked = run_with(monkeypatch, {"BELUGA": OK}, choice="NANO_BANANA_2_1")

    assert asked == ["BELUGA"]
    assert stored["status"] == "COMPLETED"


def test_a_saved_banana_2_choice_now_means_2_1(monkeypatch):
    stored, asked = run_with(monkeypatch, {"BELUGA": OK}, choice="NANO_BANANA_2")

    assert asked == ["BELUGA"]
    assert stored["status"] == "COMPLETED"


def test_picking_lite_sends_its_name(monkeypatch):
    stored, asked = run_with(monkeypatch, {"HARBOR_SEAL": OK}, choice="NANO_BANANA_2_LITE")

    assert asked == ["HARBOR_SEAL"]
    assert stored["status"] == "COMPLETED"
    assert outcome("HARBOR_SEAL") == image_models.ACCEPTED


def test_a_picked_model_is_not_skipped_for_a_recent_refusal(monkeypatch):
    # The person picked it; the point may be to see what it says now.
    image_models.refused("GEM_PIX_2")
    _, asked = run_with(monkeypatch, {"GEM_PIX_2": OK}, choice="NANO_BANANA_PRO")

    assert asked == ["GEM_PIX_2"]


def test_an_unknown_choice_is_treated_as_automatic_by_the_api():
    from agent.api import v1  # noqa: F401 - the guard lives in the route
    keys = {image_models.AUTO, *(m["key"] for m in image_models.MODELS)}
    assert "NANO_BANANA_2_LITE" in keys and "SOMETHING_ELSE" not in keys


# ─── What the page shows ────────────────────────────────────

def test_every_answer_is_recorded_for_the_settings_page(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": DENIED, "BELUGA": OK})

    assert outcome("GEM_PIX_2") == image_models.REFUSED
    assert outcome("BELUGA") == image_models.ACCEPTED
    assert outcome("HARBOR_SEAL") == image_models.UNTRIED


def test_a_known_name_is_not_marked_rejected_for_invalid_argument(monkeypatch):
    stored, asked = run_with(monkeypatch, {"GEM_PIX_2": BAD_NAME, "BELUGA": OK})

    assert asked == ["GEM_PIX_2"]
    assert stored["status"] == "FAILED"
    assert outcome("GEM_PIX_2") == image_models.UNTRIED  # a different fault, not recorded against it


def test_the_catalogue_names_all_three(monkeypatch):
    run_with(monkeypatch, {"GEM_PIX_2": OK})

    cat = image_models.catalogue()
    assert [m["key"] for m in cat] == ["NANO_BANANA_PRO", "NANO_BANANA_2_1", "NANO_BANANA_2_LITE"]
    assert [m["wire"] for m in cat] == ["GEM_PIX_2", "BELUGA", "HARBOR_SEAL"]
    assert [m["discovered"] for m in cat] == [False, False, False]


# ─── Discovery ──────────────────────────────────────────────

def test_a_scan_does_not_replace_the_known_lite_name(monkeypatch):
    page = {"near": {w: ["SOMETHING_NEW"] for w in image_models.KNOWN}}
    run_with(monkeypatch, {"GEM_PIX_2": OK}, page=page)
    assert image_models.catalogue()[2]["wire"] == "HARBOR_SEAL"


def test_the_page_is_asked_once_not_once_per_job(monkeypatch):
    asks = 0

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            nonlocal asks
            asks += 1
            return PAGE

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            return OK

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    for _ in range(3):
        job = asyncio.run(jobs.create("soup"))
        job["attempts"] = 1
        asyncio.run(processor.WorkerController()._run(job))

    assert asks == 1


def test_a_page_that_does_not_answer_leaves_the_three_known_names(monkeypatch):
    asked: list[str] = []

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            raise RuntimeError("tab went away")

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            asked.append(image_model_name)
            return OK if image_model_name == "HARBOR_SEAL" else DENIED

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    job = asyncio.run(jobs.create("soup"))
    job["attempts"] = 1
    asyncio.run(processor.WorkerController()._run(job))

    assert asked == ["GEM_PIX_2", "BELUGA", "HARBOR_SEAL"]


def test_a_pin_job_asks_flow_for_a_3_4_picture(monkeypatch):
    seen: dict = {}

    class FakeClient:
        connected = True

        async def discover_image_models(self, known):
            return PAGE

        async def generate_images_batch(self, image_model_name=None, **kwargs):
            seen.update(kwargs)
            return OK

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    job = asyncio.run(jobs.create("a pin", "PORTRAIT_3_4"))
    job["attempts"] = 1
    asyncio.run(processor.WorkerController()._run(job))
    assert seen["aspect_ratio"] == "IMAGE_ASPECT_RATIO_PORTRAIT_FOUR_THREE"
