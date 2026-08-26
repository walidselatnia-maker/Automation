"""Serves the extension CRX and its update manifest to the local Chrome.

Chrome force-installs the extension via enterprise policy (see
docker/pack-extension.sh), and a force-install entry needs an update URL
serving a gupdate manifest. Rather than depend on an external host, the agent
serves both itself over loopback.

Deliberately unauthenticated: the only client is the Chrome running beside it
in this container, and Chrome cannot present an API key when fetching an
update manifest. Nothing here is sensitive — the CRX is the same extension
code that ships in the image — and the routes are only reachable from inside
the container unless someone publishes the port without a proxy.
"""
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ext", tags=["ext"])

# Where pack-extension.sh writes the CRX at build time. Overridable so the
# routes can be exercised outside a container.
DIST = Path(os.environ.get("EXT_DIST_DIR", "/app/ext-dist"))


@router.get("/update.xml")
async def update_manifest():
    """The gupdate manifest Chrome polls to discover the extension."""
    manifest = DIST / "update.xml"
    if not manifest.is_file():
        raise HTTPException(503, "Extension was not packed at build time")
    return PlainTextResponse(
        manifest.read_text(encoding="utf-8"), media_type="text/xml",
    )


@router.get("/flowkit.crx")
async def crx():
    """The packed extension itself."""
    package = DIST / "flowkit.crx"
    if not package.is_file():
        raise HTTPException(503, "Extension was not packed at build time")
    logger.info("Serving CRX to Chrome")
    return FileResponse(
        package,
        media_type="application/x-chrome-extension",
        filename="flowkit.crx",
    )
