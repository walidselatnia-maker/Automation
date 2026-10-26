"""A stop on every generation after Google says "unusual activity".

PUBLIC_ERROR_UNUSUAL_ACTIVITY is Google's anti-abuse verdict on the session,
not a failed request. Every further submit is one more thing it sees while it
is deciding, and users of upstream Flow Kit lost whole accounts -- the Flow UI
itself refused them -- after tools kept submitting into it (crisng95/flowkit#67).

So the first one stops everything for an hour, and the stop is written to disk:
a restart, a redeploy or a Chrome crash does not lift it. It is held for the
whole service and not per Google account, because every account here runs in
the same Chrome on the same connection, and that may well be what was judged.

Reads and polling are not held, only the claim of new jobs.
"""
import json
import logging
import os
import time
from typing import Optional

from agent.config import BASE_DIR

logger = logging.getLogger(__name__)

HOLD_PATH = BASE_DIR / "generation_hold.json"
UNUSUAL_ACTIVITY_HOLD_S = int(os.environ.get("UNUSUAL_ACTIVITY_HOLD_S", "3600"))


def is_unusual_activity(error: str) -> bool:
    lower = str(error).lower()
    return "unusual_activity" in lower or "unusual activity" in lower


def _read() -> Optional[dict]:
    try:
        hold = json.loads(HOLD_PATH.read_text())
        float(hold["until"])
        return hold
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("Ignoring unreadable generation hold %s: %s", HOLD_PATH, exc)
        return None


def active() -> Optional[dict]:
    """The hold in force, with the seconds left, or None."""
    hold = _read()
    if not hold:
        return None
    left = float(hold["until"]) - time.time()
    if left <= 0:
        return None
    return {"reason": hold.get("reason"), "since": hold.get("at"), "seconds_left": round(left)}


def start(reason: str, seconds: float = UNUSUAL_ACTIVITY_HOLD_S) -> None:
    """Hold for `seconds`. A longer hold already in place is kept, with its reason."""
    now = time.time()
    current = _read()
    if current and float(current["until"]) >= now + seconds:
        return
    tmp = HOLD_PATH.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps({"until": now + seconds, "reason": reason, "at": now}))
        tmp.replace(HOLD_PATH)
    except OSError as exc:
        logger.warning("Could not save the generation hold: %s", exc)
    logger.warning("Generation held for %.0fs: %s", seconds, reason)


def clear() -> bool:
    """Lift the hold by hand. Answers whether one was in force."""
    was = active() is not None
    try:
        HOLD_PATH.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Could not remove the generation hold: %s", exc)
    return was
