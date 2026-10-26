"""The stop after Google says "unusual activity".

Upstream users lost whole accounts after tools kept submitting into this
verdict (crisng95/flowkit#67). What is pinned: the first one stops every new
job for an hour, the stop survives a restart, and the job that drew it is
failed rather than retried.
"""
import asyncio
import json
import time

from agent import generation_hold
from agent.worker import processor


def test_no_hold_until_one_is_started():
    assert generation_hold.active() is None


def test_a_hold_is_on_disk_so_a_restart_keeps_it():
    generation_hold.start("Google said unusual activity", seconds=3600)

    saved = json.loads(generation_hold.HOLD_PATH.read_text())
    held = generation_hold.active()

    assert saved["reason"] == "Google said unusual activity"
    assert held["reason"] == "Google said unusual activity"
    assert 3590 < held["seconds_left"] <= 3600


def test_a_shorter_hold_does_not_cut_a_longer_one():
    generation_hold.start("long", seconds=3600)
    generation_hold.start("short", seconds=30)

    assert generation_hold.active()["reason"] == "long"


def test_a_hold_runs_out():
    generation_hold.HOLD_PATH.write_text(json.dumps({"until": time.time() - 1, "reason": "old"}))

    assert generation_hold.active() is None


def test_clear_lifts_it():
    generation_hold.start("x", seconds=3600)

    assert generation_hold.clear() is True
    assert generation_hold.active() is None


def test_every_spelling_counts():
    assert generation_hold.is_unusual_activity("PUBLIC_ERROR_UNUSUAL_ACTIVITY")
    assert generation_hold.is_unusual_activity("FLOW_UI_ERROR: We noticed some unusual activity.")
    assert not generation_hold.is_unusual_activity("RESOURCE_EXHAUSTED")


def test_the_job_that_drew_it_fails_and_everything_stops(monkeypatch):
    calls = []

    async def fail(job_id, error):
        calls.append(("fail", job_id))

    async def requeue(job_id, error):
        calls.append(("requeue", job_id))

    monkeypatch.setattr(processor.jobs, "fail", fail)
    monkeypatch.setattr(processor.jobs, "requeue", requeue)

    # "recaptcha" in the text would otherwise make it retryable.
    error = "recaptcha ok but PUBLIC_ERROR_UNUSUAL_ACTIVITY"
    asyncio.run(processor.WorkerController()._handle_failure({"id": "job-1", "attempts": 1}, error))

    assert calls == [("fail", "job-1")]
    assert generation_hold.active() is not None
