"""Job rows: create, claim, finish.

Deliberately not a generic table-name-driven CRUD layer. There is one table and
five things anyone does to it, so each of them is a named function whose SQL is
visible at the call site.
"""
import json
import logging
import uuid
from typing import Optional

from agent.db.schema import get_db

logger = logging.getLogger(__name__)

_NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"


async def create(prompt: str, orientation: str = "VERTICAL", project_id: str = "",
                 image_model: str = "auto",
                 reference_urls: list[str] | None = None) -> dict:
    """Queue a generation. Returns the new row.

    reference_urls sit in the same column video jobs use: an image that
    follows a photo and a clip that follows one are the same idea.
    """
    job_id = str(uuid.uuid4())
    db = await get_db()
    await db.execute(
        "INSERT INTO job (id, prompt, orientation, project_id, image_model, reference_urls) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (job_id, prompt, orientation, project_id, image_model or "auto",
         json.dumps(list(reference_urls or []))),
    )
    await db.commit()
    return await get(job_id)


async def create_video(
    prompt: str,
    reference_urls: list[str],
    project_id: str = "",
    orientation: str = "VERTICAL",
    character_media_id: str | None = None,
    voice_media_id: str | None = None,
) -> dict:
    """Queue one clip from reference images and, optionally, a presenter and voice."""
    job_id = str(uuid.uuid4())
    db = await get_db()
    await db.execute(
        """INSERT INTO job (id, prompt, orientation, project_id, kind, reference_urls,
                            character_media_id, voice_media_id)
                VALUES (?, ?, ?, ?, 'video', ?, ?, ?)""",
        (job_id, prompt, orientation, project_id, json.dumps(reference_urls),
         character_media_id or None, voice_media_id or None),
    )
    await db.commit()
    return await get(job_id)


async def set_operation(job_id: str, operation: dict) -> None:
    """Record the Flow operation a submitted video is waiting on.

    Stored rather than held in memory so a worker that restarts mid-generation
    resumes polling the operation instead of paying for the video twice.
    """
    db = await get_db()
    await db.execute(
        f"UPDATE job SET operation_json = ?, updated_at = {_NOW} WHERE id = ?",
        (json.dumps(operation), job_id),
    )
    await db.commit()


async def get(job_id: str) -> Optional[dict]:
    db = await get_db()
    async with db.execute("SELECT * FROM job WHERE id = ?", (job_id,)) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def claim_pending(limit: int) -> list[dict]:
    """Move up to `limit` PENDING jobs to PROCESSING and return them.

    The UPDATE ... WHERE id IN (SELECT ...) is one statement on purpose: two
    workers reading then writing separately would both see the same PENDING row
    and generate the image twice, which costs real Flow credits.
    """
    db = await get_db()
    async with db.execute(
        f"""UPDATE job SET status = 'PROCESSING', attempts = attempts + 1, updated_at = {_NOW}
             WHERE id IN (
               SELECT id FROM job WHERE status = 'PENDING' ORDER BY created_at LIMIT ?
             )
         RETURNING *""",
        (limit,),
    ) as cursor:
        rows = await cursor.fetchall()
    await db.commit()
    return [dict(r) for r in rows]


async def complete(job_id: str, media_id: Optional[str], output_url: str) -> None:
    db = await get_db()
    await db.execute(
        f"""UPDATE job SET status = 'COMPLETED', media_id = ?, output_url = ?,
                           error_message = NULL, updated_at = {_NOW}
             WHERE id = ?""",
        (media_id, output_url, job_id),
    )
    await db.commit()


async def fail(job_id: str, error: str) -> None:
    """Record why a job died.

    8000 characters, not 1000. A Flow response this service cannot read is the
    single most expensive thing to diagnose here -- the generation is paid for
    and the reply is the only evidence of what it did -- and 1000 characters
    cut the one that mattered off mid-field. This column is the only copy that
    reaches the platform.
    """
    db = await get_db()
    await db.execute(
        f"UPDATE job SET status = 'FAILED', error_message = ?, updated_at = {_NOW} WHERE id = ?",
        (error[:8000], job_id),
    )
    await db.commit()


#: What a job stopped by a person says. Not a failure of the service: the
#: watchdog's breaker does not count it.
STOPPED_BY_HAND = "Stopped by hand."


async def stop_images(reason: str = STOPPED_BY_HAND) -> int:
    """Fail every image job not yet finished. Answers how many.

    A job already in Flow's hands cannot be taken back, so its worker may still
    record a result afterwards; the caller has stopped waiting for it either way.
    """
    db = await get_db()
    async with db.execute(
        f"""UPDATE job SET status = 'FAILED', error_message = ?, updated_at = {_NOW}
             WHERE status IN ('PENDING', 'PROCESSING') AND COALESCE(kind, 'image') = 'image'""",
        (reason,),
    ) as cursor:
        count = cursor.rowcount
    await db.commit()
    return count


async def requeue(job_id: str, error: str) -> None:
    """Return a job to the queue after a retryable failure."""
    db = await get_db()
    await db.execute(
        f"UPDATE job SET status = 'PENDING', error_message = ?, updated_at = {_NOW} WHERE id = ?",
        (error[:8000], job_id),
    )
    await db.commit()


async def touch(job_id: str) -> None:
    """Say a PROCESSING job is still being worked on.

    reset_stale reads updated_at as a pulse: a PROCESSING job that has not been
    touched for the cutoff is taken for one whose process died, and put back in
    the queue. That is right for an image, which is done in ninety seconds. A
    video is polled for up to twenty minutes, and at ten it was being returned
    to the queue mid-generation, claimed again, and submitted again -- a second
    video, paid for, ten minutes after the first, every ten minutes.

    So a poll loop touches its job each round. A job whose process really has
    died stops being touched, and the reset still catches it.
    """
    db = await get_db()
    await db.execute(
        f"UPDATE job SET updated_at = {_NOW} WHERE id = ? AND status = 'PROCESSING'",
        (job_id,),
    )
    await db.commit()


async def reset_stale(cutoff_seconds: int) -> int:
    """Return jobs stuck in PROCESSING to the queue.

    A job only reaches PROCESSING inside the worker, so one that has sat there
    past the cutoff means the process died mid-flight. Without this they would
    stay PROCESSING forever and the caller would poll a job that cannot move.
    """
    db = await get_db()
    async with db.execute(
        f"""UPDATE job SET status = 'PENDING', updated_at = {_NOW}
             WHERE status = 'PROCESSING'
               AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
         RETURNING id""",
        (f"-{cutoff_seconds} seconds",),
    ) as cursor:
        rows = await cursor.fetchall()
    await db.commit()

    if rows:
        logger.warning("Requeued %d job(s) stuck in PROCESSING", len(rows))
    return len(rows)


async def next_project_id() -> str:
    """The project of the job the worker will claim next, or '' if none waits.

    Read by the extension when Chrome starts, so the first page it loads is
    the one the work needs.
    """
    db = await get_db()
    async with db.execute(
        "SELECT project_id FROM job WHERE status = 'PENDING' ORDER BY created_at LIMIT 1"
    ) as cursor:
        row = await cursor.fetchone()
    return (row[0] if row and row[0] else "") or ""


async def count_by_status() -> dict[str, int]:
    db = await get_db()
    async with db.execute("SELECT status, COUNT(*) AS n FROM job GROUP BY status") as cursor:
        rows = await cursor.fetchall()
    return {r["status"]: r["n"] for r in rows}


async def recent_finished(limit: int = 10, within_seconds: int = 0) -> list[dict]:
    """Most recently finished jobs, newest first.

    The watchdog reads these to spot a Google sign-in wall: a run of failures
    whose messages name an auth problem means Chrome is sitting on a login
    page, and restarting it would only loop.

    `within_seconds` bounds how far back that reaches, and the watchdog's
    circuit breaker needs it. This table outlives the container, so without a
    bound a run of failures is permanent evidence: five failed jobs would trip
    the breaker thirty seconds after every start, for ever, long after whatever
    caused them was fixed. 0 keeps the old behaviour for callers that want the
    whole history.
    """
    db = await get_db()
    sql = """SELECT * FROM job WHERE status IN ('COMPLETED', 'FAILED')
               AND COALESCE(error_message, '') != ?"""
    params: list = [STOPPED_BY_HAND]
    if within_seconds > 0:
        sql += " AND updated_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
        params.append(f"-{int(within_seconds)} seconds")
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)

    async with db.execute(sql, tuple(params)) as cursor:
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def queued_since(timestamp: str) -> bool:
    """Whether a job was queued at or after `timestamp` and has not finished.

    The watchdog asks this after a sign-in wall: the platform moves a job to
    another Google account by queuing it again, and that job must run rather
    than wait behind the wall the last account hit.
    """
    db = await get_db()
    async with db.execute(
        "SELECT 1 FROM job WHERE status IN ('PENDING', 'PROCESSING') AND created_at >= ? LIMIT 1",
        (timestamp,),
    ) as cursor:
        return await cursor.fetchone() is not None
