"""The public API: post a prompt, poll for an image.

Generation takes 30-90 seconds, which is why this is asynchronous. A
synchronous endpoint would sit past most proxy timeouts and lose the result on
any dropped connection.

The article platform's ImageClient speaks exactly this, unchanged.
"""
import logging
from typing import Literal, Optional
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent.auth import require_api_key
from agent.config import FLOW_PROJECT_ID
from agent.db import jobs
from agent.services.flow_client import get_flow_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["v1"], dependencies=[Depends(require_api_key)])


def _expires_at(url: Optional[str]) -> Optional[int]:
    """The Expires timestamp inside a signed Flow CDN URL.

    Flow returns time-limited URLs (observed: about six hours). Surfacing the
    deadline lets the caller download now rather than discovering the expiry as
    a 403 the next day.
    """
    if not url:
        return None
    try:
        expires = parse_qs(urlparse(url).query).get("Expires", [None])[0]
        return int(expires) if expires else None
    except (ValueError, TypeError):
        return None


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)
    orientation: Literal["VERTICAL", "HORIZONTAL"] = "VERTICAL"

    # The Flow project to generate into, sent per request: one image service
    # serves every site and each site has its own project, so a value fixed on
    # this container could only ever be right for one of them. FLOW_PROJECT_ID
    # here is the fallback for a caller that sends none.
    project_id: Optional[str] = Field(default=None, max_length=200)


class GenerateVideoRequest(BaseModel):
    """A video composed from images the platform already published.

    reference_urls are ordinary public image URLs, not Flow media ids: the
    service uploads each one at generation time, which means an article of any
    age can become a video and no media id has to outlive the job that made it.
    """

    prompt: str = Field(..., min_length=1, max_length=5000)
    reference_urls: list[str] = Field(..., min_length=1, max_length=8)
    orientation: Literal["VERTICAL", "HORIZONTAL"] = "VERTICAL"
    project_id: Optional[str] = Field(default=None, max_length=200)


class GenerateResponse(BaseModel):
    job_id: str
    status: str


class JobResponse(BaseModel):
    job_id: str
    status: Literal["PENDING", "PROCESSING", "COMPLETED", "FAILED"]
    kind: Literal["image", "video"] = "image"

    # image_url is kept populated for both kinds. The platform's ImageClient
    # reads that field and predates video entirely, so changing its meaning
    # would break the caller to save one line here; video_url is the honest
    # name for new callers, and both point at the same URL.
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    image_expires_at: Optional[int] = None
    media_id: Optional[str] = None
    error: Optional[str] = None
    prompt: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _reject_if_unavailable(project_id: str) -> None:
    """The two reasons a job could never move, refused at submit time.

    Without these the job sits PENDING until somebody notices, and the caller
    polls something that was never going to finish.
    """
    if not project_id:
        raise HTTPException(
            503,
            "No Flow project id. The platform normally sends one per site; set "
            "one on the site, under Settings, or as FLOW_PROJECT_ID here.",
        )

    if not get_flow_client().connected:
        raise HTTPException(
            503,
            "Browser extension not connected -- nothing can be generated right "
            "now. Open the Browser page to check the Google session.",
        )


@router.post("/generate", response_model=GenerateResponse, status_code=202)
async def generate(body: GenerateRequest) -> GenerateResponse:
    """Queue an image generation. Returns immediately with a job_id to poll."""
    project_id = (body.project_id or FLOW_PROJECT_ID or "").strip()
    _reject_if_unavailable(project_id)

    job = await jobs.create(body.prompt, body.orientation, project_id)
    logger.info("queued job %s for project %s", job["id"][:8], project_id)
    return GenerateResponse(job_id=job["id"], status=job["status"])


@router.post("/generate-video", response_model=GenerateResponse, status_code=202)
async def generate_video(body: GenerateVideoRequest) -> GenerateResponse:
    """Queue a video generation from reference images.

    Same job table and the same polling endpoint as an image -- only slower.
    Expect minutes rather than the 30-90 seconds an image takes.
    """
    project_id = (body.project_id or FLOW_PROJECT_ID or "").strip()
    _reject_if_unavailable(project_id)

    job = await jobs.create_video(
        body.prompt, body.reference_urls, project_id, body.orientation
    )
    logger.info(
        "queued video job %s for project %s (%d reference image(s))",
        job["id"][:8], project_id, len(body.reference_urls),
    )
    return GenerateResponse(job_id=job["id"], status=job["status"])


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: str) -> JobResponse:
    """Poll a job. image_url is populated once status is COMPLETED."""
    job = await jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"No job with id {job_id}")

    kind = job["kind"] if "kind" in job.keys() else "image"

    return JobResponse(
        job_id=job["id"],
        status=job["status"],
        kind=kind,
        image_url=job["output_url"],
        video_url=job["output_url"] if kind == "video" else None,
        image_expires_at=_expires_at(job["output_url"]),
        media_id=job["media_id"],
        error=job["error_message"],
        prompt=job["prompt"],
        created_at=job["created_at"],
        updated_at=job["updated_at"],
    )
