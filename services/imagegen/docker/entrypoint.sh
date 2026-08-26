#!/bin/bash
# Pre-flight checks, then hand off to supervisord.
#
# Everything here fails loudly with an explanation rather than letting the
# container die three layers deep in a Chrome stack trace.

set -euo pipefail

PROFILE_DIR="${CHROME_PROFILE_DIR:-/data/chrome-profile}"

fail() { echo "ERROR: $*" >&2; exit 1; }

# ─── Config ─────────────────────────────────────────────────
# The agent enforces this too, but failing at container start gives a message
# someone will actually see in the Dokploy log, not buried in app output.
if [[ -z "${API_KEY:-}" ]]; then
    fail "API_KEY is not set.

This service exposes an image-generation endpoint. Without a key, anyone who
reaches the URL can spend your Google Flow credits.

Set API_KEY in your Dokploy environment variables. Generate one with:
    openssl rand -hex 32"
fi

# ─── Writable state ─────────────────────────────────────────
# Docker gives a fresh named volume the ownership of the image's directory, so
# this normally passes. It fails when a volume was created by an older image
# or pre-made as root — worth catching explicitly, because the symptom
# otherwise is Chrome exiting with no useful message.
mkdir -p "$PROFILE_DIR" 2>/dev/null || true
[[ -w "$PROFILE_DIR" ]] || fail "Chrome profile directory is not writable: $PROFILE_DIR
The mounted volume is owned by another user. Recreate it, or run:
    docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data"
[[ -w "${FLOW_AGENT_DIR:-/data}" ]] || fail "Data directory is not writable: ${FLOW_AGENT_DIR:-/data}"

# ─── Stale Chrome locks ─────────────────────────────────────
# A container stop kills Chrome without letting it clean up, leaving
# SingletonLock behind. On restart Chrome sees it, assumes another instance
# owns the profile, and exits immediately — supervisord then restarts it into
# the same wall until it gives up. Clearing these is what makes a persistent
# profile survive restarts.
rm -f "$PROFILE_DIR"/Singleton{Lock,Socket,Cookie} 2>/dev/null || true

# Chrome also refuses to start if it thinks it exited uncleanly, and shows a
# "restore pages?" bubble that can steal focus from the Flow tab.
PREFS="$PROFILE_DIR/Default/Preferences"
if [[ -f "$PREFS" ]]; then
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' \
        "$PREFS" 2>/dev/null || true
fi

# --- The browser view ---------------------------------------
# No VNC password. x11vnc listens on loopback and websockify is reachable only
# from the platform container on an internal Docker network -- there is no
# public route to this port at all. The platform proxies it at /browser behind
# the session cookie it already checks, so the browser view is protected by the
# same login as everything else.
#
# Adding a second, 8-character password on top of that would be theatre: it was
# only ever there because this port used to have its own public domain.

if [[ -d "$PROFILE_DIR/Default" ]]; then
    echo "imagegen: existing Chrome profile found - Google session should persist."
else
    echo "imagegen: no Chrome profile yet - sign in once through the platform's Browser page."
fi

exec "$@"
