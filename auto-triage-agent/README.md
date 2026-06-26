# Auto-Triage Agent

Autonomous, event-driven incident response powered by the **headless Kiro CLI**.

When a production service throws a runtime error, mean-time-to-recovery is bottlenecked
by human reaction time: someone has to pull the logs, find the failing file, write a
hotfix, and open a PR. The Auto-Triage Agent does that first pass automatically. It
listens for error notifications, spins up an isolated workspace, drives Kiro to produce a
code fix, opens a hotfix Pull Request, and alerts the team in Slack — then stops.

**Crucial constraint:** the agent never pushes to `main`/production and never merges. It
stops at the Pull Request, leaving review and merge to a human engineer.

## Incident lifecycle

```
authenticated webhook  ─▶  isolated git worktree  ─▶  headless Kiro triage
        │                                                      │
        │                                                      ▼
        │                                          hotfix branch + Pull Request
        │                                                      │
        ▼                                                      ▼
   202 Accepted                                       Slack #qa alert
                                                               │
                                                               ▼
                                              guaranteed worktree cleanup
```

For each notification the Agent Controller:

1. **Authenticates** the inbound webhook (HMAC, timing-safe) and returns `202 Accepted`
   immediately, processing the incident out of band.
2. Generates a unique, injection-safe incident ID and provisions an **isolated
   `git worktree`**, writing the raw error payload into it as `error.log`.
3. Runs the **headless Kiro CLI** scoped to that worktree to read the error, locate the
   failing file(s), and write a fix.
4. On success, commits to a **`hotfix/<incident-id>` branch**, pushes it, and opens a
   **GitHub Pull Request** (the PR targets `main` for human review — it is never merged
   by the agent).
5. Posts a **Slack alert to `#qa`** with the incident status, a secret-free error snippet,
   and (on success) the PR link.
6. **Always removes the worktree** in a `finally` block — on success, failure, timeout, or
   thrown error.

If Kiro fails, times out, or any step throws, no branch or PR is produced; a `failed`
Slack notification is sent and the worktree is still cleaned up.

## Architecture / component map

The Controller is organized around a central **Orchestrator** that sequences the lifecycle
and guarantees cleanup. Each module has a single responsibility; all side effects (shell
commands, network calls, process spawning) are isolated behind module boundaries.

| File | Responsibility |
|------|----------------|
| `src/server.js` | Express webhook receiver: authenticates `/webhook` (timing-safe HMAC), parses the payload, generates the incident ID, responds `202`, hands off asynchronously; exposes `GET /health`. Boots the Controller via `startServer()`. |
| `src/orchestrator.js` | `handleIncident()` — sequences worktree → Kiro → commit/push/PR → notify, and guarantees worktree cleanup in a `finally` block. |
| `src/worktreeManager.js` | Creates/removes per-incident `git worktree` directories; sanitizes incident IDs; writes `error.log` verbatim. |
| `src/kiroRunner.js` | Invokes the Kiro CLI **headlessly** (non-interactive, one-shot) as a child process scoped to the worktree, under a timeout. Never the IDE. |
| `src/githubInteractions.js` | Creates the `hotfix/<id>` branch, commits, pushes, and opens the Pull Request. Rejects any operation that resolves to a protected branch. |
| `src/slackNotifier.js` | Builds and delivers Slack Block Kit alerts to `#qa`; builds the length-bounded, secret-free error snippet. Best-effort (never throws). |
| `src/config.js` | Loads and validates environment variables at startup (fail-fast); exposes configured secret values for downstream scrubbing. |
| `src/incident.js` | Pure helpers and data-model validators: `generateIncidentId()`, `parsePayload()`, and `Incident`/`KiroResult`/`Notification` validators. |
| `mock-app/` | A deliberately buggy target API that throws the in-scope errors and logs them in the exact `[ERROR]` + stack-trace format the parser expects. |
| `system_prompts/incident_responder.txt` | The system prompt that constrains Kiro's behavior inside the worktree. |

See `src/contracts.md` for the locked module interfaces and shared `Incident` shape.

## Setup

### Prerequisites

- **Node.js** (18+; the container image uses Node 20)
- **Git** (the worktree manager and GitHub interactions shell out to `git`)
- **Kiro CLI** (the headless binary that performs triage inside each worktree)

### Install

```bash
# from auto-triage-agent/
npm install
```

### Configure

```bash
cp .env.example .env
# then fill in real values in .env (never commit it)
```

The Config_Loader validates every required variable at startup and **fails fast** (exits
non-zero) naming any missing variable by key — secret values are never logged.

## Environment variables

All values are sourced from the environment. Secrets are never written to logs and are
scrubbed from any error snippet sent to Slack.

| Variable | Secret | Description |
|----------|:------:|-------------|
| `GITHUB_TOKEN` | yes | Token used to push the hotfix branch and open the Pull Request. Needs `repo` scope on the single target repository. |
| `SLACK_WEBHOOK_URL` | yes | Slack Incoming Webhook URL for the `#qa` channel (Block Kit alerts). |
| `KIRO_API_KEY` | yes | API key used to authenticate the headless Kiro CLI child process (passed via env, never baked into args). |
| `REPO_URL` | no | HTTPS clone/remote URL of the single target repository the agent operates on. |
| `WEBHOOK_SECRET` | yes | Shared secret used to authenticate inbound `/webhook` requests via HMAC-SHA256. |
| `KIRO_TIMEOUT_MS` | no | Maximum time (ms) a Kiro triage run may take before it is killed. Must be a positive number. Default in `.env.example`: `120000`. |
| `PORT` | no | Port the Express webhook server listens on. Defaults to `3000`. |

All of `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `KIRO_API_KEY`, `REPO_URL`, `WEBHOOK_SECRET`,
and `KIRO_TIMEOUT_MS` are required at startup; a missing one stops the Controller at boot.

## Run, test, lint

```bash
npm start      # node src/server.js — boots the Controller (validates config, then listens)
npm run dev    # same, with --watch for local development
npm test       # jest — unit and property-based tests
npm run lint   # eslint .
```

`npm start` validates configuration first; if a required variable is missing it exits
non-zero with a key-only message (no secret values). On success it logs the listening port.

## Deploy with Docker

The image installs Git, Node, and (via a documented build placeholder) the Kiro CLI. It
bakes in **no secrets** — supply them at runtime via environment variables.

```bash
# from auto-triage-agent/
docker build -t auto-triage-agent .

# run, passing secrets from your local .env (env-based, never baked into the image)
docker run --rm -p 3000:3000 --env-file .env auto-triage-agent
```

The container runs as an always-on worker, exposes the webhook port, and includes a
`/health` liveness healthcheck. See the `Dockerfile` for how to enable the Kiro CLI
install for your distribution channel (provided as a non-secret `--build-arg`).

## Firing a simulated incident

Incidents arrive as **simulated CloudWatch webhooks** — direct HTTP `POST` requests to
`/webhook`. Every request must carry an `x-signature` header containing the lowercase
hex HMAC-SHA256 of the **raw request body** computed with `WEBHOOK_SECRET`. A missing or
incorrect signature is rejected with `401` before any parsing or orchestration.

The payload must contain at least one `[ERROR]` line; the first such line becomes the
`errorMessage` and the remaining lines become the `stackTrace`.

`tests/simulate_webhook.sh` fires a mock CloudWatch `[ERROR]` payload at a locally running
Controller with a valid signature. The equivalent done by hand:

```bash
# 1. The error payload (matches the mock-app's [ERROR] + stack-trace format)
PAYLOAD='[ERROR] Cannot read properties of null (reading '\''profile'\'')
    at readUserId (/app/mock-app/server.js:1:1)
    at /app/mock-app/server.js:1:1'

# 2. Compute the HMAC-SHA256 (hex) of the RAW body using WEBHOOK_SECRET
SIGNATURE=$(printf '%s' "$PAYLOAD" \
  | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

# 3. POST it to the running Controller
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIGNATURE" \
  --data "$PAYLOAD"
# -> 202 Accepted { "accepted": true, "incidentId": "inc-..." }
```

> The signature must be computed over the exact raw bytes that are sent; any modification
> of the body invalidates it (that is the point of the timing-safe HMAC check).

### Using the mock app as the target

`mock-app/` is a minimal API that intentionally throws the two in-scope error types and
logs them in the exact `[ERROR]` format the parser consumes:

```bash
# from auto-triage-agent/
node mock-app/server.js          # listens on http://localhost:4000 (set MOCK_APP_PORT to override)

curl http://localhost:4000/null-pointer                    # -> TypeError (null dereference)
curl -X POST http://localhost:4000/bad-json --data 'not json'   # -> SyntaxError (bad JSON parse)
```

Copy the `[ERROR]` block the app writes to stderr into the payload above to simulate a
real incident end to end. See `mock-app/README.md` for the CloudWatch
`awslogs-multiline-pattern` used to group a multiline stack trace into a single event.

## Human-in-the-loop constraint

The agent is intentionally **not** allowed to ship code on its own:

- It **never pushes to `main`/production** — it commits and pushes to `hotfix/<incident-id>`
  only. Any operation that resolves to `main`/`production` is rejected with a structured error.
- It **never merges** a Pull Request. The agent stops at opening the PR; a human reviews
  and merges.
- The system prompt reinforces these guardrails for the Kiro run itself (no push, no merge,
  no history rewrites, edits confined to the worktree).

## Security considerations

- **Authenticated, network-exposed webhook.** `/webhook` rejects unauthenticated requests
  using a shared-secret HMAC-SHA256 compared in **constant time** (`crypto.timingSafeEqual`,
  no short-circuit on first mismatch). An unauthenticated trigger is not permitted.
- **Injection prevention.** Incident IDs are sanitized against a strict allowlist
  (`^inc-[A-Za-z0-9-]+$`) before they ever touch a shell command or filesystem path. All
  `child_process` invocations (`git`, the Kiro CLI) use **argument arrays**, never
  interpolated shell strings.
- **Secret hygiene.** All secrets come from environment variables, are validated at startup,
  are never logged, and are scrubbed from the error snippet sent to Slack. The snippet is
  also truncated to a fixed maximum length.
- **Per-incident isolation.** Each incident runs in its own `git worktree`; the Kiro process
  is scoped to that directory (`cwd`) so it cannot affect other incidents or the main
  checkout. The `KIRO_API_KEY` is passed via the child's environment, not its arguments.

## Hackathon scope limits

- **Single target repository** identified by `REPO_URL`.
- **Simulated CloudWatch webhooks** delivered as direct HTTP `POST` requests (no real
  CloudWatch/SNS integration).
- **Codebase-related runtime errors only** — null pointer dereferences and bad JSON parsing
  are the supported cases. Infrastructure-level failures such as out-of-memory crashes,
  disk-full, or network outages are explicitly out of scope and are not triaged.

---

_Requirements covered: 6.4, 11.1, 12.1, 12.2, 12.3._
```
