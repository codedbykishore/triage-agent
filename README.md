# Auto-Triage Agent

> **Autonomous, event-driven incident response powered by the headless Kiro CLI.**
> Production error hits → isolated worktree → AI triage → hotfix PR → Slack alert.
> Human reviews. Human merges. The agent never ships alone.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why It Exists](#why-it-exists)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Metrics](#metrics)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Running](#running)
- [Docker Deployment](#docker-deployment)
- [Firing a Simulated Incident](#firing-a-simulated-incident)
- [Mock App](#mock-app)
- [Testing](#testing)
- [Infrastructure](#infrastructure)
- [Security](#security)
- [Human-in-the-Loop](#human-in-the-loop)
- [Limitations](#limitations)
- [License](#license)

---

## What It Does

When a production service throws a runtime error, mean-time-to-recovery is bottlenecked by human reaction time: someone has to pull the logs, find the failing file, write a hotfix, and open a PR. **The Auto-Triage Agent eliminates that first pass.**

It listens for error notifications via an authenticated webhook, spins up an isolated workspace, drives Kiro headlessly to produce a code fix, opens a hotfix Pull Request, and alerts the team in Slack — then stops and waits for a human.

## Why It Exists

| Metric | Manual Process | With Auto-Triage Agent |
|--------|---------------|----------------------|
| Log collection | Minutes (manual pull) | Instant (webhook-triggered) |
| Root cause identification | Minutes–Hours (human reads stack trace) | Seconds (Kiro reads `error.log`) |
| Fix authoring | Minutes–Hours (human writes code) | Seconds (Kiro edits source) |
| PR creation | Minutes (human creates branch + PR) | Instant (automated) |
| Team notification | Manual (human posts in Slack) | Instant (Block Kit alert to `#qa`) |
| **Total time to actionable PR** | **Minutes to hours** | **Seconds** |

The agent handles the repetitive first-pass triage — the 80% of production errors that are null dereferences, bad JSON parses, and similar code-level bugs — so engineers can focus on review, merge, and deeper systemic fixes.

---

## How It Works

### Incident Lifecycle

```
CloudWatch/SNS error
        │
        ▼
  POST /webhook (HMAC-SHA256 authenticated)
        │
        ▼
  202 Accepted  ──▶  async handoff to Orchestrator
                          │
                          ▼
                   generateIncidentId()
                          │
                          ▼
                   createWorktree()  ──▶  git worktree add ../worktrees/<id>
                          │                write error.log
                          ▼
                   runKiro()  ──▶  headless Kiro CLI reads error.log
                          │        identifies bug, writes fix
                          │
              ┌───────────┴───────────┐
              │                       │
         exitCode === 0         exitCode !== 0
         timedOut === false      OR timedOut === true
              │                       │
              ▼                       ▼
     commitAndPush()          notify({status:"failed"})
     createPullRequest()              │
              │                       │
              ▼                       ▼
     notify({status:"fixed"})   ┌─────┘
              │                       │
              └───────────┬───────────┘
                          ▼
                   removeWorktree()  ◀── ALWAYS runs (finally block)
```

### Step-by-Step

For each inbound notification the Agent Controller:

1. **Authenticates** the webhook (timing-safe HMAC-SHA256) and returns `202 Accepted` immediately, processing the incident out of band.
2. Generates a unique, injection-safe incident ID (`inc-<timestamp36>-<entropy>`) and provisions an **isolated `git worktree`**, writing the raw error payload as `error.log`.
3. Runs the **headless Kiro CLI** scoped to that worktree — reads the error, locates the failing file(s), and writes a minimal fix.
4. On success: commits to `hotfix/<incident-id>`, pushes the branch, and opens a **GitHub Pull Request** targeting `main` for human review.
5. Posts a **Slack Block Kit alert to `#qa`** with the incident status, a secret-free error snippet, and (on success) the PR link.
6. **Always removes the worktree** in a `finally` block — on success, failure, timeout, or thrown error.

If Kiro fails, times out, or any step throws, no branch or PR is produced; a `failed` Slack notification is sent and the worktree is still cleaned up.

---

## Architecture

The Controller is organized around a central **Orchestrator** that sequences the lifecycle and guarantees cleanup. Each module has a single responsibility; all side effects (shell commands, network calls, process spawning) are isolated behind module boundaries.

### Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Auto-Triage Agent                            │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  server.js    │───▶│ orchestrator │───▶│  worktreeManager.js  │  │
│  │  (webhook     │    │  (lifecycle  │    │  (git worktree       │  │
│  │   receiver)   │    │   conductor) │    │   create/remove)     │  │
│  └──────────────┘    └──────┬───────┘    └──────────────────────┘  │
│         │                    │                                      │
│         │                    ├──────────▶  kiroRunner.js            │
│         │                    │            (headless Kiro CLI)       │
│         │                    │                                      │
│         │                    ├──────────▶  githubInteractions.js    │
│         │                    │            (branch, commit, push,    │
│         │                    │             open PR)                 │
│         │                    │                                      │
│         │                    └──────────▶  slackNotifier.js         │
│         │                                 (Block Kit alerts)       │
│         │                                                          │
│  ┌──────┴───────┐    ┌──────────────┐                              │
│  │  config.js    │    │ incident.js   │                              │
│  │  (env loader, │    │ (ID gen,      │                              │
│  │   fail-fast)  │    │  parsing,     │                              │
│  └──────────────┘    │  validators)  │                              │
│                       └──────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | File | Responsibility | Side Effects |
|--------|------|----------------|-------------|
| Webhook Receiver | `src/server.js` | Authenticate `/webhook` (timing-safe HMAC), parse payload, generate incident ID, respond `202`, async handoff. Expose `GET /health`. | HTTP I/O |
| Orchestrator | `src/orchestrator.js` | Sequence worktree → Kiro → commit/push/PR → notify. Guarantee cleanup in `finally`. | None directly |
| Worktree Manager | `src/worktreeManager.js` | Create/remove per-incident `git worktree` directories. Sanitize incident IDs. Write `error.log`. | `git`, filesystem |
| Kiro Runner | `src/kiroRunner.js` | Invoke Kiro CLI headlessly (non-interactive, one-shot) as a child process scoped to the worktree. Enforce timeout. | `child_process` |
| GitHub Interactions | `src/githubInteractions.js` | Create `hotfix/<id>` branch, commit, push, open Pull Request. Reject protected branch operations. | `git`, GitHub API |
| Slack Notifier | `src/slackNotifier.js` | Build and deliver Slack Block Kit alerts to `#qa`. Build secret-free, length-bounded error snippet. Best-effort (never throws). | HTTP I/O |
| Config Loader | `src/config.js` | Load/validate environment variables at startup (fail-fast). Expose secret values for scrubbing. | None |
| Incident Helpers | `src/incident.js` | Pure helpers: `generateIncidentId()`, `parsePayload()`, validators for `Incident`/`KiroResult`/`Notification`. | None |

### Interface Contracts

All module interfaces are locked in `src/contracts.md`. The Orchestrator (Module 1) is the only component that calls into Module 2 (workspace/AI) and Module 3 (delivery/notifications). This boundary enables parallel development with mocked collaborators.

---

## Project Structure

```
triage-agent/
├── auto-triage-agent/              # Agent Controller (core)
│   ├── src/
│   │   ├── server.js               # Express webhook receiver + entry point
│   │   ├── orchestrator.js         # Incident lifecycle conductor
│   │   ├── worktreeManager.js      # Git worktree create/remove
│   │   ├── kiroRunner.js           # Headless Kiro CLI invoker
│   │   ├── githubInteractions.js   # Git ops + GitHub PR creation
│   │   ├── slackNotifier.js        # Slack Block Kit alerts
│   │   ├── deployNotifier.js       # Deployment notifications
│   │   ├── config.js               # Environment variable loader
│   │   ├── incident.js             # Pure helpers + data models
│   │   └── contracts.md            # Locked module interfaces
│   ├── system_prompts/
│   │   └── incident_responder.txt  # Kiro system prompt
│   ├── tests/
│   │   ├── server.test.js
│   │   ├── config.test.js
│   │   ├── incident.parse.test.js
│   │   ├── incident.parse.property.test.js
│   │   ├── incident.id.property.test.js
│   │   ├── worktreeManager.test.js
│   │   ├── worktree.sanitize.property.test.js
│   │   ├── kiroRunner.test.js
│   │   ├── githubInteractions.test.js
│   │   ├── github.branch.property.test.js
│   │   ├── slackNotifier.test.js
│   │   ├── slack.snippet.property.test.js
│   │   ├── orchestrator.notify.property.test.js
│   │   ├── orchestrator.cleanup.property.test.js
│   │   ├── orchestrator.pr.property.test.js
│   │   ├── server.auth.property.test.js
│   │   ├── integration.webhook.test.js
│   │   └── simulate_webhook.sh     # Fire a mock CloudWatch webhook
│   ├── mock-app/
│   │   ├── server.js               # Deliberately buggy target API
│   │   └── README.md
│   ├── scripts/
│   │   └── demo-terminal.sh        # Live demo: tmux + ttyd web terminal
│   ├── Dockerfile
│   ├── package.json
│   ├── .env.example
│   ├── .eslintrc.json
│   └── .gitignore
├── frontend/                       # OrderFlow demo dashboard
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── pages/ (Dashboard, Orders, UserProfile)
│   │   ├── components/ (ErrorBoundary)
│   │   └── config.js
│   ├── package.json
│   └── vite.config.js
├── infra/
│   ├── ec2-user-data.sh            # EC2 bootstrap (CloudWatch + PM2)
│   ├── lambda/index.mjs            # CloudWatch Logs → webhook forwarder
│   └── mock-kiro.sh                # Simulates headless Kiro for demos
├── docs/
│   ├── PLAN.md                     # Implementation plan
│   └── TEAM_PLAN.md                # 3-person team task breakdown
└── .kiro/                          # Kiro specs and AIDLC rules
```

---

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Runtime | Node.js | 18+ (container: 20) | Server runtime |
| Web Framework | Express | ^4.21.0 | Webhook receiver |
| HTTP Client | Axios | ^1.7.7 | Slack/GitHub API calls |
| Config | dotenv | ^16.4.5 | Environment variable loading |
| AI Engine | Kiro CLI | headless | Code analysis and fix generation |
| VCS | Git (worktree) | — | Per-incident isolated workspaces |
| Container | Docker | — | Production deployment |
| Demo | tmux + ttyd | 1.7.7 | Live web terminal for demos |
| Test Runner | Jest | ^29.7.0 | Unit + property-based tests |
| Property Testing | fast-check | ^3.22.0 | Fuzz/property-based test generation |
| Linter | ESLint | ^8.57.1 | Code quality |
| Formatter | Prettier | ^3.3.3 | Code formatting |
| Frontend Demo | React + Vite | ^18.2.0 / ^5.0.0 | OrderFlow dashboard |
| Process Mgmt | PM2 | — | EC2 process supervision |
| Log Shipping | CloudWatch Agent | — | EC2 → CloudWatch log forwarding |
| Log Forwarding | Lambda | — | CloudWatch → webhook relay |

---

## Metrics

| Metric | Value |
|--------|-------|
| Source modules | 9 (`src/*.js`) |
| Source lines of code | ~2,120 |
| Test files | 17 |
| Test lines of code | ~2,071 |
| Unit test suites | 8 |
| Property-based test suites | 9 |
| Integration test suites | 1 |
| Supported error types | 2 (null dereference, bad JSON parse) |
| Max snippet length (Slack) | 500 chars |
| Default Kiro timeout | 120,000 ms (2 min) |
| Required env vars | 5 (all validated at startup) |
| Optional env vars | 2 |
| API endpoints | 2 (`POST /webhook`, `GET /health`) |
| Docker base image | `node:20-bookworm-slim` |
| Container exposed ports | 2 (3000: webhook, 7681: demo terminal) |
| Health check interval | 30s (5s timeout, 10s start period) |

---

## Quick Start

### Prerequisites

- **Node.js** 18+ (container uses Node 20)
- **Git** (worktree manager and GitHub interactions shell out to `git`)
- **Kiro CLI** (headless binary that performs triage inside each worktree)

### 1. Install

```bash
cd auto-triage-agent
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with real values — never commit it
```

The Config Loader validates every required variable at startup and **fails fast** (exits non-zero) naming any missing variable by key — secret values are never logged.

### 3. Run

```bash
npm start       # boots the Controller (validates config, then listens on :3000)
npm run dev     # same, with --watch for local development
```

### 4. Test

```bash
npm test        # jest — unit and property-based tests
npm run lint    # eslint .
```

---

## Configuration

All values are sourced from the environment. Secrets are never written to logs and are scrubbed from any error snippet sent to Slack.

| Variable | Required | Secret | Description |
|----------|:--------:|:------:|-------------|
| `GITHUB_TOKEN` | yes | yes | Token to push hotfix branches and open PRs. Needs `repo` scope on the target repository. |
| `SLACK_WEBHOOK_URL` | yes | yes | Slack Incoming Webhook URL for the `#qa` channel (Block Kit alerts). |
| `KIRO_API_KEY` | yes | yes | API key for the headless Kiro CLI (passed via env, never baked into args). |
| `REPO_URL` | yes | no | HTTPS clone/remote URL of the single target repository. |
| `WEBHOOK_SECRET` | yes | yes | Shared secret for HMAC-SHA256 authentication of inbound `/webhook` requests. |
| `KIRO_TIMEOUT_MS` | yes | no | Max time (ms) a Kiro triage run may take before it is killed. Must be a positive number. Default: `120000`. |
| `PORT` | no | no | Port the Express webhook server listens on. Default: `3000`. |
| `SLACK_DEPLOYMENTS_WEBHOOK_URL` | no | yes | Slack webhook for the `#deployments` channel (deployment notifications). |
| `PR_REVIEWERS` | no | no | Comma-separated GitHub usernames to request as PR reviewers. Default: `heyitsgautham`. |

All of `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `KIRO_API_KEY`, `REPO_URL`, `WEBHOOK_SECRET`, and `KIRO_TIMEOUT_MS` are required at startup; a missing one stops the Controller at boot.

---

## Running

```bash
npm start       # node src/server.js — boots the Controller
npm run dev     # same, with --watch for local development
npm test        # jest — unit and property-based tests
npm run lint    # eslint .
```

`npm start` validates configuration first; if a required variable is missing it exits non-zero with a key-only message (no secret values). On success it logs the listening port.

---

## Docker Deployment

The image installs Git, Node, ttyd (web terminal for demos), and (via a documented build placeholder) the Kiro CLI. It bakes in **no secrets** — supply them at runtime via environment variables.

### Build

```bash
cd auto-triage-agent
docker build -t auto-triage-agent .
```

### Run (production)

```bash
docker run --rm -p 3000:3000 --env-file .env auto-triage-agent
```

### Run (live demo — web terminal)

```bash
docker run --rm -p 3000:3000 -p 7681:7681 \
  --env-file .env auto-triage-agent \
  ./scripts/demo-terminal.sh
```

This starts the controller inside a persistent tmux session and serves it to the browser via ttyd at `http://localhost:7681`, so judges can watch the Kiro agent triage an incident in real time.

### Container Details

| Property | Value |
|----------|-------|
| Base image | `node:20-bookworm-slim` |
| Exposed ports | `3000` (webhook), `7681` (demo terminal) |
| Health check | `GET /health` every 30s (5s timeout, 10s start period) |
| Process | `node src/server.js` (always-on worker) |
| Secrets | Runtime env only (never baked into image) |

### CloudWatch Integration (EC2)

The `infra/ec2-user-data.sh` script bootstraps an EC2 instance with:
- Node.js 20 + PM2 for process management
- Amazon CloudWatch Agent shipping stderr logs from the mock app
- Multiline pattern `^\[ERROR\]` grouping stack traces into single log events
- The mock app running as a PM2-managed service

The `infra/lambda/index.mjs` Lambda function receives CloudWatch Logs subscription filter events, extracts `[ERROR]` entries, computes an HMAC-SHA256 signature, and POSTs them to the agent's `/webhook` endpoint.

---

## Firing a Simulated Incident

Incidents arrive as **simulated CloudWatch webhooks** — direct HTTP `POST` requests to `/webhook`. Every request must carry an `x-signature` header containing the lowercase hex HMAC-SHA256 of the **raw request body** computed with `WEBHOOK_SECRET`.

### Using the simulation script

```bash
# From auto-triage-agent/ — requires a running Controller (npm start)
./tests/simulate_webhook.sh
```

Environment overrides:
```bash
HOST=localhost PORT=3000 WEBHOOK_SECRET=mysecret ./tests/simulate_webhook.sh
```

### Manual curl

```bash
# 1. The error payload
PAYLOAD='[ERROR] Cannot read properties of null (reading '\''profile'\'')
    at readUserId (/app/mock-app/server.js:77:15)
    at /app/mock-app/server.js:113:16'

# 2. Compute the HMAC-SHA256 signature
SIGNATURE=$(printf '%s' "$PAYLOAD" \
  | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

# 3. POST to the running Controller
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: text/plain" \
  -H "x-signature: $SIGNATURE" \
  --data-binary "$PAYLOAD"
# -> 202 Accepted { "accepted": true, "incidentId": "inc-..." }
```

> The signature must be computed over the exact raw bytes sent; any modification of the body invalidates it.

---

## Mock App

`mock-app/` is a minimal API that intentionally throws the two in-scope error types and logs them in the exact `[ERROR]` format the parser consumes.

### Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/health` | Returns `200 {"status":"ok"}` |
| GET | `/null-pointer` | Dereferences `null` → `TypeError: Cannot read properties of null` |
| POST | `/bad-json` | `JSON.parse` on unguarded body → `SyntaxError` |

### Run it

```bash
cd auto-triage-agent
node mock-app/server.js          # http://localhost:4000 (MOCK_APP_PORT to override)

curl http://localhost:4000/null-pointer                       # triggers TypeError
curl -X POST http://localhost:4000/bad-json --data 'not json' # triggers SyntaxError
```

### CloudWatch multiline grouping

A single error spans multiple lines (message + stack frames). To keep those grouped into one CloudWatch log event, configure the `awslogs` driver with:

```
awslogs-multiline-pattern: "^\[ERROR\]"
```

Any line not matching `^\[ERROR\]` (the indented `    at ...` frames) is appended to the current event, so the full error arrives together.

---

## Testing

### Test Suites

| Suite | Type | Description |
|-------|------|-------------|
| `server.test.js` | Unit | Webhook receiver: authentication, parsing, 202 response |
| `server.auth.property.test.js` | Property | Authentication soundness across generated inputs |
| `config.test.js` | Unit | Environment variable validation, fail-fast behavior |
| `incident.parse.test.js` | Unit | Payload parsing edge cases |
| `incident.parse.property.test.js` | Property | Payload round-trip preservation (rawPayload === rawBody) |
| `incident.id.property.test.js` | Property | Incident ID safety (allowlist, no injection chars) |
| `worktreeManager.test.js` | Unit | Worktree create/remove with mocked `child_process` |
| `worktree.sanitize.property.test.js` | Property | ID sanitization against injection payloads |
| `kiroRunner.test.js` | Unit | Kiro CLI spawn, timeout, output capture |
| `githubInteractions.test.js` | Unit | Branch naming, protected branch rejection, PR creation |
| `github.branch.property.test.js` | Property | Branch names never resolve to protected branches |
| `slackNotifier.test.js` | Unit | Block Kit payload construction, delivery |
| `slack.snippet.property.test.js` | Property | Error snippet secret-safety and length bounds |
| `orchestrator.notify.property.test.js` | Property | Exactly one notification per terminal execution |
| `orchestrator.cleanup.property.test.js` | Property | Worktree always removed (success, failure, timeout, throw) |
| `orchestrator.pr.property.test.js` | Property | PR created only on successful triage |
| `integration.webhook.test.js` | Integration | End-to-end: webhook → worktree → cleanup (Kiro/Git/Slack mocked) |

### Run

```bash
npm test        # jest (unit + property-based)
npm run lint    # eslint
```

### Property-Based Testing

Property tests use [fast-check](https://github.com/dubzzz/fast-check) to validate universal correctness properties across many generated inputs:

- **Incident ID safety**: sanitization either returns a match for `^inc-[A-Za-z0-9-]+$` or throws — never returns path separators, whitespace, or shell metacharacters.
- **Payload round-trip**: `parsePayload(rawBody).rawPayload` equals `rawBody` exactly.
- **Authentication soundness**: `authenticate` returns `true` iff the signature matches the HMAC; any tampered body returns `false`.
- **Cleanup guarantee**: if a worktree was created, it is always removed before `handleIncident` returns.
- **No push to protected branches**: `commitAndPush` never targets `main` or `production`.
- **PR only on success**: a PR is created iff Kiro exited with code 0 and did not time out.
- **Notification completeness**: exactly one Slack notification per terminal execution.
- **Snippet secret-safety**: the error snippet is bounded in length and contains no configured secret values.

---

## Infrastructure

### AWS Architecture (Production)

```
                    ┌─────────────┐
                    │  CloudWatch  │
                    │    Logs      │
                    └──────┬──────┘
                           │ subscription filter
                           ▼
                    ┌─────────────┐
                    │   Lambda     │
                    │  (forwarder) │
                    └──────┬──────┘
                           │ POST /webhook (HMAC signed)
                           ▼
                    ┌─────────────┐     ┌──────────────┐
                    │  EC2 (ECS    │────▶│  GitHub       │
                    │  Fargate)    │     │  (PR creation)│
                    │  Agent       │     └──────────────┘
                    │  Controller  │
                    └──────┬──────┘     ┌──────────────┐
                           │            │  Slack        │
                           │            │  (#qa channel)│
                           │            └──────────────┘
                           ▼
                    ┌─────────────┐
                    │  Target      │
                    │  Repository  │
                    └─────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `infra/ec2-user-data.sh` | EC2 bootstrap: Node.js, PM2, CloudWatch Agent, mock app |
| `infra/lambda/index.mjs` | CloudWatch Logs → webhook forwarder (HMAC signs each error) |
| `infra/mock-kiro.sh` | Simulates headless Kiro for demo purposes (reads `error.log`, applies fix) |

---

## Security

### Authentication

- **Timing-safe HMAC-SHA256** comparison (`crypto.timingSafeEqual`) on every `/webhook` request.
- Missing or incorrect signature → `401 Unauthorized` before any parsing or orchestration.
- The signature is computed over the exact raw body bytes; any modification invalidates it.

### Injection Prevention

- Incident IDs are sanitized against a strict allowlist (`^inc-[A-Za-z0-9-]+$`) before touching any shell command or filesystem path.
- All `child_process` invocations (`git`, Kiro CLI) use **argument arrays** — never interpolated shell strings.
- Payload-derived values cannot be interpreted by a shell.

### Secret Hygiene

- All secrets come from environment variables, validated at startup.
- Secret values are **never logged** — only variable names/keys appear in error messages.
- Secret values are **scrubbed** from the error snippet sent to Slack using a provably safe redaction marker.
- The snippet is truncated to a fixed maximum length (500 chars).

### Per-Incident Isolation

- Each incident runs in its own `git worktree` — the Kiro process `cwd` is scoped to that directory.
- Concurrent incidents cannot collide or affect each other.
- The `KIRO_API_KEY` is passed via the child's environment, not its arguments.

### Protected Branch Guard

- `commitAndPush` and `createPullRequest` reject any operation that resolves to `main` or `production`.
- The guard is case-insensitive and trims whitespace.

---

## Human-in-the-Loop

The agent is intentionally **not** allowed to ship code on its own:

- **Never pushes to `main`/production** — commits and pushes to `hotfix/<incident-id>` only. Any operation targeting a protected branch is rejected with a structured error.
- **Never merges** a Pull Request. The agent stops at opening the PR; a human reviews and merges.
- **System prompt guardrails** — the Kiro run is constrained: no push, no commit, no branch operations, edits confined to the worktree. The agent only edits source files.

This ensures every code change goes through human review before reaching production.

---

## Limitations

These are intentional scope boundaries for the hackathon:

| Limitation | Description |
|-----------|-------------|
| Single target repository | Operates on one repo identified by `REPO_URL` |
| Simulated webhooks | CloudWatch/SNS integration is simulated via direct HTTP POSTs |
| Codebase errors only | Handles null dereferences and bad JSON parsing — not OOM, disk-full, or network outages |
| No real CloudWatch | Webhooks are delivered manually or via the Lambda forwarder |

---

## License

MIT
