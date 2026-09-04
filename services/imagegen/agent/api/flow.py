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
