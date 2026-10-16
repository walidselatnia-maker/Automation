"""A Flow project as its whole address, not only its id.

The platform used to send the bare project id, and the extension built the
page address from it: ``https://flow.google.com/`` + an account segment it had
to guess (``u/N/``) + ``project/<id>``. When the guess was wrong the tab landed
on another account's Flow, the project was "not found", and nothing generated
was saved in it.

Now the platform may send the address exactly as copied from the browser.
The id is still what Google's API needs, so it is read from the address; the
address itself is kept, by id, and the extension opens it as it is.
"""
import logging
import re

from agent.db.schema import get_db

logger = logging.getLogger(__name__)

_ID = re.compile(r"/project/([0-9a-fA-F-]{36})")
_BARE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

# id -> address, read once from the database and kept current.
_links: dict[str, str] = {}
_loaded = False


def split(value: str) -> tuple[str, str]:
    """(project id, project address or '') from a bare id or a whole address."""
    value = (value or "").strip()
    match = _ID.search(value)
    if match and value.startswith("https://"):
        return match.group(1).lower(), value.split("#")[0]
    if _BARE.match(value):
        return value.lower(), ""
    return value, ""


async def _load() -> None:
    global _loaded
    if _loaded:
        return
    db = await get_db()
    await db.execute("CREATE TABLE IF NOT EXISTS project_link (project_id TEXT PRIMARY KEY, url TEXT NOT NULL)")
    async with db.execute("SELECT project_id, url FROM project_link") as cursor:
        for row in await cursor.fetchall():
            _links[row[0]] = row[1]
    _loaded = True


async def remember(project_id: str, url: str) -> None:
    """Keep a project's address, so the tab opens it rather than a guess."""
    if not project_id or not url:
        return
    await _load()
    if _links.get(project_id) == url:
        return
    _links[project_id] = url
    db = await get_db()
    await db.execute(
        "INSERT INTO project_link (project_id, url) VALUES (?, ?) "
        "ON CONFLICT(project_id) DO UPDATE SET url = excluded.url",
        (project_id, url),
    )
    await db.commit()
    logger.info("project %s opens at %s", project_id[:8], url)


async def url_for(project_id: str) -> str:
    """The address a project was given with, or '' when only its id is known."""
    if not project_id:
        return ""
    await _load()
    return _links.get(project_id, "")


async def resolve(value: str) -> str:
    """The project id from a bare id or a whole address, keeping the address."""
    project_id, url = split(value)
    if url:
        await remember(project_id, url)
    return project_id
