#!/usr/bin/env bash
# Install (or update) the Video Review page + app into THIS swarm.
#
# Run it from a swarm worker container, in the folder that holds this bundle:
#   bash install.sh
#
# It does, in order: save the backend script -> create the app -> create the page -> point the app at the page.
# Re-running updates the same script/app/page (ids are kept in ./install-state.json).
#
# Needs: bash, curl, python3. Reads these env vars (a swarm worker already has the first ones):
#   MCP_BASE_URL   swarm API base, e.g. http://api:3013            (required)
#   API_KEY        swarm API key                                    (required)
#   AGENT_ID       your agent id; the script is saved in its scope  (required)
#   APP_URL        dashboard base URL, e.g. https://app.example.com (required; VR_DASH overrides)
#   AGENT_FS_API_URL, AGENT_FS_DEFAULT_ORG_ID, AGENT_FS_DEFAULT_DRIVE_ID   agent-fs API + the drive with your videos
#                  (required; VR_FS_API / VR_FS_ORG / VR_FS_DRIVE override)
#   AGENT_FS_LIVE_URL   agent-fs web UI (optional, default https://live.agent-fs.dev; VR_FS_LIVE overrides)
#   VR_SEND_AGENT_ID    agent that receives "Send to swarm" tasks (optional; empty = default assignment, the lead)
#   VR_SCRIPT_NAME      backend script name (optional, default video-review-api)
#   VR_PAGE_SLUG        page slug (optional, default video-review)
#   VR_APP_NAME         app name (optional, default "Video Review")
# Also needs swarm config secret AGENT_FS_API_KEY (agent-fs key with read/write on the drive); the script reads it at run time.
set -euo pipefail
cd "$(dirname "$0")"

: "${MCP_BASE_URL:?set MCP_BASE_URL}" "${API_KEY:?set API_KEY}" "${AGENT_ID:?set AGENT_ID}"
export VR_DASH="${VR_DASH:-${APP_URL:?set APP_URL or VR_DASH}}"
export VR_FS_API="${VR_FS_API:-${AGENT_FS_API_URL:?set AGENT_FS_API_URL or VR_FS_API}}"
export VR_FS_ORG="${VR_FS_ORG:-${AGENT_FS_DEFAULT_ORG_ID:?set AGENT_FS_DEFAULT_ORG_ID or VR_FS_ORG}}"
export VR_FS_DRIVE="${VR_FS_DRIVE:-${AGENT_FS_DEFAULT_DRIVE_ID:?set AGENT_FS_DEFAULT_DRIVE_ID or VR_FS_DRIVE}}"
export VR_FS_LIVE="${VR_FS_LIVE:-${AGENT_FS_LIVE_URL:-https://live.agent-fs.dev}}"
export VR_SEND_AGENT_ID="${VR_SEND_AGENT_ID:-}" VR_SCRIPT_NAME="${VR_SCRIPT_NAME:-video-review-api}"
export VR_PAGE_SLUG="${VR_PAGE_SLUG:-video-review}" VR_APP_NAME="${VR_APP_NAME:-Video Review}"
export VR_DASH="${VR_DASH%/}" VR_FS_API="${VR_FS_API%/}" VR_FS_LIVE="${VR_FS_LIVE%/}"

python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

E = os.environ
BASE = E["MCP_BASE_URL"].rstrip("/")
STATE = "install-state.json"
state = json.load(open(STATE)) if os.path.exists(STATE) else {}

def req(method, path, body):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, method=method, data=data, headers={
        "Authorization": "Bearer " + E["API_KEY"], "X-Agent-ID": E["AGENT_ID"], "content-type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:800]}")

def pick_id(j, *keys):
    for k in keys:
        if isinstance(j.get(k), dict) and j[k].get("id"):
            return j[k]["id"]
    if j.get("id"):
        return j["id"]
    sys.exit(f"no id in response: {json.dumps(j)[:500]}")

def fill(text, extra=None):
    vals = {"__DASH__": E["VR_DASH"], "__FS_API__": E["VR_FS_API"], "__FS_ORG__": E["VR_FS_ORG"],
            "__FS_DRIVE__": E["VR_FS_DRIVE"], "__FS_LIVE__": E["VR_FS_LIVE"], **(extra or {})}
    for k, v in vals.items():
        text = text.replace(k, v)
    return text

# 1. backend script (agent scope of AGENT_ID)
src = fill(open("scripts/video-review-api.ts").read())
j = req("POST", "/api/scripts/upsert", {
    "name": E["VR_SCRIPT_NAME"], "scope": "agent", "source": src,
    "description": "Backend of the Video Review app: list agent-fs videos, open one (signed URL + feedback file), autosave feedback to <video-dir>/.review/<stem>.feedback.json and mirror a summary row into the app.",
    "intent": "Video Review app script action (op: list | open | save)"})
if j.get("id"):
    state["scriptId"] = j["id"]
else:  # upsert returns {name, version}; look the id up in this agent's scope
    rows = req("GET", "/api/scripts?scope=agent", None).get("scripts", [])
    ids = [s["id"] for s in rows if s.get("name") == E["VR_SCRIPT_NAME"] and s.get("scopeId") == E["AGENT_ID"]]
    if len(ids) != 1:
        sys.exit(f"expected 1 agent-scope script named {E['VR_SCRIPT_NAME']}, found {len(ids)}")
    state["scriptId"] = ids[0]
print("script", E["VR_SCRIPT_NAME"], state["scriptId"])

def app_body(page_id):
    a = json.loads(fill(open("app-definition.json").read(), {"__SCRIPT_ID__": state["scriptId"], "__PAGE_ID__": page_id}))
    a["name"] = E["VR_APP_NAME"]
    if E["VR_SEND_AGENT_ID"]:
        a["definition"]["actions"]["send"]["agentId"] = E["VR_SEND_AGENT_ID"]
    return a

# 2. app (page id filled in step 4)
if state.get("appId"):
    req("PUT", f"/api/apps/{state['appId']}", app_body(state.get("pageId", "")))
else:
    state["appId"] = pick_id(req("POST", "/api/apps", app_body("")), "app")
json.dump(state, open(STATE, "w"), indent=1)
print("app", state["appId"])

# 3. page (authed HTML; talks to the app through the page's /@swarm/api proxy as the viewer)
page = {"title": "Video review", "slug": E["VR_PAGE_SLUG"],
        "description": "Timestamped feedback on agent-fs videos, autosaved next to the video, sent to the swarm in rounds.",
        "contentType": "text/html", "authMode": "authed", "designVersion": 2, "theme": "hive",
        "body": fill(open("page/index.html").read(), {"__APP_ID__": state["appId"]})}
if state.get("pageId"):
    req("PUT", f"/api/pages/{state['pageId']}", page)
else:
    state["pageId"] = pick_id(req("POST", "/api/pages", page), "page")
json.dump(state, open(STATE, "w"), indent=1)
print("page", state["pageId"])

# 4. app again, now with the page id (open-button link + review links in the table)
req("PUT", f"/api/apps/{state['appId']}", app_body(state["pageId"]))
print()
print("App:      ", f"{E['VR_DASH']}/apps/{state['appId']}")
print("Reviewer: ", f"{E['VR_DASH']}/pages/{state['pageId']}?path=/<folder>/<video>.mp4")
PY
