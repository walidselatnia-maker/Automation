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
    IMAGE_USE_BATCH,
    MAX_CONCURRENT_REQUESTS,
    MAX_RETRIES,
    POLL_INTERVAL,
    STALE_PROCESSING_TIMEOUT,
    TOKEN_MAX_AGE_BEFORE_BATCH,
    VIDEO_MAX_POLLS,
    VIDEO_USE_BATCH,
    VIDEO_POLL_INTERVAL,
)
from agent import chrome, image_models, video_models
from agent.db import jobs
from agent.services.flow_client import get_flow_client
from agent.worker._parsing import (
    extract_media_handle,
    extract_media_url,
    error_text,
    extract_media_id,
    extract_operation,
    extract_output_url,
    extract_video_media_id,
    extract_video_url,
    is_error,
    rejected_the_request,
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
#: How often the project listing is read while the operation poll says
#: nothing. The listing is the heavy call (it is the whole project), so not on
#: every 15-second poll -- once a minute is enough for a clip that takes two.
LISTING_EVERY_N_POLLS = 4

RETRYABLE = ("quota", "rate_limit", "exhausted", "resource_exhausted", "429",
             "no_flow_key", "not connected", "timeout", "503",
             "recaptcha", "captcha_timeout",
             "http 401", "api_401", "unauthenticated", "invalid authentication")


class WorkerController:
    """Owns the polling loop and its shutdown."""

    def __init__(self) -> None:
        self._shutdown = asyncio.Event()
        self._running: set[str] = set()
        self._paused_reason: str | None = None

    def request_shutdown(self) -> None:
        self._shutdown.set()

    # ─── Pausing, which the watchdog does ───────────────────
    #
    # These were called and never existed. The watchdog asks for a pause in four
    # places -- a Google sign-in wall, the circuit breaker, an extension that
    # never installed, a Chrome that will not come back -- and every one of them
    # raised AttributeError instead of pausing anything:
    #
    #   AttributeError: 'WorkerController' object has no attribute 'pause'
    #
    # The tests did not catch it because test_watchdog.py drives a FakeController
    # that has the method. So the fake defined the interface and nothing checked
    # the real class against it.
    #
    # What it cost: the breaker never stopped anything, so a run of failures kept
    # submitting -- each one spending a captcha and, for video, credits. Worse,
    # the raise happens inside _check_circuit_breaker, which runs before
    # _check_extension, so a tripped breaker also took Chrome-wedge detection
    # down with it. The watchdog was not degraded, it was off.

    @property
    def paused(self) -> bool:
        return self._paused_reason is not None

    def pause(self, reason: str) -> None:
        if self._paused_reason == reason:
            return  # Already paused for this; the watchdog re-asserts every cycle.
        self._paused_reason = reason
        logger.warning("worker paused: %s — no new jobs will be claimed", reason)

    def resume(self) -> None:
        if self._paused_reason is None:
            return
        logger.info("worker resumed (was paused: %s)", self._paused_reason)
        self._paused_reason = None

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
                # A paused worker will not claim these, so they are not work
                # waiting -- and treating them as such would hold a browser up
                # at 170% for a queue nothing is allowed to touch, for as long
                # as whatever the watchdog paused for goes unattended.
                waiting = bool(counts.get("PENDING")) and not self.paused
                await chrome.reconcile(waiting)

                free = MAX_CONCURRENT_REQUESTS - len(self._running)
                if free > 0 and not self.paused and get_flow_client().connected:
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
            if job["kind"] == "video":
                await self._run_video(job)
            else:
                await self._run_image(job)

        except Exception as exc:
            logger.exception("job %s raised", job_id[:8])
            await self._handle_failure(job, str(exc))
        finally:
            self._running.discard(job_id)
            chrome.release()
            # Spacing between calls, not between loop iterations: bursts are
            # what earn a rate limit.
            await asyncio.sleep(API_COOLDOWN)

    async def _run_image(self, job: dict) -> None:
        job_id = job["id"]
        client = get_flow_client()
        # The batch path signs itself inside the Flow tab; REST carries a bearer
        # token sniffed off the page, which Google stopped honouring three days
        # after it stopped honouring the same thing for video. Both answer in the
        # same shape, so nothing below this line knows which one ran.
        request = dict(
            prompt=job["prompt"],
            # The job's own project. FLOW_PROJECT_ID is only the fallback for a
            # caller that sent none, applied when the job was queued.
            project_id=job["project_id"] or FLOW_PROJECT_ID,
            aspect_ratio=ASPECT_RATIOS.get(job["orientation"], ASPECT_RATIOS["VERTICAL"]),
        )

        if not IMAGE_USE_BATCH:
            result = await client.generate_images(**request)
        else:
            # Pro, then 2, then Lite: walk the list and keep the first model
            # Google does not refuse by name. Anything that is not a refusal --
            # a captcha that did not solve, a transport that dropped -- is not
            # about the model, and moving down the list would spend another
            # captcha on the same problem, so it stops the walk.
            result = {"error": "no image model configured"}
            for model in image_models.plan():
                result = await client.generate_images_batch(**request, image_model_name=model)
                if not is_error(result):
                    break
                if not image_models.is_refusal(error_text(result)):
                    break
                logger.warning("job %s: %s refused (%s) — trying the next model",
                               job_id[:8], model, error_text(result)[:120])
                image_models.refused(model)

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

        # The transport Flow actually uses for video now. The REST path below is
        # kept -- it is what images use and what video used until Google moved --
        # but video over REST answers INVALID_ARGUMENT, so this goes first.
        if VIDEO_USE_BATCH:
            if await self._run_video_batch(job, reference_urls, project_id):
                return
            logger.warning("job %s: batch path declined — trying REST", job_id[:8])

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
        aspect_ratio = VIDEO_ASPECT_RATIOS.get(
            job["orientation"], VIDEO_ASPECT_RATIOS["VERTICAL"]
        )
        submitted, refusals = await self._submit_video(
            client, job, media_ids, project_id, aspect_ratio
        )

        if is_error(submitted):
            await self._handle_failure(job, self._submit_error(submitted, refusals))
            return

        operation = extract_operation(submitted)
        if operation:
            await jobs.set_operation(job_id, operation)
            logger.info("job %s submitted, polling the operation", job_id[:8])
            await self._await_video(job, operation)
            return

        # No operations[]: Google answers this submit with a workflow and the
        # media record it will fill. Nothing in that can be handed to
        # check_video_status, but the media id alone is enough -- get_media
        # returns the signed URL once the video exists.
        handle = extract_media_handle(submitted)
        if handle:
            await jobs.set_operation(job_id, handle)
            logger.info(
                "job %s submitted as workflow %s, polling media %s",
                job_id[:8], handle["workflowId"][:8], handle["mediaId"][:8],
            )
            await self._await_media(job, handle)
            return

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

    async def _fetch_reference(self, url: str):
        """The image bytes and their type. {"error": ...} if it cannot be had.

        The download half of _upload_reference, on its own, because the batch
        path uploads through a different call and the two transports do not hand
        out interchangeable media ids. _upload_reference is left untouched: it is
        what images still use, and images still work.
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

        mime = response.headers.get("content-type", "image/jpeg").split(";")[0]
        return {"bytes": data, "mime": mime}

    async def _run_video_batch(self, job, reference_urls, project_id) -> bool:
        """The whole video, over the transport Flow actually uses now.

        REST video answers INVALID_ARGUMENT and will not come back: Flow Kit's
        client stopped sending video that way entirely when Flow moved to
        batchexecute. Every step here runs inside the signed-in Flow tab.

        Only the first image is used. Reference-to-video has no payload on this
        path -- Flow Kit says its own was never captured off the new UI -- so a
        reel is built from one photograph until that changes.

        Returns True if the job was settled here, either finished or failed for
        a reason the old path cannot improve on.
        """
        job_id = job["id"]
        client = get_flow_client()
        aspect = VIDEO_ASPECT_RATIOS.get(job["orientation"], VIDEO_ASPECT_RATIOS["VERTICAL"])

        fetched = await self._fetch_reference(reference_urls[0])
        if "error" in fetched:
            await self._handle_failure(job, fetched["error"])
            return True

        uploaded = await client.upload_image_batch(
            image_base64=base64.b64encode(fetched["bytes"]).decode("ascii"),
            project_id=project_id,
            mime_type=fetched["mime"],
            file_name=reference_urls[0].rsplit("/", 1)[-1][:100] or "reference.jpg",
        )
        if uploaded.get("error"):
            await self._handle_failure(job, f"Uploading the reference failed: {uploaded['error']}")
            return True

        if len(reference_urls) > 1:
            logger.warning(
                "job %s: built from 1 of %d image(s) — reference-to-video has no "
                "payload on this transport yet",
                job_id[:8], len(reference_urls),
            )

        # Which of the three models this account may use is the account's
        # business, and Google says so per model: PUBLIC_ERROR_MODEL_ACCESS_DENIED
        # means "understood, captcha fine, not for you". So walk them, and keep
        # the first one that is. Anything else is not a model problem and stops
        # the walk -- each step is a captcha.
        submitted = {}
        denied: list[str] = []
        for model in video_models.batch_plan(aspect):
            submitted = await client.generate_video_batch(
                start_image_media_id=uploaded["media_id"],
                prompt=job["prompt"],
                project_id=project_id,
                aspect_ratio=aspect,
                model_key=model,
            )
            if not submitted.get("error"):
                video_models.remember_batch(aspect, model)
                break
            if not video_models.access_denied(submitted["error"]):
                break
            denied.append(model)
            logger.warning("job %s: account may not use %s — trying the next model",
                           job_id[:8], model)
            video_models.forget_batch(aspect)

        if submitted.get("error"):
            detail = submitted["error"]
            if video_models.out_of_credits(detail):
                # Not a hiccup: the account's video credits are spent. A retry
                # is another upload and another captcha for the same answer.
                message = ("This Google account has no video credits left on Flow. "
                           "Nothing was generated. Wait for the credits to reset "
                           "or add more, then run the reel again.")
                logger.error("job %s FAILED: %s", job_id[:8], message)
                await jobs.fail(job_id, message)
                return True
            if denied and len(denied) == len(video_models.BATCH_CANDIDATES):
                detail = (
                    f"This Google account is not allowed to use any of the video "
                    f"models Flow offers ({', '.join(denied)}). That is a plan or "
                    f"quota limit on the account, not something this service can "
                    f"route around.\n\n{detail}"
                )
            await self._handle_failure(job, f"Video submit failed: {detail}")
            return True

        operation_id = submitted["operation_id"]
        listing_project = submitted.get("project_id") or project_id
        await jobs.set_operation(job_id, {"operationId": operation_id})
        logger.info("job %s submitted on the batch path, operation %s",
                    job_id[:8], operation_id[:8])

        await self._await_video_batch(job, operation_id, listing_project)
        return True

    async def _await_video_batch(self, job, operation_id: str, project_id: str) -> None:
        """Poll the operation, then read the finished video's URL.

        Measured on the deployed container: for this account the operation poll
        never carries a status at all -- every answer is

            [opId, None, None, None, None, [..., [4, "Media not found."]]]

        while the finished video is sitting in the project. So the poll cannot
        be the only done-signal. When it says nothing, the project listing is
        checked instead, once a minute, and the video is taken from there.
        """
        job_id = job["id"]
        client = get_flow_client()

        seen_status = object()  # so the very first poll is always logged
        watching_listing = False
        listing_misses = 0

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

            state = await client.check_operation_batch(operation_id)
            if state.get("error"):
                logger.warning("job %s poll %d: %s", job_id[:8], attempt, state["error"])
                continue

            # Once per change, not once per poll: eighty polls of "still
            # pending" is noise, and a video that never leaves its first status
            # is the thing worth seeing.
            if state.get("status") != seen_status:
                seen_status = state.get("status")
                logger.info(
                    "job %s poll %d: operation is %s%s",
                    job_id[:8], attempt, seen_status or "?",
                    f" ({state['complaint']})" if state.get("complaint") else "",
                )
                if state.get("raw"):
                    logger.warning("job %s poll %d: no status in the answer: %s",
                                   job_id[:8], attempt, state["raw"])

            if state.get("done"):
                logger.info("job %s: operation finished — looking up the media",
                            job_id[:8])
            elif state.get("status"):
                continue  # Google says it is still working; believe it
            else:
                # No status at all. Nothing more will come from this poll, so
                # the listing is where a finished video shows up.
                if not watching_listing:
                    watching_listing = True
                    logger.info("job %s: the poll carries no status — watching the "
                                "project listing for the video instead", job_id[:8])
                if attempt % LISTING_EVERY_N_POLLS:
                    continue

            # The operation record does not carry the media id -- the third
            # uuid in it is the scene -- so it is read out of the project listing.
            found = await client.find_operation_media_batch(operation_id, project_id)
            if found.get("error") or not found.get("media_id"):
                listing_misses += 1
                if state.get("done") or listing_misses == 1:
                    logger.warning("job %s: no media for the operation in the project "
                                   "yet (%s)", job_id[:8], found.get("error") or "not in listing")
                continue

            urls = await client.get_media_urls_batch(found["media_id"])
            if urls.get("error"):
                logger.warning("job %s: %s", job_id[:8], urls["error"])
                continue
            if not urls.get("video_url"):
                continue  # in the project, still rendering

            await jobs.complete(job_id, found["media_id"], urls["video_url"])
            logger.info("job %s COMPLETED", job_id[:8])
            return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        await self._handle_failure(
            job,
            f"Video did not finish within {waited}s ({VIDEO_MAX_POLLS} polls). "
            "Raise VIDEO_MAX_POLLS if generation is legitimately slower.",
        )

    async def _submit_video(self, client, job, media_ids, project_id, aspect_ratio):
        """Submit the video, working out which model name Flow still accepts.

        `videoModelKey` is the one field in this body that is a bare string
        Google retires on its own schedule, and every reel here started failing
        with INVALID_ARGUMENT -- Flow refusing the request rather than the
        images. Naming the replacement in a setting only works while the guess
        is right and has to be made again by hand each time Google moves, so the
        names are a list and this walks it.

        Reference video is tried before image video, because reading all four
        photographs is the point of a reel. Its refusal is not fatal: a video
        built from the first image is worse than the one asked for and a great
        deal better than none, which is also what Flow Kit does here.

        Only a refusal advances the list. A rate limit, a dropped browser or a
        rejected captcha are about when the request was sent, and walking past
        them would spend a reel's quality -- and a captcha per step -- on
        something the ordinary retry clears.

        Returns the last response and every refusal along the way, so a reel
        that exhausts the list can say what it tried rather than repeating one
        opaque error.
        """
        job_id = job["id"]
        refusals: list[str] = []
        submitted: dict = {}

        for kind, model in video_models.plan(aspect_ratio):
            if kind == "r2v":
                submitted = await client.generate_video_from_references(
                    reference_media_ids=media_ids,
                    prompt=job["prompt"],
                    project_id=project_id,
                    aspect_ratio=aspect_ratio,
                    model_key=model,
                )
            else:
                submitted = await client.generate_video_from_image(
                    start_image_media_id=media_ids[0],
                    prompt=job["prompt"],
                    project_id=project_id,
                    # No scenes here. The captured payload carries a unique id
                    # in this slot, and the job id is already unique per video.
                    scene_id=job_id,
                    aspect_ratio=aspect_ratio,
                    model_key=model,
                )

            if not is_error(submitted):
                if kind == "i2v" and len(media_ids) > 1:
                    logger.warning(
                        "job %s: built from 1 of %d image(s) — reference video is "
                        "refused, so the other %d were not read",
                        job_id[:8], len(media_ids), len(media_ids) - 1,
                    )
                video_models.remember(aspect_ratio, kind, model)
                return submitted, refusals

            if not rejected_the_request(submitted):
                # Transient. Stop here and let the retry policy have it, rather
                # than burning the rest of the list on a bad minute.
                return submitted, refusals

            refusals.append(f"{kind}/{model}: {error_text(submitted)[:160]}")
            logger.warning(
                "job %s: Flow refused %s (%s) — trying the next model",
                job_id[:8], model, kind,
            )
            # A remembered name that starts being refused has been retired too.
            video_models.forget(aspect_ratio)

        return submitted, refusals

    @staticmethod
    def _submit_error(submitted: dict, refusals: list[str]) -> str:
        """One message naming everything that was refused.

        A reel that has exhausted the list is the answer to a bigger question
        than "this one failed": every model name this service knows was refused,
        which says the old endpoint is closed to this account for video rather
        than that one name went stale. That deserves to be legible in the
        failure rather than inferred from repeats.
        """
        if len(refusals) <= 1:
            return error_text(submitted)

        tried = "\n".join(f"  - {line}" for line in refusals)
        return (
            f"Flow refused every video model this service knows ({len(refusals)} "
            f"tried). That is not one stale name — it means this account can no "
            f"longer generate video through this endpoint at all.\n\n{tried}"
        )

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
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

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

    async def _await_media(self, job: dict, handle: dict) -> None:
        """Poll one media id until it carries a URL, or the budget runs out.

        The same budget as _await_video on purpose: this is the same wait for
        the same video, asked a different way, and giving it its own timeout
        would mean two numbers to keep in step.
        """
        job_id = job["id"]
        media_id = handle["mediaId"]
        client = get_flow_client()
        last = {}

        for attempt in range(1, VIDEO_MAX_POLLS + 1):
            await asyncio.sleep(VIDEO_POLL_INTERVAL)
            await jobs.touch(job_id)  # still alive -- do not hand this back to the queue

            # As in _await_video: the handle is stored, so a shutdown here
            # resumes on the next attempt rather than paying for a second video.
            if self._shutdown.is_set():
                logger.info("job %s: polling interrupted by shutdown", job_id[:8])
                return

            status = await client.get_media(media_id)

            # A media id that is not ready can answer 404 for a while. That is
            # the wait, not a failure -- only a hard error ends it.
            if is_error(status) and status.get("status") not in (404, 429):
                await self._handle_failure(job, error_text(status))
                return

            last = status
            url = extract_media_url(status)
            if url:
                await jobs.complete(job_id, media_id, url)
                logger.info("job %s COMPLETED after %d media poll(s)", job_id[:8], attempt)
                return

        waited = VIDEO_MAX_POLLS * VIDEO_POLL_INTERVAL
        logger.error(
            "job %s: media %s never carried a URL. Last body: %s",
            job_id[:8], media_id[:8], json.dumps(last, default=str),
        )
        await self._handle_failure(
            job,
            f"The video was submitted and Google created media {media_id}, but it "
            f"carried no URL within {waited}s ({VIDEO_MAX_POLLS} polls). Raise "
            f"VIDEO_MAX_POLLS if generation is legitimately slower.\n\n"
            f"{json.dumps(last, default=str)[:6000]}",
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
