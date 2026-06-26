#!/usr/bin/env bash
#
# tests/simulate_webhook.sh — Fire a mock CloudWatch "[ERROR]" webhook at the
# running Agent Controller (Module 1 / Person A).
#
# Posts a multiline `[ERROR]` + stack-trace payload (in the EXACT format the
# mock app emits and `src/incident.js#parsePayload` consumes) to the webhook
# endpoint, signed with an HMAC-SHA256 over the EXACT raw body bytes using the
# shared webhook secret. The signature is sent in the `x-signature` header so it
# matches `authenticate()` in `src/server.js` (which computes
# crypto.createHmac("sha256", secret).update(rawBody).digest("hex")).
#
# This is a local simulation helper — it does NOT start a server. Start the
# Controller first (`npm start`) and the mock app if desired, then run this.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#   ./tests/simulate_webhook.sh
#
# Environment overrides (all optional):
#   HOST            Controller host           (default: localhost)
#   PORT            Controller port           (default: 3000)
#   WEBHOOK_URL     Full endpoint URL         (default: http://$HOST:$PORT/webhook)
#   WEBHOOK_SECRET  Shared HMAC secret        (default: test-webhook-secret)
#
# Examples:
#   PORT=8080 WEBHOOK_SECRET=s3cr3t ./tests/simulate_webhook.sh
#   WEBHOOK_URL=https://example.com/webhook WEBHOOK_SECRET=s3cr3t ./tests/simulate_webhook.sh
#
# Requirements: 12.2
#
set -euo pipefail

# --- Configuration (env-overridable) ---------------------------------------
HOST="${HOST:-localhost}"
PORT="${PORT:-3000}"
WEBHOOK_URL="${WEBHOOK_URL:-http://${HOST}:${PORT}/webhook}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-test-webhook-secret}"

# --- Tooling checks ---------------------------------------------------------
command -v openssl >/dev/null 2>&1 || { echo "error: openssl is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }

# --- Mock CloudWatch payload ------------------------------------------------
# First line begins with the [ERROR] marker (becomes errorMessage); the
# following indented frames become the stackTrace. This mirrors the null-pointer
# bug surfaced by mock-app/server.js (`readUserId` dereferencing null).
PAYLOAD="[ERROR] Cannot read properties of null (reading 'profile')
    at readUserId (/app/mock-app/server.js:77:15)
    at /app/mock-app/server.js:113:16
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:149:13)
    at Route.dispatch (/app/node_modules/express/lib/router/route.js:119:3)"

# --- Compute the HMAC-SHA256 signature over the EXACT raw body --------------
# `printf '%s'` emits the payload WITHOUT a trailing newline so the signed bytes
# are byte-for-byte identical to what `--data-binary` sends and what the server
# verifies. openssl prints "(stdin)= <hex>"; we keep only the trailing hex.
SIGNATURE="$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.*= *//')"

echo "POST ${WEBHOOK_URL}"
echo "x-signature: ${SIGNATURE}"
echo "---"

# --- Send the request -------------------------------------------------------
# `--data-binary` preserves the payload bytes exactly (no curl @-style mangling
# or newline normalization), so the signature matches the verified body.
curl -sS -X POST "${WEBHOOK_URL}" \
  -H "Content-Type: text/plain" \
  -H "x-signature: ${SIGNATURE}" \
  --data-binary "${PAYLOAD}" \
  -w '\n--- HTTP %{http_code} ---\n'
