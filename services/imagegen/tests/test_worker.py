"""The worker's decisions: what counts as a failure, and what is worth retrying."""
import asyncio

import pytest

from agent.db import jobs, schema
from agent.worker import processor
from agent.worker._parsing import (
    error_text,
    extract_media_id,
    extract_output_url,
    is_error,
)

MEDIA_UUID = "11111111-2222-4333-8444-555555555555"
CDN_URL = f"https://storage.googleapis.com/x/image/{MEDIA_UUID}?Expires=1800000000"


def ok_response(**generated) -> dict:
    return {
        "data": {
            "media": [{"name": MEDIA_UUID, "image": {"generatedImage": {"fifeUrl": CDN_URL, **generated}}}]
        }
    }


# --- Reading the response ------------------------------------------------

def test_a_normal_response_is_not_an_error():
    assert is_error(ok_response()) is False


@pytest.mark.parametrize(
    "response",
    [
        {"error": "CAPTCHA_FAILED"},
        {"status": 403},
        {"status": 500},
        {"data": {"error": {"code": 429}}},
    ],
)
def test_failures_are_recognised(response):
    assert is_error(response) is True


def test_a_2xx_status_is_not_an_error():
    assert is_error({"status": 200, "data": {"media": []}}) is False


def test_error_text_prefers_the_explicit_message():
    assert error_text({"error": "NO_FLOW_KEY"}) == "NO_FLOW_KEY"
    assert error_text({"status": 503}) == "HTTP 503"


def test_media_id_comes_from_the_name_field():
    assert extract_media_id(ok_response()) == MEDIA_UUID


def test_a_non_uuid_name_is_refused():
    # mediaGenerationId is a base64 protobuf string, not an id anything accepts.
    response = {
        "data": {
            "media": [
                {
                    "name": "CAMSCg1nZW5lcmF0ZWQ",
                    "image": {"generatedImage": {"fifeUrl": "https://cdn/plain.webp"}},
                }
            ]
        }
    }
    assert extract_media_id(response) is None


def test_media_id_falls_back_to_the_uuid_inside_the_url():
    response = {
        "data": {"media": [{"name": "", "image": {"generatedImage": {"fifeUrl": CDN_URL}}}]}
    }
    assert extract_media_id(response) == MEDIA_UUID


def test_media_id_is_none_when_there_is_no_media():
    assert extract_media_id({"data": {"media": []}}) is None


def test_output_url_prefers_fife_then_image_uri():
    assert extract_output_url(ok_response()) == CDN_URL

    without_fife = {
        "data": {"media": [{"image": {"generatedImage": {"imageUri": "https://cdn/b.webp"}}}]}
    }
    assert extract_output_url(without_fife) == "https://cdn/b.webp"


def test_output_url_is_empty_when_the_response_carries_none():
    assert extract_output_url({"data": {"media": []}}) == ""


# --- The loop ------------------------------------------------------------

@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "worker.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


def run_one(monkeypatch, response=None, raises=None, attempts=1) -> dict:
    """Put one job through _run with the Flow client stubbed, return the row."""

    class FakeClient:
        connected = True

        async def generate_images(self, **kwargs):
            if raises:
                raise raises
            return response

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    monkeypatch.setattr(processor, "API_COOLDOWN", 0)
    monkeypatch.setattr(processor, "FLOW_PROJECT_ID", "PROJ-1")

    job = asyncio.run(jobs.create("soup"))
    job["attempts"] = attempts

    controller = processor.WorkerController()
    asyncio.run(controller._run(job))
    return asyncio.run(jobs.get(job["id"]))


def test_a_good_response_completes_the_job(monkeypatch):
    stored = run_one(monkeypatch, ok_response())

    assert stored["status"] == "COMPLETED"
    assert stored["output_url"] == CDN_URL
    assert stored["media_id"] == MEDIA_UUID


def test_a_response_with_no_url_fails_rather_than_completing_empty(monkeypatch):
    # Completing with an empty url would hand the platform a job it thinks
    # succeeded and an image it cannot download.
    stored = run_one(monkeypatch, {"data": {"media": []}})

    assert stored["status"] == "FAILED"
    assert "No image url" in stored["error_message"]


def test_a_rate_limit_is_retried(monkeypatch):
    stored = run_one(monkeypatch, {"error": "RESOURCE_EXHAUSTED: quota"}, attempts=1)

    assert stored["status"] == "PENDING"


def test_a_disconnected_browser_is_retried(monkeypatch):
    stored = run_one(monkeypatch, {"error": "NO_FLOW_KEY"}, attempts=1)

    assert stored["status"] == "PENDING"


def test_a_bad_request_is_not_retried(monkeypatch):
    # Retrying something that will fail identically every time just burns quota.
    stored = run_one(monkeypatch, {"error": "INVALID_ARGUMENT: prompt rejected"})

    assert stored["status"] == "FAILED"


def test_retries_stop_at_the_limit(monkeypatch):
    monkeypatch.setattr(processor, "MAX_RETRIES", 3)
    stored = run_one(monkeypatch, {"error": "quota exhausted"}, attempts=3)

    assert stored["status"] == "FAILED"


def test_an_exception_is_recorded_rather_than_escaping(monkeypatch):
    stored = run_one(monkeypatch, raises=RuntimeError("socket died"))

    assert stored["status"] == "FAILED"
    assert "socket died" in stored["error_message"]


def test_the_job_is_released_from_the_in_flight_set(monkeypatch):
    class FakeClient:
        connected = True

        async def generate_images(self, **kwargs):
            return ok_response()

    monkeypatch.setattr(processor, "get_flow_client", lambda: FakeClient())
    monkeypatch.setattr(processor, "API_COOLDOWN", 0)
    monkeypatch.setattr(processor, "FLOW_PROJECT_ID", "PROJ-1")

    controller = processor.WorkerController()
    job = asyncio.run(jobs.create("soup"))
    asyncio.run(controller._run(job))

    # Leaking here would shrink the concurrency budget until it reached zero
    # and the worker silently stopped claiming anything.
    assert controller._running == set()


# --- Expired tokens ------------------------------------------------------
# A 401 used to be classed as a permanent bad request, so an entire queue died
# on attempt one every time the hour-long bearer expired. The only cure anyone
# had was reloading the Flow tab by hand.

@pytest.mark.parametrize(
    "error",
    [
        "HTTP 401",
        "API_401",
        "Request had invalid authentication credentials",
        "UNAUTHENTICATED",
    ],
)
def test_an_expired_token_is_worth_another_attempt(error):
    assert any(marker in error.lower() for marker in processor.RETRYABLE)


def test_a_bad_request_is_still_not_worth_retrying():
    # The guard against widening RETRYABLE into "retry everything": a 400 fails
    # identically on every attempt and retrying it only burns quota faster.
    for error in ("HTTP 400", "No image url in response: {}"):
        assert not any(marker in error.lower() for marker in processor.RETRYABLE)


# --- Refreshing before a batch -------------------------------------------

class _FakeFlowClient:
    """Records what the worker asked of the extension, and answers plausibly."""

    connected = True

    def __init__(self) -> None:
        self.refresh_calls: list[float] = []

    async def ensure_fresh_token(self, max_age_s: float) -> dict:
        self.refresh_calls.append(max_age_s)
        return {"ok": True, "reloaded": True}


@pytest.mark.asyncio
async def test_the_tab_is_refreshed_before_a_claimed_batch(monkeypatch):
    fake = _FakeFlowClient()
    monkeypatch.setattr(processor, "get_flow_client", lambda: fake)

    controller = processor.WorkerController()
    await controller._ensure_token(3)

    assert fake.refresh_calls == [processor.TOKEN_MAX_AGE_BEFORE_BATCH]


@pytest.mark.asyncio
async def test_a_failed_refresh_does_not_stop_the_batch(monkeypatch):
    # The jobs still get their attempt: a token that is genuinely dead comes
    # back through the retry path, which is spaced and bounded, rather than
    # being dropped here where nothing would ever pick it up again.
    class Broken(_FakeFlowClient):
        async def ensure_fresh_token(self, max_age_s: float) -> dict:
            raise RuntimeError("extension went away")

    monkeypatch.setattr(processor, "get_flow_client", Broken)
    await processor.WorkerController()._ensure_token(1)
