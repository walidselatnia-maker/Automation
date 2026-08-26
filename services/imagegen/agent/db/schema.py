"""SQLite schema — async via aiosqlite.

One table. This service exists to turn a prompt into an image URL, and a job
row is the whole of that: what was asked for, how it went, and where the
result lives.

The version this replaced modelled a video production pipeline — projects
holding videos holding scenes holding requests — and /v1 had to fabricate a
singleton project and video on every call just to have somewhere to hang a
scene. That scaffolding held up nothing once the video half was removed.
"""
import asyncio
import logging

import aiosqlite

from agent.config import DB_PATH

logger = logging.getLogger(__name__)

_db_connection: aiosqlite.Connection | None = None
_db_lock = asyncio.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS job (
    id            TEXT PRIMARY KEY,
    prompt        TEXT NOT NULL,
    orientation   TEXT NOT NULL DEFAULT 'VERTICAL'
                  CHECK(orientation IN ('VERTICAL','HORIZONTAL')),
    status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
    media_id      TEXT,
    output_url    TEXT,
    error_message TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, created_at);
"""


async def get_db() -> aiosqlite.Connection:
    """The shared connection, opened on first use."""
    global _db_connection

    if _db_connection is None:
        async with _db_lock:
            if _db_connection is None:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                _db_connection = await aiosqlite.connect(DB_PATH)
                _db_connection.row_factory = aiosqlite.Row
                await _db_connection.execute("PRAGMA journal_mode = WAL")
                await _db_connection.execute("PRAGMA foreign_keys = ON")
                await _db_connection.execute("PRAGMA busy_timeout = 5000")
                await _db_connection.commit()

    return _db_connection


async def init_db() -> None:
    db = await get_db()
    await db.executescript(SCHEMA)
    await db.commit()
    logger.info("Database ready at %s", DB_PATH)


async def close_db() -> None:
    global _db_connection

    if _db_connection is not None:
        await _db_connection.close()
        _db_connection = None
