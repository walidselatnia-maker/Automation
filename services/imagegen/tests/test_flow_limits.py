"""What stopped pictures in a real Flow tab, 2026-10-28, and what is done now.

Measured over 201 pictures on a free and a paid account:
- Google's daily quota is per model (PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED).
  Pro stopped after 17 pictures on the free account and ~94 on the paid one;
  the next model worked at once. So the job picks the next model, Lite first.
- PUBLIC_ERROR_UNUSUAL_ACTIVITY through the composer is a verdict on one
  picture or one burst; the next submit worked. So the job is tried again and
  only refusals in a row hold the service, for minutes.
- Every failed tile reads the same words, so a failure is told by Google's
  answer or by one more tile showing them, not by words not seen before.
"""
import asyncio

import pytest

from agent import generation_hold, image_models
from agent.services.flow_client import answered_code, code_of_message
from agent.worker import processor

from tests.test_ui_generate import Fake, image, run

_REAL_SLEEP = asyncio.sleep
QUOTA = "FLOW_UI_ERROR: PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED: Google refused the picture"
UNUSUAL = "FLOW_UI_ERROR: PUBLIC_ERROR_UNUSUAL_ACTIVITY: Google refused the picture"
OK = {"status": 200, "data": {"media": [{"name": "m", "image": {"generatedImage": {"fifeUrl": "u"}}}]}}


@pytest.fixture(autouse=True)
def fresh_models():
    image_models.forget_all()
    generation_hold.note_picture()
    yield
    image_models.forget_all()


# ─── Telling this picture's failure ─────────────────────────

def test_googles_answer_after_the_submit_fails_the_picture_at_once(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    client = Fake([[image("old")]], submit={"ok": True, "submitted": True, "submittedAt": 1000})
    client.codes = [{"code": "PUBLIC_ERROR_UNUSUAL_ACTIVITY", "at": 900},
                    {"code": "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED", "at": 1001}]

    out = run(client)

    assert out["error"] == QUOTA


def test_an_answer_from_before_the_submit_is_not_this_pictures():
    assert answered_code([{"code": "PUBLIC_ERROR_X", "at": 5}], 10) is None
    assert answered_code([{"code": "PUBLIC_ERROR_X", "at": 5}], None) is None
    assert answered_code([{"code": "PUBLIC_ERROR_X", "at": 10}], 10) == "PUBLIC_ERROR_X"


def test_the_same_words_on_one_more_tile_are_this_pictures_failure(monkeypatch):
    monkeypatch.setattr(asyncio, "sleep", lambda _s: _REAL_SLEEP(0))
    words = "Failed: You've reached your usage limit. Please try again later."
    client = Fake([[image("old")]],
                  submit={"ok": True, "submitted": True, "pageErrors": [words],
                          "pageErrorCounts": {words: 1}},
                  page_errors=[[words, words]])

    out = run(client)

    assert out["error"].startswith("FLOW_UI_ERROR: PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED")


def test_what_a_failed_tile_says_names_googles_code():
    assert code_of_message("We noticed some unusual activity.") == "PUBLIC_ERROR_UNUSUAL_ACTIVITY"
    assert code_of_message("You've reached your usage limit.") == \
        "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED"
    assert code_of_message("Something went wrong.") is None


# ─── A model out for today ──────────────────────────────────

class Composer:
    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    async def generate_images_ui(self, prompt, project_id, model_label=None, aspect_label=None):
        self.asked.append(model_label)
        return self.answers.get(model_label, OK)


def ui_run(answers, choice="auto"):
    client = Composer(answers)
    job = {"id": "job-1", "image_model": choice}
    request = {"prompt": "p", "project_id": "PROJ-1", "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT"}
    out = asyncio.run(processor.WorkerController._generate_by_ui(client, job, request))
    return out, client.asked


def test_a_spent_model_moves_the_same_job_to_lite():
    out, asked = ui_run({"Nano Banana Pro": {"error": QUOTA}})

    assert asked == ["Nano Banana Pro", "Nano Banana 2 Lite"]
    assert out == OK


def test_the_spent_model_is_left_out_of_the_next_job():
    ui_run({"Nano Banana Pro": {"error": QUOTA}})
    _, asked = ui_run({})

    assert asked == ["Nano Banana 2.1"]


def test_a_picked_model_falls_back_only_on_its_daily_quota():
    _, asked = ui_run({"Nano Banana 2.1": {"error": QUOTA}}, choice="NANO_BANANA_2_1")
    assert asked == ["Nano Banana 2.1", "Nano Banana 2 Lite"]

    image_models.forget_all()
    out, asked = ui_run({"Nano Banana 2.1": {"error": "FLOW_UI_ERROR: Something went wrong."}},
                        choice="NANO_BANANA_2_1")
    assert asked == ["Nano Banana 2.1"]
    assert "error" in out


def test_every_model_spent_ends_with_the_quota_error():
    out, asked = ui_run({m: {"error": QUOTA} for m in
                         ("Nano Banana Pro", "Nano Banana 2.1", "Nano Banana 2 Lite")})

    assert asked == ["Nano Banana Pro", "Nano Banana 2 Lite", "Nano Banana 2.1"]
    assert out["error"] == QUOTA


# ─── Unusual activity through the composer ──────────────────

def handle(monkeypatch, error, attempts=1):
    calls = []

    async def fail(job_id, err):
        calls.append("fail")

    async def requeue(job_id, err):
        calls.append("requeue")

    monkeypatch.setattr(processor.jobs, "fail", fail)
    monkeypatch.setattr(processor.jobs, "requeue", requeue)
    asyncio.run(processor.WorkerController()._handle_failure({"id": "job-1", "attempts": attempts}, error))
    return calls


def test_one_refusal_tries_the_picture_again_without_a_hold(monkeypatch):
    assert handle(monkeypatch, UNUSUAL) == ["requeue"]
    assert generation_hold.active() is None


def test_refusals_in_a_row_hold_for_minutes_not_an_hour(monkeypatch):
    for _ in range(generation_hold.UI_UNUSUAL_HOLD_AFTER):
        handle(monkeypatch, UNUSUAL)

    held = generation_hold.active()
    assert held is not None
    assert held["seconds_left"] <= generation_hold.UI_UNUSUAL_HOLD_S


def test_a_picture_between_refusals_starts_the_count_again(monkeypatch):
    for _ in range(generation_hold.UI_UNUSUAL_HOLD_AFTER - 1):
        handle(monkeypatch, UNUSUAL)
    generation_hold.note_picture()
    handle(monkeypatch, UNUSUAL)

    assert generation_hold.active() is None


def test_a_job_refused_too_often_fails(monkeypatch):
    assert handle(monkeypatch, UNUSUAL, attempts=processor.MAX_RETRIES * 2) == ["fail"]
