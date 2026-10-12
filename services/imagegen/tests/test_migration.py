"""Opening a job database left by an earlier deploy.

SCHEMA is CREATE TABLE IF NOT EXISTS, which does nothing to a table that is
already there. A column added to the definition therefore never reaches a
database from a previous release, and the failure is not a migration error — it
is a KeyError at run time on a column the worker is certain exists.
"""
import asyncio
import sqlite3

import pytest

from agent.db import jobs, schema

OLD_SCHEMA = """
CREATE TABLE job (
    id            TEXT PRIMARY KEY,
    prompt        TEXT NOT NULL,
    orientation   TEXT NOT NULL DEFAULT 'VERTICAL',
    status        TEXT NOT NULL DEFAULT 'PENDING',
    media_id      TEXT,
    output_url    TEXT,
    error_message TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO job (id, prompt, status) VALUES ('old-1', 'a bowl of soup', 'COMPLETED');
"""


@pytest.fixture
def old_database(tmp_path, monkeypatch):
    """A database as the previous release left it, then opened by this one."""
    path = tmp_path / "flow_agent.db"
    connection = sqlite3.connect(path)
    connection.executescript(OLD_SCHEMA)
    connection.commit()
    connection.close()

    monkeypatch.setattr(schema, "DB_PATH", path)
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    yield path
    asyncio.run(schema.close_db())


def test_the_column_is_added(old_database):
    async def columns():
        db = await schema.get_db()
        async with db.execute("PRAGMA table_info(job)") as cursor:
            return [row["name"] for row in await cursor.fetchall()]

    assert "project_id" in asyncio.run(columns())


def test_the_existing_job_survives(old_database):
    stored = asyncio.run(jobs.get("old-1"))

    assert stored is not None
    assert stored["prompt"] == "a bowl of soup"
    assert stored["status"] == "COMPLETED"


def test_an_old_row_reads_as_empty_rather_than_null(old_database):
    # The worker does `job["project_id"] or FLOW_PROJECT_ID`, so an old row has
    # to fall through to the fallback rather than send None to Google.
    assert asyncio.run(jobs.get("old-1"))["project_id"] == ""


def test_new_jobs_carry_their_project(old_database):
    job = asyncio.run(jobs.create("seared salmon", "VERTICAL", "proj-42"))

    assert job["project_id"] == "proj-42"


def test_opening_twice_is_safe(old_database):
    asyncio.run(schema.init_db())

    async def columns():
        db = await schema.get_db()
        async with db.execute("PRAGMA table_info(job)") as cursor:
            return [row["name"] for row in await cursor.fetchall()]

    names = asyncio.run(columns())
    assert names.count("project_id") == 1


CHECKED_SCHEMA = """
CREATE TABLE job (
    id            TEXT PRIMARY KEY,
    prompt        TEXT NOT NULL,
    orientation   TEXT NOT NULL DEFAULT 'VERTICAL'
                  CHECK(orientation IN ('VERTICAL','HORIZONTAL')),
    project_id    TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'PENDING',
    media_id      TEXT,
    output_url    TEXT,
    error_message TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_job_status ON job(status, created_at);
INSERT INTO job (id, prompt, orientation, project_id, status) VALUES ('old-2', 'a pie', 'HORIZONTAL', 'proj-7', 'COMPLETED');
"""


def test_a_table_that_only_allowed_two_orientations_takes_the_pin_shape(tmp_path, monkeypatch):
    path = tmp_path / "flow_agent.db"
    connection = sqlite3.connect(path)
    connection.executescript(CHECKED_SCHEMA)
    connection.commit()
    connection.close()
    monkeypatch.setattr(schema, "DB_PATH", path)
    monkeypatch.setattr(schema, "_db_connection", None)
    asyncio.run(schema.init_db())
    try:
        old = asyncio.run(jobs.get("old-2"))
        assert old["prompt"] == "a pie" and old["orientation"] == "HORIZONTAL" and old["project_id"] == "proj-7"
        pin = asyncio.run(jobs.create("a pin", "PORTRAIT_3_4", "proj-7"))
        assert pin["orientation"] == "PORTRAIT_3_4"
        # Opening again leaves the rebuilt table alone.
        asyncio.run(schema.init_db())
        assert asyncio.run(jobs.get("old-2"))["status"] == "COMPLETED"
    finally:
        asyncio.run(schema.close_db())
