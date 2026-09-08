"""The watchdog pausing the worker, against the real worker.

test_watchdog.py drives a FakeController, which is right for testing the
watchdog's decisions and is why this was missed for so long: the fake had a
`pause` method and WorkerController did not, so every test passed while the
deployed container raised

    AttributeError: 'WorkerController' object has no attribute 'pause'

every thirty seconds once the circuit breaker tripped.

The cost was not a missing log line. The breaker is what stops a run of failures
from submitting more, and each submission spends a captcha and, for video,
credits. And because the raise happened inside _check_circuit_breaker, which
runs before _check_extension, a tripped breaker also took Chrome-wedge detection
down with it -- the watchdog was not degraded, it was off.

So these run the watchdog's own calls against the class the container actually
uses. A fake can define an interface; only this says the real one implements it.
"""
import asyncio

import pytest

from agent import watchdog
from agent.worker.processor import WorkerController


@pytest.fixture(autouse=True)
def fresh_state():
    watchdog.state = watchdog.WatchdogState()
    yield
    watchdog.state = watchdog.WatchdogState()


def failures(monkeypatch, count):
    async def recent(limit=10):
        return [{"status": "FAILED", "error_message": "boom"}] * count

    monkeypatch.setattr(watchdog, "_recent_failures", recent)


def test_the_circuit_breaker_pauses_the_real_controller(monkeypatch):
    """The exact call that was raising in the deployed container."""
    failures(monkeypatch, watchdog.FAILURE_THRESHOLD)
    controller = WorkerController()

    tripped = asyncio.run(watchdog._check_circuit_breaker(controller))

    assert tripped is True
    assert controller.paused is True


def test_the_session_wall_pauses_the_real_controller(monkeypatch):
    async def recent(limit=10):
        return [{"status": "FAILED", "error_message": "SESSION_EXPIRED"}]

    monkeypatch.setattr(watchdog, "_recent_failures", recent)
    controller = WorkerController()

    assert asyncio.run(watchdog._check_session_wall(controller)) is True
    assert controller.paused is True


def test_a_healthy_run_leaves_the_controller_alone(monkeypatch):
    failures(monkeypatch, 0)
    controller = WorkerController()

    assert asyncio.run(watchdog._check_circuit_breaker(controller)) is False
    assert controller.paused is False


def test_resume_clears_the_pause():
    controller = WorkerController()
    controller.pause("circuit breaker")
    assert controller.paused is True

    controller.resume()

    assert controller.paused is False


def test_pausing_twice_for_the_same_reason_is_quiet():
    # The watchdog re-asserts its pause every cycle, so this must be idempotent
    # rather than logging a warning every thirty seconds forever.
    controller = WorkerController()
    controller.pause("circuit breaker")
    controller.pause("circuit breaker")

    assert controller.paused is True


def test_resume_on_a_running_worker_does_nothing():
    controller = WorkerController()
    controller.resume()

    assert controller.paused is False


def test_every_call_the_watchdog_makes_exists_on_the_real_controller():
    """The class of bug, stated directly.

    A fake standing in for a collaborator defines an interface it does not have
    to honour. Naming the calls here means the next one added to the watchdog
    has somewhere to fail before a container does.
    """
    controller = WorkerController()

    for name in ("pause", "resume"):
        assert callable(getattr(controller, name, None)), (
            f"watchdog.py calls controller.{name}(), which WorkerController "
            f"does not implement"
        )
