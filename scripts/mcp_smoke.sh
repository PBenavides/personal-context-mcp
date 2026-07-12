#!/usr/bin/env bash
# Streamable-HTTP protocol smoke test for personal-context-mcp.
#
# Two modes:
#   ./scripts/mcp_smoke.sh                       # boots the server on :3999 against the
#                                                # fixture corpus, tests it, shuts it down
#   MCP_URL=https://host/personal-context \
#   MCP_BEARER_TOKEN=… ./scripts/mcp_smoke.sh    # tests an already-running server
#                                                # (Workstream F runs this against production)
#
# Asserts: initialize answers with serverInfo.name=personal-context; tools/list returns the
# three tools; tools/call search_context finds the pipeline sentinel; auth (when a token is
# set) rejects tokenless requests with 401.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECT_DOC="${EXPECT_DOC:-notes/_pipeline_sentinel.md}"
QUERY="${QUERY:-sentinel pipeline}"

STARTED_PID=""
cleanup() {
  if [[ -n "$STARTED_PID" ]]; then kill "$STARTED_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

if [[ -z "${MCP_URL:-}" ]]; then
  export PORT=3999
  export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-smoke-test-token}"
  export CORPUS_SOURCE=file
  export CORPUS_ROOT=tests/fixtures/enriched
  export LOG_LEVEL=warn
  if [[ -d dist && -f dist/index.js ]]; then
    node dist/index.js & STARTED_PID=$!
  else
    npx tsx src/index.ts & STARTED_PID=$!
  fi
  MCP_URL="http://127.0.0.1:${PORT}/personal-context"
  HEALTH_URL="http://127.0.0.1:${PORT}/health"
  for _ in $(seq 1 30); do
    curl -sf "$HEALTH_URL" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

AUTH_HEADER=()
if [[ -n "${MCP_BEARER_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MCP_BEARER_TOKEN}")
fi

rpc() {
  curl -sf -X POST "$MCP_URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    "${AUTH_HEADER[@]}" \
    -d "$1"
}

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "smoke: target $MCP_URL"

# 1. Auth: without a token the MCP route must 401 (only when a token is configured).
if [[ -n "${MCP_BEARER_TOKEN:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
  [[ "$code" == "401" ]] || fail "expected 401 without token, got $code"
  echo "smoke: 401 without token OK"
fi

# 2. initialize
init=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
echo "$init" | grep -q '"personal-context"' || fail "initialize did not advertise personal-context: $init"
echo "smoke: initialize OK"

# 3. tools/list — the three tool names
tools=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for tool in search_context get_document list_taxonomy; do
  echo "$tools" | grep -q "\"$tool\"" || fail "tools/list missing $tool"
done
echo "smoke: tools/list OK (search_context, get_document, list_taxonomy)"

# 4. tools/call search_context — the sentinel must come back
hits=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_context\",\"arguments\":{\"query\":\"$QUERY\"}}}")
echo "$hits" | grep -q "$EXPECT_DOC" || fail "search_context('$QUERY') did not return $EXPECT_DOC: $hits"
echo "smoke: search_context OK ($EXPECT_DOC found)"

# 5. tools/call get_document — full content round-trip
doc=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_document\",\"arguments\":{\"path\":\"$EXPECT_DOC\"}}}")
# The tool result is JSON-encoded inside the JSON-RPC envelope, so quotes arrive escaped.
echo "$doc" | grep -qF '\"category\"' || fail "get_document returned no category: $doc"
echo "smoke: get_document OK"

echo "smoke: ALL GREEN"
