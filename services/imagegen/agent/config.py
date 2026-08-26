"""Configuration constants."""
import json
import os
from pathlib import Path

# ─── Paths ───────────────────────────────────────────────────
BASE_DIR = Path(os.environ.get("FLOW_AGENT_DIR", Path(__file__).parent.parent))
DB_PATH = BASE_DIR / "flow_agent.db"

# ─── API Server ──────────────────────────────────────────────
API_HOST = os.environ.get("API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("API_PORT", "8100"))

# Shared secret for the public /v1 surface (see agent/auth.py). Empty is only
# tolerated when API_HOST is loopback; binding publicly without it is refused.
API_KEY = os.environ.get("API_KEY", "").strip()

# ─── WebSocket Server (extension connects here) ─────────────
WS_HOST = os.environ.get("WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("WS_PORT", "9222"))

# ─── Google Flow API ────────────────────────────────────────
GOOGLE_FLOW_API = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY")
RECAPTCHA_SITE_KEY = os.environ.get("RECAPTCHA_SITE_KEY", "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV")

# The Flow project this service generates into. It travels to Google as
# clientContext.projectId, so it has to be a real project id from the Flow
# UI -- the previous code sent a local database row id, which matched no
# project on their side.
FLOW_PROJECT_ID = os.environ.get("FLOW_PROJECT_ID", "").strip()

# --- Worker -------------------------------------------------
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "5"))
API_COOLDOWN = int(os.environ.get("API_COOLDOWN", "10"))
MAX_CONCURRENT_REQUESTS = int(os.environ.get("MAX_CONCURRENT_REQUESTS", "2"))
STALE_PROCESSING_TIMEOUT = int(os.environ.get("STALE_PROCESSING_TIMEOUT", "600"))

# --- Models -------------------------------------------------
# Part of the frozen request surface: the alias table decides which model name
# reaches Google, and NARWHAL is what the UI sends.
_MODELS_FILE = Path(__file__).parent / "models.json"
with open(_MODELS_FILE) as _f:
    _MODELS = json.load(_f)

IMAGE_MODELS = _MODELS["image_models"]

# --- API Endpoints ------------------------------------------
# Frozen: these paths and their query shape are what the Flow UI calls.
ENDPOINTS = {
    "generate_images": "/v1/projects/{project_id}/flowMedia:batchGenerateImages",
    "upload_image": "/v1/flow/uploadImage",
    "get_credits": "/v1/credits",
    "get_media": "/v1/media/{media_id}",
}

# ─── Header Randomization Pools ─────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
]

CHROME_VERSIONS = [
    '"Google Chrome";v="109", "Chromium";v="109"',
    '"Google Chrome";v="110", "Chromium";v="110"',
    '"Google Chrome";v="111", "Chromium";v="111"',
    '"Google Chrome";v="113", "Not-A.Brand";v="24"',
    '"Google Chrome";v="120", "Not-A.Brand";v="24"',
    '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
]

BROWSER_VALIDATIONS = [
    "SgDQo8mvrGRdD61Pwo8wyWVgYgs=",
]

CLIENT_DATA = [
    "CKi1yQEIh7bJAQiktskBCKmdygEIvorLAQiUocsBCIagzQEYv6nKARjRp88BGKqwzwE=",
]
