"""When restarting Chrome helps, and when it makes things worse.

The watchdog exists to recover a wedged browser. On a fresh container it was
doing the opposite: the extension is force-installed through enterprise policy,
Chrome fetches the update manifest on its own delayed schedule, and a restart
throws that progress away and starts the delay over. With a 120s grace, Chrome
was killed every two minutes and never finished installing.
"""
import asyncio

import pytest

from agent import watchdog


class FakeController:
    def __init__(self):
        self.paused_for = None

    def pause(self, reason):
        self.paused_for = reason


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    watchdog.state = watchdog.WatchdogState()
    monkeypatch.setattr(watchdog, "restart_chrome", lambda: True)
    yield
    watchdog.state = watchdog.WatchdogState()


def connected(value: bool, monkeypatch):
    class FakeClient:
        pass

    client = FakeClient()
    client.connected = value
    monkeypatch.setattr(watchdog, "get_flow_client", lambda: client)


def check(controller) -> bool:
    return asyncio.run(watchdog._check_extension(controller))


def test_a_connected_extension_is_healthy(monkeypatch):
    connected(True, monkeypatch)

    assert check(FakeController()) is False
    assert watchdog.state.ever_connected is True


def test_the_first_disconnected_check_only_starts_the_clock(monkeypatch):
    connected(False, monkeypatch)

    assert check(FakeController()) is False
    assert watchdog.state.disconnected_since is not None


def test_a_fresh_container_is_left_alone_through_the_short_grace(monkeypatch, mocker=None):
    # Two minutes in, with the extension still installing, the old code would
    # have restarted Chrome here. That is the loop.
    connected(False, monkeypatch)
    check(FakeController())
    watchdog.state.disconnected_since -= 150  # 150s ago

    assert check(FakeController()) is False
    assert watchdog.state.chrome_restarts == []


def test_a_dropped_connection_restarts_after_the_short_grace(monkeypatch):
    connected(True, monkeypatch)
    check(FakeController())  # marks ever_connected

    connected(False, monkeypatch)
    check(FakeController())
    watchdog.state.disconnected_since -= 150

    assert check(FakeController()) is True
    assert len(watchdog.state.chrome_restarts) == 1


def test_a_fresh_container_gets_one_restart_after_the_long_grace(monkeypatch):
    connected(False, monkeypatch)
    check(FakeController())
    watchdog.state.disconnected_since -= watchdog.FIRST_CONNECT_GRACE_S + 10

    assert check(FakeController()) is True
    assert len(watchdog.state.chrome_restarts) == 1


def test_it_stops_restarting_and_asks_for_a_human(monkeypatch):
    connected(False, monkeypatch)
    check(FakeController())
    watchdog.state.disconnected_since -= watchdog.FIRST_CONNECT_GRACE_S + 10
    check(FakeController())  # the one restart

    watchdog.state.disconnected_since -= watchdog.FIRST_CONNECT_GRACE_S + 10
    controller = FakeController()
    assert check(controller) is True

    # No number of restarts installs an extension that is not installed.
    assert len(watchdog.state.chrome_restarts) == 1
    assert watchdog.state.needs_human is True
    assert controller.paused_for == "extension not installed"
    assert "chrome://extensions" in watchdog.state.reason


def test_the_reason_says_which_situation_it_is(monkeypatch):
    connected(False, monkeypatch)
    check(FakeController())
    watchdog.state.disconnected_since -= watchdog.FIRST_CONNECT_GRACE_S + 10
    check(FakeController())

    assert "never" in watchdog.state.reason.lower() or "not connected" in watchdog.state.reason.lower()


def test_reconnecting_clears_the_clock(monkeypatch):
    connected(False, monkeypatch)
    check(FakeController())
    assert watchdog.state.disconnected_since is not None

    connected(True, monkeypatch)
    check(FakeController())

    assert watchdog.state.disconnected_since is None
