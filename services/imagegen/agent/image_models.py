"""Which image model to ask Flow for, and what to do when it says no.

Flow offers three: Nano Banana Pro, Nano Banana 2.1, and Nano Banana 2 Lite.
The platform's Settings page picks one, or picks Automatic, which is Pro
first and the others as fallbacks in that order when Pro is refused.

On 2026-10-10 Google replaced Nano Banana 2 (NARWHAL) with Nano Banana 2.1,
and NARWHAL stopped being accepted. All three wire names were read off a real
request from the Flow page that day: GEM_PIX_2 is Pro, BELUGA is 2.1 and
HARBOR_SEAL is 2 Lite. A setting still saying NANO_BANANA_2 means 2.1. Refused
means Google answered the model by name -- the account may not use it
(MODEL_ACCESS_DENIED) or has no credits for it (USER_QUOTA_REACHED) -- not that
the captcha failed or the transport dropped, which are not about the model and
do not move down the list.

Lite's name used to be read off the Flow page by the extension (whatever
UPPER_SNAKE string sat near both known names in the page's bundle). That scan
still runs, but it only fills Lite in if its name were ever unset; the name
captured from a real request wins.

Every attempt's outcome is recorded per model -- accepted, refused, or
rejected as not a model at all -- and the Settings page shows it.

A refused model is skipped for a while and then tried again, in memory. A
remembered fallback kept forever is the wrong answer for a model that is
merely preferred: one transient refusal of Pro would leave every later image
on 2.1. The skip is what keeps the walk cheap -- every attempt is a captcha.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

AUTO = "auto"

# In fallback order. `wire` is Google's name for it; Lite's is filled in by
# discovery and is None until then.
MODELS: list[dict] = [
    {"key": "NANO_BANANA_PRO", "label": "Nano Banana Pro", "wire": "GEM_PIX_2"},
    {"key": "NANO_BANANA_2_1", "label": "Nano Banana 2.1", "wire": "BELUGA"},
    {"key": "NANO_BANANA_2_LITE", "label": "Nano Banana 2 Lite", "wire": "HARBOR_SEAL"},
]

# Keys saved before a model was renamed, and the model they mean now.
ALIASES = {"NANO_BANANA_2": "NANO_BANANA_2_1"}

# Lite's name as read off the Flow page; discovery only fills it if unset.
LITE_WIRE = "HARBOR_SEAL"

KNOWN: tuple[str, ...] = tuple(m["wire"] for m in MODELS if m["wire"])

# How long a refused model stays skipped before it is tried again.
RETRY_AFTER_S = 1800

# A model out of its daily quota. Google does not say when the day turns over
# (a free account showed 11:55 AM), and asking costs two seconds -- the refusal
# comes back that fast -- so it is asked again every hour rather than guessed.
DAILY_QUOTA_RETRY_S = 3600

# Names that look like Flow's model enums and nothing else. Not a guarantee --
# the source is minified JavaScript -- but a floor: it rules out the obvious.
_MIN_LEN, _MAX_LEN = 4, 40
_NOT_A_MODEL = ("ASPECT", "RATIO", "ERROR", "STATUS", "UNSPECIFIED", "PORTRAIT",
                "LANDSCAPE", "SQUARE", "PENDING", "FAILED", "SUCCE", "PUBLIC_", "QUOTA")

UNTRIED, ACCEPTED, REFUSED, REJECTED = "untried", "accepted", "refused", "rejected"

_skip_until: dict[str, float] = {}
_outcome: dict[str, dict] = {}       # wire -> {"outcome", "at", "error"}
_discovery_done = False
_discovery: dict = {}                # what the scan saw, for the Settings page
_discovery_lock = asyncio.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _lite() -> dict:
    return MODELS[-1]


def _by_key(key: str) -> Optional[dict]:
    key = ALIASES.get(key, key)
    for m in MODELS:
        if m["key"] == key:
            return m
    return None


def label_of(wire: str) -> str:
    for m in MODELS:
        if m["wire"] == wire:
            return m["label"]
    return wire


# ─── Choosing ───────────────────────────────────────────────

def plan(choice: Optional[str] = AUTO) -> list[str]:
    """Wire names to try, in order, for this choice.

    Automatic is every model that has a name and was not rejected, refused ones
    left out; if that leaves nothing the whole list comes back, because a plan
    with nothing in it generates nothing and the refusals may be stale.

    A named choice is that model alone. It is not skipped for a recent refusal
    -- the person picked it, and the point may be to see what it says now --
    and it is empty if the model has no name yet, which the worker reports.
    """
    choice = (choice or AUTO).strip()
    if choice != AUTO:
        picked = _by_key(choice)
        if not picked or not picked["wire"]:
            return []
        return [picked["wire"]]

    now = time.monotonic()
    order = [m["wire"] for m in MODELS
             if m["wire"] and _outcome.get(m["wire"], {}).get("outcome") != REJECTED]
    open_ = [w for w in order if _skip_until.get(w, 0) <= now]
    return open_ or order


def why_empty(choice: str) -> str:
    """The reason plan(choice) had nothing in it, for the job's error."""
    picked = _by_key((choice or "").strip())
    if not picked:
        return f"'{choice}' is not an image model this service knows."
    return (f"{picked['label']} has not been found on the Flow page yet, so there is "
            f"no name to send Google. Pick another model, or Automatic.")


def is_known(wire: str) -> bool:
    return wire in KNOWN


# ─── What Google said ───────────────────────────────────────

def record(wire: str, error: Optional[str]) -> None:
    """Keep the last outcome per model, which is what the Settings page shows."""
    if not error:
        outcome = ACCEPTED
    elif is_refusal(error):
        outcome = REFUSED
    elif is_bad_name(error) and not is_known(wire):
        outcome = REJECTED
    else:
        return  # a captcha or transport fault says nothing about the model
    _outcome[wire] = {"outcome": outcome, "at": _now(), "error": (error or "")[:200]}
    if outcome == ACCEPTED:
        logger.info("image model %s (%s): accepted by Google", label_of(wire), wire)


def refused(wire: str, seconds: Optional[float] = None) -> None:
    """Skip this model for a while. The next automatic plan starts further down."""
    seconds = RETRY_AFTER_S if seconds is None else seconds
    _skip_until[wire] = time.monotonic() + seconds
    logger.warning("image model %s refused — skipping it for %ds", wire, seconds)


def is_refusal(error: str) -> bool:
    """Google answering the model by name: may not use it, or no credits for it."""
    text = str(error or "").upper()
    return ("MODEL_ACCESS_DENIED" in text or "USER_QUOTA_REACHED" in text
            or is_daily_quota(error))


def is_daily_quota(error: str) -> bool:
    """This model is out for today. Measured 2026-10-28: Pro stopped after 17
    pictures on a free account and about 94 on a paid one, and the next model
    worked at once -- the limit is per model, not per account."""
    text = str(error or "")
    return "DAILY_QUOTA_REACHED" in text.upper() or "usage limit" in text.lower()


def walk(choice: Optional[str] = AUTO) -> list[str]:
    """Every model to try for this choice, in order, when the composer path
    meets a daily quota: the plan's first, then the rest with Lite first -- it
    made a picture in about 8 seconds where the others took 20.

    A named choice falls back too, but only on a daily quota (the caller
    decides that): the person picked a model, not a day without pictures.
    """
    first = plan(choice)
    if not first:
        return []
    now = time.monotonic()
    rest = [m["wire"] for m in MODELS
            if m["wire"] and m["wire"] not in first
            and _outcome.get(m["wire"], {}).get("outcome") != REJECTED
            and _skip_until.get(m["wire"], 0) <= now]
    order = first + rest
    lite = _lite()["wire"]
    tail = order[1:]
    if lite in tail:
        tail = [lite] + [w for w in tail if w != lite]
    return [order[0]] + tail


def is_bad_name(error: str) -> bool:
    """Google not recognising the request at all -- for a discovered name, the
    name was wrong."""
    return "INVALID_ARGUMENT" in str(error or "").upper()


# ─── Discovery ──────────────────────────────────────────────

def _plausible(name: str) -> bool:
    if not (_MIN_LEN <= len(name) <= _MAX_LEN):
        return False
    if name in KNOWN:
        return False
    return not any(marker in name for marker in _NOT_A_MODEL)


def take_discovered(near: dict) -> list[str]:
    """The names that sat near every known one, in the order found."""
    sets = []
    order: list[str] = []
    for known in KNOWN:
        found = near.get(known) or []
        sets.append(set(found))
        for name in found:
            if name not in order:
                order.append(name)
    if not sets:
        return []
    common = set.intersection(*sets)
    names = [n for n in order if n in common and _plausible(n)]
    # Several candidates: the one that says so goes first. The picker verifies
    # whichever is chosen; this only decides which is offered by default.
    names.sort(key=lambda n: (0 if "LITE" in n else 1, order.index(n)))
    return names


async def ensure_discovered(client) -> None:
    """Ask the page once per process. Best effort in every direction."""
    global _discovery_done
    if _discovery_done:
        return
    async with _discovery_lock:
        if _discovery_done:
            return
        global _discovery
        try:
            answer = await client.discover_image_models(list(KNOWN))
        except Exception as e:  # noqa: BLE001 - discovery must never throw
            logger.info("image model discovery did not run: %s", e)
            _discovery = {"error": str(e), "at": _now()}
            return
        # The bridge wraps every reply as {id, result: {...}}; the scan's answer
        # is the result. Read off the envelope instead, this found nothing
        # forever and reported nothing about why -- the deployed page showed a
        # scan with every field missing, which is what an unread reply looks
        # like. A transport-level error sits on the envelope; the scan's own
        # sits inside. Both are looked at.
        answer = answer.get("result") or answer
        if answer.get("error"):
            logger.info("image model discovery: %s", answer["error"])
            _discovery = {"error": answer["error"], "at": _now()}
            return

        near = answer.get("near") or {}
        found = take_discovered(near)
        _discovery = {
            "at": _now(),
            "candidates": found,
            "near": {k: v[:40] for k, v in near.items()},
            **(answer.get("debug") or {}),
        }
        logger.info("image model scan: %s", {k: v for k, v in _discovery.items() if k != "near"})
        _discovery_done = True
        if found and not _lite()["wire"]:
            _lite()["wire"] = found[0]
            logger.info("image model read off the Flow page for %s: %s%s",
                        _lite()["label"], found[0],
                        f" (also saw {', '.join(found[1:])})" if len(found) > 1 else "")
        else:
            logger.info("no name for %s on the Flow page; the list is %s",
                        _lite()["label"], " then ".join(KNOWN))


def discovery_done() -> bool:
    return _discovery_done


def discovery_report() -> dict:
    """What the last scan looked at and found, for the Settings page."""
    return dict(_discovery)


# ─── For the Settings page ──────────────────────────────────

def catalogue() -> list[dict]:
    """Every model, what it is called on the wire, and what Google last said."""
    out = []
    for m in MODELS:
        wire = m["wire"]
        last = _outcome.get(wire, {}) if wire else {}
        out.append({
            "key": m["key"],
            "label": m["label"],
            "wire": wire,
            "discovered": wire is not None and wire not in KNOWN,
            "outcome": last.get("outcome", UNTRIED) if wire else "unknown",
            "at": last.get("at"),
            "error": last.get("error"),
        })
    return out


def forget_all() -> None:
    """For tests."""
    global _discovery_done, _discovery
    _skip_until.clear()
    _outcome.clear()
    _lite()["wire"] = LITE_WIRE
    _discovery_done = False
    _discovery = {}
