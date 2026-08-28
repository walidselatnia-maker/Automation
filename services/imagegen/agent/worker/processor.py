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
    MAX_CONCURRENT_REQUESTS,
    MAX_RETRIES,
    POLL_INTERVAL,
    STALE_PROCESSING_TIMEOUT,
)
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
RETRYABLE = ("quota", "rate_limit", "exhausted", "resource_exhausted", "429",
             "no_flow_key", "not connected", "timeout", "503")


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

                free = MAX_CONCURRENT_REQUESTS - len(self._running)
                if free > 0 and get_flow_client().connected:
                    for job in await jobs.claim_pending(free):
                        self._running.add(job["id"])
                        asyncio.create_task(self._run(job))
            except Exception:
                logger.exception("worker loop iteration failed")

            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass

        logger.info("worker stopping")

    async def _run(self, job: dict) -> None:
        job_id = job["id"]
        try:
            result = await get_flow_client().generate_images(
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
