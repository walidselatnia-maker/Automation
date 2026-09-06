"""The worker: pending job -> Google Flow -> image or video URL.

One loop, two request kinds. What is preserved exactly is the call itself:
`generate_images()` and `generate_video_from_references()` build the payloads
Google's own UI sends, and nothing here reshapes them.

Images resolve in one call. Video does not: the submit returns an operation
handle, and the result arrives minutes later from a separate status endpoint.
That polling happens inside the job's own task rather than by returning it to
the queue, so a half-generated video is never re-submitted and paid for twice.
"""
import asyncio
import base64
import json
import logging

import httpx

from agent.config import (
    API_COOLDOWN,
    FLOW_PROJECT_ID,
    MAX_CONCURRENT_REQUESTS,
    MAX_RETRIES,
    POLL_INTERVAL,
    STALE_PROCESSING_TIMEOUT,
    TOKEN_MAX_AGE_BEFORE_BATCH,
    VIDEO_MAX_POLLS,
    VIDEO_POLL_INTERVAL,
)
from agent.db import jobs
from agent.services.flow_client import get_flow_client
from agent.worker._parsing import (
    error_text,
    extract_media_id,
    extract_operation,
    extract_output_url,
    extract_video_media_id,
    extract_video_url,
    is_error,
    video_failed,
)

logger = logging.getLogger(__name__)

ASPECT_RATIOS = {
    "VERTICAL": "IMAGE_ASPECT_RATIO_PORTRAIT",
    "HORIZONTAL": "IMAGE_ASPECT_RATIO_LANDSCAPE",
}

VIDEO_ASPECT_RATIOS = {
    "VERTICAL": "VIDEO_ASPECT_RATIO_PORTRAIT",
    "HORIZONTAL": "VIDEO_ASPECT_RATIO_LANDSCAPE",
}

# A reference image is fetched over the public internet from the site that
# published it, so it is bounded: a redirect loop or a wrong URL must fail the
# job rather than hold a worker slot open.
REFERENCE_DOWNLOAD_TIMEOUT = 60
MAX_REFERENCE_BYTES = 12 * 1024 * 1024

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
            if job["kind"] == "video":
                await self._run_video(job)
            else:
                await self._run_image(job)

        except Exception as exc:
            logger.exception("job %s raised", job_id[:8])
            await self._handle_failure(job, str(exc))
        finally:
            self._running.discard(job_id)
            # Spacing between calls, not between loop iterations: bursts are
            # what earn a rate limit.
            await asyncio.sleep(API_COOLDOWN)

    async def _run_image(self, job: dict) -> None:
        job_id = job["id"]
        result = await get_flow_client().generate_images(
            prompt=job["prompt"],
            # The job's own project. FLOW_PROJECT_ID is only the fallback for a
            # caller that sent none, applied when the job was queued.
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

    async def _run_video(self, job: dict) -> None:
        """Reference images -> Flow -> a finished video URL.

        Three stages in one task: upload each reference so Google has a media
        id for it, submit the generation, then poll the operation until it
        carries a URL. The polling stays here rather than going back through
        the queue, because a requeued video would be submitted again -- and a
        second submission is a second video paid for.
        """
        job_id = job["id"]
        client = get_flow_client()
        project_id = job["project_id"] or FLOW_PROJECT_ID

        try:
            reference_urls = json.loads(job["reference_urls"] or "[]")
        except json.JSONDecodeError:
            await jobs.fail(job_id, "reference_urls is not valid JSON")
            return

        if not reference_urls:
            await jobs.fail(job_id, "A video needs at least one reference image")
            return

        # -- Stage 1: give Google the reference images. ----------------------
        media_ids: list[str] = []
        for url in reference_urls:
            uploaded = await self._upload_reference(client, url, project_id)
            if isinstance(uploaded, dict):
                await self._handle_failure(job, uploaded["error"])
                return
            media_ids.append(uploaded)

        logger.info("job %s uploaded %d reference image(s)", job_id[:8], len(media_ids))

        # -- Stage 2: submit. ------------------------------------------------
        submitted = await client.generate_video_from_references(
            reference_media_ids=media_ids,
            prompt=job["prompt"],
            project_id=project_id,
            aspect_ratio=VIDEO_ASPECT_RATIOS.get(
                job["orientation"], VIDEO_ASPECT_RATIOS["VERTICAL"]
            ),
        )

        if is_error(submitted):
            await self._handle_failure(job, error_text(submitted))
            return

        operation = extract_operation(submitted)
        if not operation:
            # Whatever came back was accepted by Flow -- credits were spent and
            # a workflow exists on their side -- so this is a response we do not
            # know how to read, not a refusal. Log the whole thing: 300
            # characters of a truncated dict is exactly enough to see that the
            # shape is wrong and not enough to see what the shape is, and this
            # is expensive to reproduce.
            logger.error(
                "job %s: cannot read the video submit response. Full body: %s",
                job_id[:8],
                json.dumps(submitted, default=str),
            )
            data = submitted.get("data", submitted)
            shape = ",".join(sorted(data.keys())) if isinstance(data, dict) else type(data).__name__
            await self._handle_failure(
                job,
                f"Video submitted and accepted, but the reply was not in a shape this "
                f"service can read, so nothing polled for the result. The generation may "
                f"still have run and the credits are spent. Reply carried: {shape}.\n\n"
                f"{json.dumps(submitted, default=str)[:6000]}",
            )
            return

        await jobs.set_operation(job_id, operation)
        logger.info("job %s submitted, polling for the video", job_id[:8])

        # -- Stage 3: wait. --------------------------------------------------
        await self._await_video(job, operation)

    async def _upload_reference(self, client, url: str, project_id: str):
        """One reference image, fetched and handed to Flow.

        Returns the media id, or a {"error": ...} dict for the caller to route
        through the retry policy -- a transient fetch failure is worth the same
        treatment as a transient Flow failure, not a different one.
        """
        try:
            async with httpx.AsyncClient(
                timeout=REFERENCE_DOWNLOAD_TIMEOUT, follow_redirects=True
            ) as http:
                response = await http.get(url)
                response.raise_for_status()
                data = response.content
        except Exception as exc:
            return {"error": f"Could not fetch reference image {url}: {exc}"}

        if not data:
            return {"error": f"Reference image {url} was empty"}
        if len(data) > MAX_REFERENCE_BYTES:
            return {"error": f"Reference image {url} is {len(data)} bytes, over the limit"}

        result = await client.upload_image(
            image_base64=base64.b64encode(data).decode("ascii"),
            mime_type=response.headers.get("content-type", "image/jpeg").split(";")[0],
            project_id=project_id,
            file_name=url.rsplit("/", 1)[-1][:100] or "reference.jpg",
        )

        if is_error(result):
            return {"error": f"Uploading {url} to Flow failed: {error_text(result)}"}

        media_id = result.get("_mediaId")
        if not media_id:
            return {"error": f"Flow returned no mediaId for {url}"}

        return media_id

    async def _await_video(self, job: dict, operation: dict) -> None:
        """Poll one operation until it resolves, fails, or runs out of budget."""
        job_id = job["id"]
        client = get_flow_client()

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)

            # A shutdown mid-generation leaves the job PROCESSING with its
            # operation stored, so reset_stale returns it to the queue and the
            # next attempt resumes rather than paying for a second video.
            if self._shutdown.is_set():
                logger.info("job %s: polling interrupted by shutdown", job_id[:8])
                return

            status = await client.check_video_status([operation])

            if is_error(status):
                await self._handle_failure(job, error_text(status))
                return

            failure = video_failed(status)
            if failure:
                await self._handle_failure(job, f"Video generation failed: {failure}")
                return

            url = extract_video_url(status)
            if url:
                await jobs.complete(job_id, extract_video_media_id(status), url)
                logger.info("job %s COMPLETED after %d poll(s)", job_id[:8], attempt)
                return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        await self._handle_failure(
            job,
            f"Video did not finish within {waited}s ({VIDEO_MAX_POLLS} polls). "
            "Raise VIDEO_MAX_POLLS if generation is legitimately slower.",
        )

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
