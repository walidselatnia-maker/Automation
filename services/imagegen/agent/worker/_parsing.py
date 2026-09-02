"""Reading Google Flow's generation responses.

Two shapes: images come back under `media[]` immediately, videos come back as
an `operations[]` handle that has to be polled until it carries a URL. The
rules below were recovered from real responses and are worth stating plainly,
because getting either wrong produces a job that looks successful and returns
nothing usable.
"""
import logging
import re

logger = logging.getLogger(__name__)

_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
_UUID_IN_URL = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I
)


def is_error(result: dict) -> bool:
    if result.get("error"):
        return True

    status = result.get("status")
    if isinstance(status, int) and status >= 400:
        return True

    data = result.get("data")
    return isinstance(data, dict) and bool(data.get("error"))


def error_text(result: dict) -> str:
    """A single readable line describing why a response counts as a failure."""
    if result.get("error"):
        return str(result["error"])

    data = result.get("data")
    if isinstance(data, dict) and data.get("error"):
        return str(data["error"])

    status = result.get("status")
    return f"HTTP {status}" if status else str(result)[:300]


def extract_media_id(result: dict) -> str | None:
    """The image's mediaId.

    mediaId is a UUID. mediaGenerationId sitting beside it is a base64 protobuf
    string starting "CAMS" — passing that on as an id produces requests Google
    rejects, so every candidate here is UUID-checked before it is returned.
    """
    data = result.get("data", result)
    media = data.get("media") or []
    if not media:
        return None

    item = media[0]

    name = item.get("name", "")
    if name and _UUID.match(name):
        return name

    generated = item.get("image", {}).get("generatedImage", {})

    candidate = generated.get("mediaId", "")
    if candidate and _UUID.match(candidate):
        return candidate

    # Last resort: the signed CDN URL carries the same UUID in its path.
    for field in ("fifeUrl", "imageUri"):
        found = _UUID_IN_URL.search(generated.get(field, "") or "")
        if found:
            logger.info("recovered mediaId from %s", field)
            return found.group(1)

    if name:
        logger.warning("media[0].name is not a UUID: %s", name[:30])
    return None


def extract_output_url(result: dict) -> str:
    data = result.get("data", result)
    media = data.get("media") or []

    if media:
        generated = media[0].get("image", {}).get("generatedImage", {})
        url = generated.get("fifeUrl") or generated.get("imageUri") or ""
        if url:
            return url

    return data.get("imageUri", "") or ""


# --- Video -----------------------------------------------------------------
#
# A video response is an operation, not a result. The submit call returns one
# with no URL on it; the same structure comes back from check_video_status with
# a fifeUrl once Google has finished. So the same two readers serve both, and
# "no URL yet" is the normal state rather than a failure.


def extract_operation(result: dict) -> dict | None:
    """The operation handle to poll, from a video submit response."""
    data = result.get("data", result)
    ops = data.get("operations") or []
    if not ops:
        return None

    # Sent back verbatim: check_video_status expects the operation exactly as
    # it was handed out, and trimming it to the fields that look useful is how
    # you get an empty status response with no error to explain it.
    return ops[0]


def _video_metadata(result: dict) -> dict:
    data = result.get("data", result)
    ops = data.get("operations") or []
    if not ops:
        return {}
    return ops[0].get("operation", {}).get("metadata", {}).get("video", {}) or {}


def extract_video_url(result: dict) -> str:
    """The finished video's URL, or "" while it is still generating."""
    return _video_metadata(result).get("fifeUrl", "") or ""


def extract_video_media_id(result: dict) -> str | None:
    """The finished video's mediaId.

    Same UUID rule as images: mediaGenerationId sitting beside it is a base64
    protobuf, and passing that on produces requests Google rejects.
    """
    meta = _video_metadata(result)

    candidate = meta.get("mediaId", "")
    if candidate and _UUID.match(candidate):
        return candidate

    found = _UUID_IN_URL.search(meta.get("fifeUrl", "") or "")
    return found.group(1) if found else None


def video_failed(result: dict) -> str:
    """A terminal error reported inside the operation, as readable text.

    Separate from is_error: an operation can carry a failure while the HTTP
    call around it succeeded, which would otherwise be polled until the
    attempt budget ran out and reported as a timeout rather than the reason.
    """
    data = result.get("data", result)
    ops = data.get("operations") or []
    if not ops:
        return ""

    operation = ops[0].get("operation", {})
    error = operation.get("error")
    if isinstance(error, dict) and (error.get("message") or error.get("code")):
        return str(error.get("message") or f"code {error.get('code')}")

    status = ops[0].get("status") or operation.get("metadata", {}).get("video", {}).get("status", "")
    if isinstance(status, str) and status.upper() in ("MEDIA_GENERATION_STATUS_FAILED", "FAILED"):
        return f"Flow reported {status}"

    return ""
