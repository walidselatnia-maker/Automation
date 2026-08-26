"""Job rows: create, claim, finish.

Deliberately not a generic table-name-driven CRUD layer. There is one table and
five things anyone does to it, so each of them is a named function whose SQL is
visible at the call site.
"""
import logging
import uuid
from typing import Optional

from agent.db.schema import get_db

logger = logging.getLogger(__name__)

_NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"


async def create(prompt: str, orientation: str = "VERTICAL") -> dict:
    """Queue a generation. Returns the new row."""
    job_id = str(uuid.uuid4())
    db = await get_db()
    await db.execute(
        "INSERT INTO job (id, prompt, orientation) VALUES (?, ?, ?)",
        (job_id, prompt, orientation),
    )
    await db.commit()
    return await get(job_id)


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
    db = await get_db()
    await db.execute(
        f"UPDATE job SET status = 'FAILED', error_message = ?, updated_at = {_NOW} WHERE id = ?",
        (error[:1000], job_id),
    )
    await db.commit()


async def requeue(job_id: str, error: str) -> None:
    """Return a job to the queue after a retryable failure."""
    db = await get_db()
    await db.execute(
        f"UPDATE job SET status = 'PENDING', error_message = ?, updated_at = {_NOW} WHERE id = ?",
        (error[:1000], job_id),
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


async def count_by_status() -> dict[str, int]:
    db = await get_db()
    async with db.execute("SELECT status, COUNT(*) AS n FROM job GROUP BY status") as cursor:
        rows = await cursor.fetchall()
    return {r["status"]: r["n"] for r in rows}


async def recent_finished(limit: int = 10) -> list[dict]:
    """Most recently finished jobs, newest first.

    The watchdog reads these to spot a Google sign-in wall: a run of failures
    whose messages name an auth problem means Chrome is sitting on a login
    page, and restarting it would only loop.
    """
    db = await get_db()
    async with db.execute(
        """SELECT * FROM job WHERE status IN ('COMPLETED', 'FAILED')
            ORDER BY updated_at DESC LIMIT ?""",
        (limit,),
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]
