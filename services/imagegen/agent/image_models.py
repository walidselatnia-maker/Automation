"""Which image model to ask Flow for, and what to do when it says no.

Flow offers three: Nano Banana Pro, Nano Banana 2, and Nano Banana 2 Lite. Pro
is wanted; the other two are what to fall back to, in that order, when Pro is
refused. Refused means Google answered the model by name -- the account may not
use it (MODEL_ACCESS_DENIED) or has no credits for it (USER_QUOTA_REACHED) --
not that the captcha failed or the transport dropped, which are not about the
model and do not move down the list.

Nothing is remembered on disk. A remembered fallback would be kept forever,
and forever is the wrong answer for a model that is merely preferred: one
transient refusal of Pro would leave every later image on Nano Banana 2. So a
refused model is skipped for a while and then tried again. In memory, so a
restart tries Pro first too. The skip is what keeps this cheap -- every attempt
is a captcha.

Only two of the three wire names are known: GEM_PIX_2 is Pro and NARWHAL is 2.
Lite's is not in the vendored client. It is not guessed and it is not asked
for: the extension reads it off the Flow page, whose bundle has to carry every
name it can put on the wire. What comes back is whatever UPPER_SNAKE string
sits near BOTH known names in that source -- near both, because that is what
being in the same list looks like, and near one alone is just an aspect ratio
or an error code that happened to be close by.

A discovered name is only ever tried after both known ones were refused, and
if Flow answers it with INVALID_ARGUMENT it was not a model after all and is
never tried again. So a wrong guess costs one captcha, once, and only on a job
that was already down to its last resort.
"""
import asyncio
import logging
import time

from agent.services import flow_batch as fb

logger = logging.getLogger(__name__)

# Pro, then 2. Google's names, in Flow's order of preference for this service.
KNOWN: tuple[str, ...] = ("GEM_PIX_2", "NARWHAL")

# How long a refused model stays skipped before it is tried again.
RETRY_AFTER_S = 1800

# Names that look like Flow's model enums and nothing else. Not a guarantee --
# the source is minified JavaScript -- but a floor: it rules out the obvious.
_MIN_LEN, _MAX_LEN = 4, 40
_NOT_A_MODEL = ("ASPECT", "RATIO", "ERROR", "STATUS", "TYPE_", "_TYPE", "UNSPECIFIED",
                "PORTRAIT", "LANDSCAPE", "SQUARE", "PENDING", "FAILED", "SUCCE",
                "IMAGE_", "VIDEO_", "MEDIA_", "GENERATION", "PUBLIC_", "QUOTA")

_skip_until: dict[str, float] = {}
_discovered: list[str] = []
_rejected: set[str] = set()
_discovery_done = False
_discovery_lock = asyncio.Lock()


def plan() -> list[str]:
    """Models to try, in order: the known two, then whatever the page said.

    Refused ones are left out. If that leaves nothing, the whole list comes
    back: a plan with nothing in it generates nothing, and the refusals may be
    stale.
    """
    now = time.monotonic()
    order = list(KNOWN) + [m for m in _discovered if m not in _rejected]
    open_ = [m for m in order if _skip_until.get(m, 0) <= now]
    return open_ or order


def is_known(model: str) -> bool:
    return model in KNOWN


def refused(model: str) -> None:
    """Skip this model for a while. The next plan() starts one further down."""
    _skip_until[model] = time.monotonic() + RETRY_AFTER_S
    logger.warning("image model %s refused — skipping it for %ds", model, RETRY_AFTER_S)


def rejected(model: str) -> None:
    """Flow did not recognise the name. It was not a model; never send it again."""
    _rejected.add(model)
    logger.warning("image model %s is not a name Flow accepts — dropped for good", model)


def is_refusal(error: str) -> bool:
    """Google answering the model by name: may not use it, or no credits for it.

    Only these move down the list. A captcha failure or a dropped transport is
    not about the model, and trying the next one would spend another captcha
    on the same problem.
    """
    text = str(error or "").upper()
    return "MODEL_ACCESS_DENIED" in text or "USER_QUOTA_REACHED" in text


def is_bad_name(error: str) -> bool:
    """Google not recognising the request at all -- for a discovered name, the
    name was wrong."""
    return "INVALID_ARGUMENT" in str(error or "").upper()


def _plausible(name: str) -> bool:
    if not (_MIN_LEN <= len(name) <= _MAX_LEN):
        return False
    if name in KNOWN:
        return False
    return not any(marker in name for marker in _NOT_A_MODEL)


def take_discovered(near: dict) -> list[str]:
    """Keep the names that sat near every known one, in the order found.

    `near` maps each known name to the strings found close to it in the page
    source. Being close to all of them is what sharing a list looks like.
    """
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
    return [n for n in order if n in common and _plausible(n)]


async def ensure_discovered(client) -> None:
    """Ask the page once per process. Best effort in every direction.

    Nothing here can fail a job: a page that does not answer leaves the plan
    at the two known names, which is exactly what it was before this existed.
    """
    global _discovery_done, _discovered
    if _discovery_done:
        return
    async with _discovery_lock:
        if _discovery_done:
            return
        try:
            answer = await client.discover_image_models(list(KNOWN))
        except Exception as e:  # noqa: BLE001 - discovery must never throw
            logger.info("image model discovery did not run: %s", e)
            return
        if answer.get("error"):
            logger.info("image model discovery: %s", answer["error"])
            return

        found = take_discovered(answer.get("near") or {})
        _discovered = found
        _discovery_done = True
        if found:
            logger.info("image models read off the Flow page, after %s: %s",
                        ", ".join(KNOWN), ", ".join(found))
        else:
            logger.info("no further image model names on the Flow page; "
                        "the list is %s", " then ".join(KNOWN))


def forget_all() -> None:
    """For tests."""
    global _discovery_done, _discovered
    _skip_until.clear()
    _rejected.clear()
    _discovered = []
    _discovery_done = False
