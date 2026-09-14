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
from agent import chrome, image_models
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
# "injection" covers the request being cut off inside the Flow tab before
# Google answered -- the extension injects the fetch into the page, and a page
# still coming back from the reload we asked for, or navigating under it,
# throws it away. That is a timeout by another name and was failing jobs on
# attempt one of five; the next attempt lands on a tab that has settled.
RETRYABLE = ("quota", "rate_limit", "exhausted", "resource_exhausted", "429",
             "no_flow_key", "not connected", "timeout", "503",
             "recaptcha", "captcha_timeout",
             "http 401", "api_401", "unauthenticated", "invalid authentication",
             "no_injection_result", "injection_failed")


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
                    # Skipped while other jobs are still in flight, since
                    # reloading the tab takes their requests down with it.
                    if claimed and not self._running and self.reload_before(claimed):
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

    @staticmethod
    def reload_before(claimed: list[dict]) -> bool:
        """Whether the Flow tab is reloaded before these jobs go out.

        The REST path needs it every time: the bearer it carries is sniffed
        off the page and only a reload renews it. The batch path carries no
        bearer -- the page signs each request itself -- so there the reload
        did nothing for the request and something to the account: every image
        arrived as a fresh page load, a captcha seconds later, and a request,
        four times an article. That is what a bot looks like to reCAPTCHA.

        So on the batch path a reload is a recovery, not a routine. A job on
        its second or later attempt is one Google refused as the session was,
        and a fresh session is the known remedy. claim_pending has already
        counted the attempt by the time this sees the row, so 1 is a first try.
        """
        if not IMAGE_USE_BATCH:
            return True
        return any(int(job.get("attempts") or 0) > 1 for job in claimed)

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
            request = dict(
                prompt=job["prompt"],
                # The job's own project. FLOW_PROJECT_ID is only the fallback
                # for a caller that sent none, applied when the job was queued.
                project_id=job["project_id"] or FLOW_PROJECT_ID,
                aspect_ratio=ASPECT_RATIOS.get(job["orientation"], ASPECT_RATIOS["VERTICAL"]),
            )

            if not IMAGE_USE_BATCH:
                result = await client.generate_images(**request)
            else:
                # Pro, then 2, then Lite: walk the list and keep the first
                # model Google does not refuse by name. Anything that is not a
                # refusal -- a captcha that did not solve, a transport that
                # dropped -- is not about the model, and moving down the list
                # would spend another captcha on the same problem, so it stops
                # the walk.
                #
                # The third name is read off the Flow page the first time this
                # runs. A name read off a page and refused as INVALID_ARGUMENT
                # was not a model; it is dropped and never sent again. The two
                # known names are not dropped for that: INVALID_ARGUMENT on a
                # name Google definitely knows means something else is wrong.
                #
                # Every answer Google gives a model is recorded, and the Settings
                # page shows it. That is how a name read off a page gets
                # verified: in Automatic mode the walk never reaches it, because
                # Nano Banana 2 is unlimited, so a person picks it there and runs
                # one article.
                await image_models.ensure_discovered(client)
                choice = job.get("image_model") or image_models.AUTO
                models = image_models.plan(choice)
                if not models:
                    await self._handle_failure(job, image_models.why_empty(choice))
                    return
                result = {"error": "no image model configured"}
                for model in models:
                    result = await client.generate_images_batch(**request, image_model_name=model)
                    err = None if not is_error(result) else error_text(result)
                    image_models.record(model, err)
                    if err is None:
                        break
                    if image_models.is_refusal(err):
                        logger.warning("job %s: %s refused (%s) — trying the next model",
                                       job_id[:8], model, err[:120])
                        image_models.refused(model)
                        continue
                    if not image_models.is_known(model) and image_models.is_bad_name(err):
                        logger.warning("job %s: %s is not a model Flow knows (%s) — dropped",
                                       job_id[:8], model, err[:120])
                        continue
                    break

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
