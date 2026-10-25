"""Signing in one more Google account, from the platform's Platform settings.

The page opens in the Chrome the jobs use, next to the accounts already
signed in there, for a person to finish on the Browser page. Never real Google:
the extension is faked and only what it is asked to do is checked.
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent import chrome
from agent.api import flow


def test_sign_in_starts_chrome_and_asks_the_extension_to_open_google_sign_in(monkeypatch):
    calls = []

    class FakeClient:
        connected = True

        async def _send(self, method, params, timeout=300):
            calls.append((method, params))
            return {"result": {"ok": True}}

    async def ensure_running(reason):
        calls.append(("chrome", reason))

    monkeypatch.setattr(flow, "get_flow_client", lambda: FakeClient())
    monkeypatch.setattr(chrome, "ensure_running", ensure_running)
    monkeypatch.setattr(chrome, "hold_manually", lambda: calls.append(("hold", None)))

    app = FastAPI()
    app.include_router(flow.router)
    with TestClient(app) as client:
        response = client.post("/flow/sign-in", json={"email": "two@gmail.com"})

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls[:2] == [("hold", None), ("chrome", "a Google sign-in was asked for")]
    assert ("open_sign_in", {"email": "two@gmail.com"}) in calls
