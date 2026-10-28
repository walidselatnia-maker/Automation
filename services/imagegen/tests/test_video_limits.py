"""What the 2026-10-28 picture stress test means for reels (videos).

Reels never go through the composer: they are one batch call with Flow's one
10-second reel model. So:
- A daily quota on that model cannot be met by switching model (there is no
  other 10-second one). The job fails at once with Google's code, never
  retried here -- each retry is three uploads and a captcha -- and the
  platform gives the reel to its next Google account.
- Google's own code in the operation poll (PUBLIC_ERROR_...) fails the video
  at once, instead of waiting out twenty minutes for a clip that will not come.
  A bare complaint ("Media not found.") is still not a failure.
"""
import asyncio
import json

import pytest

from agent import generation_hold, video_models
from agent.db import jobs, schema
from agent.services import flow_batch as fb
from agent.worker import processor
from agent.worker.processor import WorkerController

OP = "bafe318d-0162-4a4c-8a53-f44705180a2b"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    monkeypatch.setattr(generation_hold, "HOLD_PATH", tmp_path / "hold.json")
    yield
    asyncio.run(schema.close_db())


@pytest.fixture
def no_waiting(monkeypatch):
    async def instant(_seconds):
        return None

    monkeypatch.setattr(processor.asyncio, "sleep", instant)


def test_the_daily_quota_is_told_apart_from_no_credits():
    assert video_models.out_for_today("PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED")
    assert video_models.out_for_today("You've reached your usage limit")
    assert not video_models.out_for_today("PUBLIC_ERROR_USER_QUOTA_REACHED")
    assert not video_models.out_for_today("")


def test_a_reel_out_of_its_daily_quota_fails_at_once_with_googles_code(monkeypatch):
    submits = []

    class Fake:
        connected = True

        async def upload_image_batch(self, image_base64, project_id, mime_type, file_name):
            return {"media_id": "m-1"}

        async def generate_reel_batch(self, **kwargs):
            submits.append(kwargs)
            return {"error": "code 8: PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED"}

    monkeypatch.setattr(processor, "get_flow_client", lambda: Fake())
    controller = WorkerController()

    async def fetched(url):
        return {"bytes": b"jpg", "mime": "image/jpeg"}

    monkeypatch.setattr(controller, "_fetch_reference", fetched)
    job = asyncio.run(jobs.create_video("a dog runs", ["https://a/1.jpg"], "P", "VERTICAL"))
    asyncio.run(jobs.claim_pending(1))
    asyncio.run(controller._run_video_batch(job, json.loads(job["reference_urls"]), "P"))

    after = asyncio.run(jobs.get(job["id"]))
    assert after["status"] == "FAILED"  # not PENDING: no retry into the quota
    assert "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED" in after["error_message"]
    assert len(submits) == 1


def test_the_code_is_read_anywhere_in_an_answer():
    payload = [None, 40, [[OP, None, None, None, None, [None, "x", ["PUBLIC_ERROR_UNUSUAL_ACTIVITY"]]]]]
    assert fb.public_error_code(payload) == "PUBLIC_ERROR_UNUSUAL_ACTIVITY"
    assert fb.public_error_code([None, 40, [[OP, None, None, "CAE"]]]) is None


class PollClient:
    def __init__(self, state):
        self.state = state
        self.polls = 0

    async def check_operation_batch(self, operation_id):
        self.polls += 1
        return dict(self.state)

    async def find_operation_media_batch(self, operation_id, project_id):
        return {"media_id": None}


def poll(monkeypatch, state):
    client = PollClient(state)
    monkeypatch.setattr(processor, "get_flow_client", lambda: client)
    monkeypatch.setattr(processor, "VIDEO_MAX_POLLS", 8)
    job = asyncio.run(jobs.create("a reel"))
    asyncio.run(jobs.claim_pending(1))
    asyncio.run(WorkerController()._await_video_batch(job, OP, "P"))
    return client, asyncio.run(jobs.get(job["id"]))


def test_googles_code_in_the_poll_fails_the_video_at_once(monkeypatch, no_waiting):
    client, job = poll(monkeypatch, {"done": False, "status": None, "complaint": "x",
                                     "code": "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED"})
    assert client.polls == 1
    assert job["status"] == "FAILED"
    assert "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED" in job["error_message"]


def test_unusual_activity_in_the_poll_still_holds_the_service(monkeypatch, no_waiting):
    client, job = poll(monkeypatch, {"done": False, "status": None, "complaint": None,
                                     "code": "PUBLIC_ERROR_UNUSUAL_ACTIVITY"})
    assert client.polls == 1
    assert job["status"] == "FAILED"
    assert generation_hold.active() is not None
    generation_hold.clear()


def test_a_bare_complaint_is_still_waited_on(monkeypatch, no_waiting):
    client, _job = poll(monkeypatch, {"done": False, "status": None,
                                      "complaint": "Media not found.", "code": None})
    assert client.polls == 8
