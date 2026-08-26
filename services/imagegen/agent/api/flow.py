"""Health of the browser side.

Everything that generates now goes through /v1 and the job queue. What remains
here is the pair of read-only questions the platform's dashboard asks: is the
browser session alive, and how much credit is left.

The direct generate/edit/upload routes are gone. They bypassed the queue, which
meant they also bypassed the concurrency limit and the cooldown that keep the
account off the rate-limited path.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

from agent.auth import require_api_key
from agent.config import FLOW_PROJECT_ID
from agent.db import jobs
from agent.services.flow_client import get_flow_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/flow", tags=["flow"], dependencies=[Depends(require_api_key)])


@router.get("/status")
async def extension_status() -> dict:
    """Whether the extension is connected, plus the queue depth.

    `connected` false is the signal that someone has to sign in to Google
    again — the platform surfaces it as a configuration problem.
    """
    client = get_flow_client()
    return {
        "connected": client.connected,
        "flow_key_present": client._flow_key is not None,
        "project_id_configured": bool(FLOW_PROJECT_ID),
        "jobs": await jobs.count_by_status(),
    }


@router.get("/credits")
async def get_credits() -> dict:
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    result = await client.get_credits()
    if result.get("error"):
        raise HTTPException(502, result["error"])

    return result.get("data", result)
