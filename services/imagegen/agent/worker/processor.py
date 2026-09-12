"""The worker: pending job -> Google Flow -> image URL.

One loop, one request type. The version this replaced dispatched nine request
types through an SDK operations layer that resolved character references,
chained scenes, and saved raw video bytes — all of which existed for the video
pipeline.

What is preserved exactly is the call itself: `flow_client.generate_images()`
builds the batch payload Google's own UI sends, and nothing here reshapes it.
"""
import asyncio
import logging

from agent.config import (
    API_COOLDOWN,
    FLOW_PROJECT_ID,
    IMAGE_USE_BATCH,
    MAX_CONCURRENT_REQUESTS,
    MAX_RETRIES,
    POLL_INTERVAL,
    STALE_PROCESSING_TIMEOUT,
    TOKEN_MAX_AGE_BEFORE_BATCH,
)
from agent import chrome
from agent.db import jobs
from agent.services.flow_client import get_flow_client
from agent.worker._parsing import extract_media_id, extract_output_url, is_error, error_text

logger = logging.getLogger(__name__)

ASPECT_RATIOS = {
    "VERTICAL": "IMAGE_ASPECT_RATIO_PORTRAIT",
    "HORIZONTAL": "IMAGE_ASPECT_RATIO_LANDSCAPE",
}

# Failures worth retrying: the browser is momentarily absent, or Google is
# rate-limiting. Anything else is a bad request that will fail identically on
# every attempt, and retrying it just burns the quota faster.
# "recaptcha" is here because a rejected score is a property of the browser
# session at that moment, not of the request. The extension already reloads the
# Flow tab and re-sends once with a fresh token; reaching us means that did not
# help yet, and the next attempt is spaced by API_COOLDOWN, which gives the new
# session time to settle. It used to be absent, so a 403 failed the job on
# attempt one of five while MAX_RETRIES sat there unused.
#
# Deliberately not "session_expired": that one needs a person to sign in, and
# retrying it just fails five times more slowly.
# 401 is here because an expired bearer is a property of the moment, not of
# the request: the extension reloads the Flow tab and re-sends once, and if
# that has not landed by the time we see it, the next attempt is spaced by
# API_COOLDOWN — by which point the reload has produced a token. Without it a
# whole queue died on attempt one of five every time the hour rolled over, and
# the only cure anyone had was refreshing the tab by hand.
RETRYABLE = ("quota", "rate_limit", "exhausted", "resource_exhausted", "429",
             "no_flow_key", "not connected", "timeout", "503",
             "recaptcha", "captcha_timeout",
             "http 401", "api_401", "unauthenticated", "invalid authentication")


class WorkerController:
    """Owns the polling loop and its shutdown."""

    def __init__(self) -> None:
        self._shutdown = asyncio.Event()
        self._running: set[str] = set()

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def drain(self) -> None:
        """Wait for in-flight jobs, so a redeploy does not abandon one mid-call."""
        while self._running:
            await asyncio.sleep(0.2)

    async def start(self) -> None:
        logger.info(
            "worker started (concurrency=%d, poll=%ds)", MAX_CONCURRENT_REQUESTS, POLL_INTERVAL
        )

        while not self._shutdown.is_set():
            try:
                await jobs.reset_stale(STALE_PROCESSING_TIMEOUT)

                # Chrome first, and from the queue rather than from what we
                # managed to claim. The claim below needs a connected extension,
                # the extension needs a browser, and the browser is only running
                # when something asked for it -- so a queue whose Chrome is
                # stopped would sit there forever if this read self._running.
                counts = await jobs.count_by_status()
                await chrome.reconcile(bool(counts.get("PENDING")))

                free = MAX_CONCURRENT_REQUESTS - len(self._running)
                if free > 0 and get_flow_client().connected:
                    claimed = await jobs.claim_pending(free)
                    # Refresh, then generate — in that order, every time.
                    # Skipped only while other jobs are still in flight, since
                    # reloading the tab takes their requests down with it.
                    if claimed and not self._running:
                        await self._ensure_token(len(claimed))
                    for job in claimed:
                        self._running.add(job["id"])
                        # Claimed here, before the task exists, so the idle stop
                        # cannot land between creating it and it starting.
                        chrome.hold()
                        asyncio.create_task(self._run(job))
            except Exception:
                logger.exception("worker loop iteration failed")

            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass

        logger.info("worker stopping")

    async def _ensure_token(self, job_count: int) -> None:
        """Age out the bearer before a batch goes near it.

        Never fatal: a failed refresh is worth a log line and nothing more.
        The jobs still get their attempt, and if the token really is dead they
        come back through the retry path rather than being dropped here.
        """
        try:
            result = await get_flow_client().ensure_fresh_token(TOKEN_MAX_AGE_BEFORE_BATCH)
            if result.get("reloaded"):
                logger.info("reloaded the Flow tab before %d job(s): ok=%s",
                            job_count, result.get("ok"))
            elif result.get("error"):
                logger.warning("token refresh before batch failed: %s", result["error"])
        except Exception:
            logger.exception("token refresh before batch raised")

    async def _run(self, job: dict) -> None:
        job_id = job["id"]
        try:
            client = get_flow_client()
            # The batch path signs itself inside the Flow tab; REST carries a
            # bearer token sniffed off the page, which Google stopped honouring
            # when the page stopped talking to aisandbox-pa. Both answer in the
            # same shape, so nothing below this line knows which one ran.
            generate = client.generate_images_batch if IMAGE_USE_BATCH else client.generate_images
            result = await generate(
                prompt=job["prompt"],
                # The job's own project. FLOW_PROJECT_ID is only the fallback
                # for a caller that sent none, applied when the job was queued.
                project_id=job["project_id"] or FLOW_PROJECT_ID,
                aspect_ratio=ASPECT_RATIOS.get(job["orientation"], ASPECT_RATIOS["VERTICAL"]),
            )

            if is_error(result):
                await self._handle_failure(job, error_text(result))
                return

            url = extract_output_url(result)
            if not url:
                await self._handle_failure(job, f"No image url in response: {str(result)[:300]}")
                return

            await jobs.complete(job_id, extract_media_id(result), url)
            logger.info("job %s COMPLETED", job_id[:8])

        except Exception as exc:
            logger.exception("job %s raised", job_id[:8])
            await self._handle_failure(job, str(exc))
        finally:
            self._running.discard(job_id)
            chrome.release()
            # Spacing between calls, not between loop iterations: bursts are
            # what earn a rate limit.
            await asyncio.sleep(API_COOLDOWN)

    async def _handle_failure(self, job: dict, error: str) -> None:
        job_id = job["id"]
        retryable = any(marker in error.lower() for marker in RETRYABLE)

        if retryable and job["attempts"] < MAX_RETRIES:
            logger.warning(
                "job %s attempt %d/%d failed, requeueing: %s",
                job_id[:8], job["attempts"], MAX_RETRIES, error[:200],
            )
            await jobs.requeue(job_id, error)
            return

        logger.error("job %s FAILED: %s", job_id[:8], error[:300])
        await jobs.fail(job_id, error)


_controller: WorkerController | None = None


def get_worker_controller() -> WorkerController:
    global _controller
    if _controller is None:
        _controller = WorkerController()
    return _controller
