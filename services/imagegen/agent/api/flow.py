"""Health of the browser side.

Everything that generates now goes through /v1 and the job queue. What remains
here is the pair of read-only questions the platform's dashboard asks: is the
browser session alive, and how much credit is left.

The direct generate/edit/upload routes are gone. They bypassed the queue, which
meant they also bypassed the concurrency limit and the cooldown that keep the
account off the rate-limited path.
"""
import asyncio
import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent import chrome, generation_hold, image_models
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
        # `connected: false` used to mean one thing -- sign in again. It now
        # also means "Chrome is stopped because nothing is queued", which is
        # normal and needs nobody. Anything rendering this has to read the two
        # together or it will tell people their session is broken every time the
        # container is idle, which is most of the day.
        "chrome": chrome.state(),
        # Set after Google says "unusual activity": no job is started until it
        # runs out. None when generating normally.
        "generation_hold": generation_hold.active(),
    }


@router.post("/clear-hold")
async def clear_hold() -> dict:
    """Lift the unusual-activity hold by hand.

    Only once a picture made by hand in the Flow tab works again; lifting it
    while Google is still blocking the account is what the hold is there to stop.
    """
    return {"was_held": generation_hold.clear()}


@router.get("/ui-scan")
async def ui_scan(project_id: str | None = None) -> dict:
    """Flow's generate controls, read off the signed-in tab.

    A diagnostic, and the input to driving the UI rather than rebuilding its
    requests. Chrome is started and pinned for it the way signing in is: a
    scan is not a queued job, so nothing else would hold the browser up.
    """
    chrome.hold_manually()
    await chrome.ensure_running("a UI scan was asked for")
    return await get_flow_client().scan_flow_ui(project_id)


@router.post("/chrome/start")
async def chrome_start() -> dict:
    """Bring Chrome up and pin it there for a while.

    For the Browser page: signing in to Google needs a browser, and a browser is
    no longer running just because the container is. Pinned rather than merely
    started because a sign-in is not a queued job, so nothing else would hold it
    and the idle stop would take the window away mid-sign-in.
    """
    chrome.hold_manually()
    await chrome.ensure_running("asked for by hand")
    return chrome.state()


#: How long a sign-in waits for Chrome and its extension to come up.
SIGN_IN_WAIT_S = 120


class SignIn(BaseModel):
    email: str = Field(default="", max_length=320)


async def _open_sign_in(email: str) -> None:
    """Wait for the extension, then have it open Google's sign-in page."""
    client = get_flow_client()
    for _ in range(SIGN_IN_WAIT_S):
        if client.connected:
            break
        await asyncio.sleep(1)
    result = await client._send("open_sign_in", {"email": email}, timeout=30)
    if result.get("error"):
        logger.warning("Sign-in page did not open for %s: %s", email or "the current account", result["error"])


@router.post("/sign-in")
async def sign_in(body: SignIn) -> dict:
    """Open Google's sign-in for one account in this Chrome, for a person to finish.

    Added next to the accounts already signed in (Google's own multi-account
    sign-in), so each account is signed in once and keeps its session in the
    profile. Chrome is pinned the way the Browser page pins it. When Chrome was
    asleep the page opens once the extension is up, without holding the answer.
    """
    chrome.hold_manually()
    await chrome.ensure_running("a Google sign-in was asked for")
    if get_flow_client().connected:
        await _open_sign_in(body.email.strip())
    else:
        asyncio.create_task(_open_sign_in(body.email.strip()))
    return {"ok": True}


@router.post("/chrome/stop")
async def chrome_stop() -> dict:
    """Put Chrome down now rather than waiting out the idle timer."""
    chrome.release_manual_hold()
    await chrome.ensure_stopped("asked for by hand")
    return chrome.state()


@router.get("/image-models")
async def image_model_catalogue() -> dict:
    """Every image model, its wire name, and what Google last said to it.

    For the platform's Settings page. Two names are known; the third is read
    off the Flow page on the first image job, and a name read off a page is a
    candidate until Google accepts it. Nothing verifies it in Automatic mode --
    Nano Banana 2 is unlimited, so a third name is never reached -- which is why
    the outcome of every attempt is kept here: choosing that model on the page
    and running one article is the verification, and this is where it shows.
    """
    return {
        "models": image_models.catalogue(),
        "discovered": image_models.discovery_done(),
        "scan": image_models.discovery_report(),
    }


@router.get("/diagnostics")
async def extension_diagnostics() -> dict:
    """What the extension knows about its own state, over the WS it already holds.

    Same reason /procs exists: the deployment is Dokploy, there is no shell, and
    the extension's own console goes to a devtools window nobody can open. So the
    questions that decide whether the Flow tab should have closed -- is one open,
    is a run still holding it, how long has it been idle, is the alarm still
    scheduled -- were unanswerable from outside the container.

    The tab is the single largest CPU cost in this service. A tab left open
    because a counter leaked looks exactly like a tab held by a working run, and
    telling those two apart by reading the source is guesswork.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    payload = await client.get_diagnostics()
    if payload.get("error"):
        raise HTTPException(502, payload["error"])

    return payload.get("result", payload)


@router.get("/credits")
async def get_credits() -> dict:
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    result = await client.get_credits()
    if result.get("error"):
        raise HTTPException(502, result["error"])

    return result.get("data", result)


@router.get("/procs")
async def process_table() -> dict:
    """What is using the CPU in this container, as `top` would tell you.

    This exists because the deployment is Dokploy and there is no shell. A
    container burning five cores is a one-command diagnosis with `docker exec`
    and pure guesswork without it — and guesswork in this particular corner has
    a long and expensive history. So the container answers the question itself.

    Read-only, and no new dependency: /proc/<pid>/stat carries the CPU jiffies
    each process has consumed since it started, so sampling it twice gives the
    share of a core used in between. `top` does exactly this.
    """
    interval = 1.0

    def snapshot() -> dict[int, tuple[int, int, str]]:
        """pid -> (cpu jiffies, resident pages, command)."""
        out: dict[int, tuple[int, int, str]] = {}
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            try:
                # The command sits in parentheses and may itself contain
                # spaces, so split after the last ')' rather than on the first.
                with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
                fields = raw[raw.rindex(")") + 2:].split()
                utime, stime, rss = int(fields[11]), int(fields[12]), int(fields[21])

                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmdline = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
                if not cmdline:  # kernel thread
                    cmdline = raw[raw.index("(") + 1:raw.rindex(")")]
            except (OSError, ValueError, IndexError):
                continue  # the process ended while we were reading it
            out[pid] = (utime + stime, rss, cmdline)
        return out

    first = await asyncio.to_thread(snapshot)
    await asyncio.sleep(interval)
    second = await asyncio.to_thread(snapshot)

    ticks = os.sysconf("SC_CLK_TCK")
    page_kb = os.sysconf("SC_PAGE_SIZE") // 1024

    rows = []
    for pid, (jiffies, rss, cmdline) in second.items():
        before = first.get(pid)
        if before is None:
            continue  # started during the sample; no baseline to subtract
        rows.append(
            {
                "pid": pid,
                "cpu_percent": round((jiffies - before[0]) / ticks / interval * 100, 1),
                "memory_mb": round(rss * page_kb / 1024, 1),
                # Chrome's renderer command lines run to several hundred
                # characters of flags, and the useful part (--type=) is early.
                "command": cmdline[:180],
            }
        )

    rows.sort(key=lambda r: r["cpu_percent"], reverse=True)
    return {
        "sampled_over_seconds": interval,
        "total_cpu_percent": round(sum(r["cpu_percent"] for r in rows), 1),
        "processes": rows[:25],
    }


@router.get("/threads/{pid}")
async def thread_table(pid: int) -> dict:
    """Per-thread CPU inside one process, which is where the answer usually is.

    A Chrome process is a dozen named threads doing unrelated jobs, and the
    process total says nothing about which. The GPU process alone runs the viz
    compositor, the SwiftShader worker pool, a watchdog and the raster workers
    — and 300% could be any of them, with a different fix each time.

    Chrome names its threads, and /proc/<pid>/task/<tid>/comm is that name. So
    this answers "VizCompositorThread" or "swiftshader" or "GpuWatchdog"
    instead of leaving it to be guessed at, which has not gone well.
    """
    interval = 1.0
    task_dir = f"/proc/{pid}/task"

    def snapshot() -> dict[int, tuple[int, str]]:
        """tid -> (cpu jiffies, thread name)."""
        out: dict[int, tuple[int, str]] = {}
        try:
            entries = list(os.scandir(task_dir))
        except OSError:
            return out
        for entry in entries:
            if not entry.name.isdigit():
                continue
            tid = int(entry.name)
            try:
                with open(f"{task_dir}/{tid}/stat", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
                fields = raw[raw.rindex(")") + 2:].split()
                jiffies = int(fields[11]) + int(fields[12])
                with open(f"{task_dir}/{tid}/comm", encoding="utf-8", errors="replace") as f:
                    name = f.read().strip()
            except (OSError, ValueError, IndexError):
                continue  # the thread ended while we were reading it
            out[tid] = (jiffies, name)
        return out

    first = await asyncio.to_thread(snapshot)
    if not first:
        raise HTTPException(404, f"no process {pid}")
    await asyncio.sleep(interval)
    second = await asyncio.to_thread(snapshot)

    ticks = os.sysconf("SC_CLK_TCK")
    rows = []
    for tid, (jiffies, name) in second.items():
        before = first.get(tid)
        if before is None:
            continue
        rows.append(
            {
                "tid": tid,
                "cpu_percent": round((jiffies - before[0]) / ticks / interval * 100, 1),
                "name": name,
            }
        )

    rows.sort(key=lambda r: r["cpu_percent"], reverse=True)
    return {
        "pid": pid,
        "sampled_over_seconds": interval,
        "thread_count": len(rows),
        "total_cpu_percent": round(sum(r["cpu_percent"] for r in rows), 1),
        "threads": rows[:40],
    }
