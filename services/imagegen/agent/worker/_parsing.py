"""Reading Google Flow's batchGenerateImages response.

Trimmed to the image shape; the video branches went with the video pipeline.
The rules below were recovered from real responses and are worth stating
plainly, because getting either wrong produces a job that looks successful and
returns nothing usable.
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
