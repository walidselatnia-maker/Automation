"""Which image model to ask Flow for, and what to do when it says no.

Flow offers three: Nano Banana Pro, Nano Banana 2, and Nano Banana 2 Lite. Pro
is wanted; the other two are what to fall back to, in that order, when Pro is
refused. Refused means Google answered the model by name -- the account may not
use it (MODEL_ACCESS_DENIED) or has no credits for it (USER_QUOTA_REACHED) --
not that the captcha failed or the transport dropped, which are not about the
model and do not move down the list.

Unlike the video walk, nothing is remembered on disk. A remembered fallback
would be kept forever, and forever is the wrong answer for a model that is
merely preferred: one transient refusal of Pro would leave every later image
on Nano Banana 2. So a refused model is skipped for a while and then tried
again. In memory, so a restart tries Pro first too.

The skip is what keeps this cheap. Every attempt is a captcha, and an account
that cannot use Pro would otherwise pay two per image for as long as that
stayed true.

The wire names are Google's and this file only knows two of them. Nano Banana
2 Lite's is not in the vendored client, and guessing one is worse than leaving
it out: the request builder passes the string through, and Flow would answer a
made-up name with the same INVALID_ARGUMENT that took a week to diagnose for
video. Set IMAGE_MODEL_ORDER once the name is known -- it is the full list, in
order, and needs no redeploy.
"""
import logging
import os
import time

from agent.services import flow_batch as fb

logger = logging.getLogger(__name__)

# Nicknames are accepted here so the env var can be written in Flow's words.
_DEFAULT_ORDER = "NANO_BANANA_PRO,NANO_BANANA_2"


def _parse(order: str) -> list[str]:
    names = []
    for raw in order.split(","):
        name = raw.strip()
        if not name:
            continue
        # Nickname or wire name in, wire name out. Not resolve_image_model():
        # that coerces anything it does not know to the default, which would
        # turn a configured Lite name back into Pro without saying so.
        names.append(fb.IMAGE_MODEL_BY_NICKNAME.get(name, name))
    return names


CANDIDATES: tuple[str, ...] = tuple(_parse(os.environ.get("IMAGE_MODEL_ORDER", _DEFAULT_ORDER)))

# How long a refused model stays skipped before it is tried again.
RETRY_AFTER_S = int(os.environ.get("IMAGE_MODEL_RETRY_AFTER", "1800"))

_skip_until: dict[str, float] = {}


def plan() -> list[str]:
    """Models to try, in order, leaving out any refused recently.

    If every one of them is currently skipped the whole list comes back: a
    plan with nothing in it generates nothing, and the refusals may be stale.
    """
    now = time.monotonic()
    open_ = [m for m in CANDIDATES if _skip_until.get(m, 0) <= now]
    return open_ or list(CANDIDATES)


def refused(model: str) -> None:
    """Skip this model for a while. The next plan() starts one further down."""
    _skip_until[model] = time.monotonic() + RETRY_AFTER_S
    logger.warning("image model %s refused — skipping it for %ds", model, RETRY_AFTER_S)


def is_refusal(error: str) -> bool:
    """Whether an error is Google answering the model by name.

    Only these move down the list. A captcha failure or a dropped transport is
    not about the model, and trying the next one would spend another captcha
    on the same problem.

    The two markers are the ones video learned on the deployed container:
    PUBLIC_ERROR_MODEL_ACCESS_DENIED when the account may not use a model, and
    code 8 PUBLIC_ERROR_USER_QUOTA_REACHED when it has no credits for it.
    Spelled out here rather than imported so this file has no dependency on
    the video side, which not every branch carries.
    """
    text = str(error or "").upper()
    return "MODEL_ACCESS_DENIED" in text or "USER_QUOTA_REACHED" in text


def forget_all() -> None:
    """For tests."""
    _skip_until.clear()
