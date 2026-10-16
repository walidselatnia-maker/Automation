"""A Flow project given as its whole address, opened exactly as given."""
import asyncio

import pytest

from agent import project_links
from agent.db import schema

ID = "dafc82d0-a6e2-4c2d-a6cd-8f495a1343b8"
URL = f"https://flow.google.com/u/2/project/{ID}"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(schema, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(schema, "_db_connection", None)
    monkeypatch.setattr(project_links, "_links", {})
    monkeypatch.setattr(project_links, "_loaded", False)
    asyncio.run(schema.init_db())
    yield
    asyncio.run(schema.close_db())


def test_the_id_is_read_from_the_address_and_the_address_kept():
    assert project_links.split(URL) == (ID, URL)
    assert project_links.split(ID.upper()) == (ID, "")
    assert project_links.split(f"https://labs.google/fx/tools/flow/project/{ID}?x=1#top") == (
        ID, f"https://labs.google/fx/tools/flow/project/{ID}?x=1")

    assert asyncio.run(project_links.resolve(URL)) == ID
    assert asyncio.run(project_links.url_for(ID)) == URL


def test_an_address_off_flow_is_not_kept():
    assert project_links.split(f"https://evil.example/project/{ID}") == (ID, "")
    assert project_links.split(f"http://flow.google.com/project/{ID}") == (ID, "")


def test_a_bare_id_keeps_the_address_given_before():
    asyncio.run(project_links.resolve(URL))
    assert asyncio.run(project_links.resolve(ID)) == ID
    assert asyncio.run(project_links.url_for(ID)) == URL


def test_the_address_survives_a_restart():
    asyncio.run(project_links.resolve(URL))
    project_links._links.clear()
    project_links._loaded = False
    assert asyncio.run(project_links.url_for(ID)) == URL


def test_a_job_queued_with_the_address_goes_to_the_project_id(monkeypatch):
    from fastapi.testclient import TestClient
    from agent import chrome
    from agent.api import v1
    from agent.db import jobs
    from agent.main import app

    monkeypatch.setattr(chrome, "wanted_running", lambda: False)
    monkeypatch.setattr(v1, "require_api_key", lambda: None, raising=False)
    app.dependency_overrides[v1.require_api_key] = lambda: None
    try:
        res = TestClient(app).post("/v1/generate", json={"prompt": "a cake", "project_id": URL})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 202, res.text
    job = asyncio.run(jobs.get(res.json()["job_id"]))
    assert job["project_id"] == ID
    assert asyncio.run(project_links.url_for(ID)) == URL
