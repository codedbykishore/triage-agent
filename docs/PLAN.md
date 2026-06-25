# Auto-Triage Kiro Agent — Implementation Plan

> Planning document for the autonomous, event-driven incident response system.
> Derived from `.kiro/steering/{product,tech,structure}.md`.

## Goal Recap

An always-on Agent Controller that listens for CloudWatch/SNS error webhooks, spins up an
isolated `git worktree` per incident, lets Kiro read the error log and write a fix, opens a
`hotfix/` PR, and alerts the `#qa` Slack channel. **A human always reviews/merges — the agent
never pushes to production.**

### Target structure (from `structure.md`)

```text
auto-triage-agent/
├── Dockerfile
├── package.json (or reqs.txt)
├── .env.example
├── src/
│   ├── server.js
│   ├── worktreeManager.js
│   ├── kiroRunner.js
│   ├── slackNotifier.js
│   └── githubInteractions.js
├── system_prompts/
│   └── incident_responder.txt
└── tests/
    └── simulate_webhook.sh
```

---

## Phase 0 — Project Setup & Scaffolding

- [ ] Decide runtime (Node.js/Express assumed per blueprint; FastAPI is the alt)
- [ ] Create `auto-triage-agent/` project root with the blueprint directory tree
- [ ] Initialize `package.json` with deps: `express`, `axios`, `dotenv` (+ dev: a test runner, linter)
- [ ] Create `.env.example` with: `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `KIRO_API_KEY`, `REPO_URL`
- [ ] Add `.gitignore` (node_modules, `.env`, `worktrees/`, `*.log`)
- [ ] Add config loader that validates required env vars on startup (fail fast if missing)
- [ ] Set up linter/formatter (ESLint + Prettier) and an npm `start`/`dev`/`test` scripts

## Phase 1 — Webhook Receiver (`src/server.js`)

- [ ] Express app with `POST /webhook` endpoint for CloudWatch/SNS payloads
- [ ] Health check endpoint `GET /health`
- [ ] **Security:** validate the inbound request (shared secret/SNS signature) — endpoint is
      network-exposed; do not accept unauthenticated triggers in real use
- [ ] Parse the CloudWatch multiline `[ERROR]` + stack trace payload into a normalized object
- [ ] Generate a unique incident ID (e.g., `inc-<timestamp/uuid>`)
- [ ] Hand off to the orchestration flow asynchronously; return `202 Accepted` immediately
- [ ] Centralized error handling + structured logging

## Phase 2 — Worktree Manager (`src/worktreeManager.js`)

- [ ] `createWorktree(incidentId)` → `git worktree add ../worktrees/<id> main` via `child_process`
- [ ] Write the `error.log` payload into the new worktree directory
- [ ] `removeWorktree(incidentId)` → `git worktree remove` (with cleanup on failure)
- [ ] Guard against path injection from incident IDs; sanitize/escape all shell inputs
- [ ] Ensure concurrent incidents get isolated worktrees (no collisions)

## Phase 3 — Kiro Invoker (`src/kiroRunner.js`)

- [ ] `runKiro(worktreePath)` spawns a child Kiro process scoped to the worktree
- [ ] Load system prompt from `system_prompts/incident_responder.txt`
- [ ] Pass instructions: read `error.log`, locate the failing file, write the fix
- [ ] Capture stdout/stderr + exit code; enforce a timeout
- [ ] Detect process exit to trigger downstream Git ops + cleanup

## Phase 4 — System Prompt (`system_prompts/incident_responder.txt`)

- [ ] Author the prompt defining Kiro's role inside the worktree
- [ ] Instructions: read `error.log`, navigate codebase, fix only codebase-related bugs
      (null pointers, bad JSON parsing — not infra/OOM)
- [ ] Constrain to the affected file(s); commit to a `hotfix/<id>` branch
- [ ] Explicit guardrail: never push to `main`/production

## Phase 5 — Git Operations & PR Creation (`src/githubInteractions.js`)

- [ ] Helpers: `git checkout -b hotfix/<id>`, `git add .`, `git commit`, `git push -u`
- [ ] Push to a **new branch only** (never `main`)
- [ ] Create PR via GitHub API/CLI (`gh pr create`) using `GITHUB_TOKEN`
- [ ] PR title concise (<70 chars) + body: error summary, affected file, what was tested
- [ ] Return PR URL for the Slack step
- [ ] Handle auth/push/PR failures gracefully and surface errors

## Phase 6 — Slack Notifier (`src/slackNotifier.js`)

- [ ] `notify({status, errorSnippet, prUrl})` posts to `SLACK_WEBHOOK_URL`
- [ ] Format Block Kit message: status (Fix prepared), error snippet, PR link
- [ ] Send failure/alert variant if triage couldn't produce a fix
- [ ] Handle webhook delivery errors

## Phase 7 — Orchestration & Cleanup

- [ ] Wire the end-to-end flow: webhook → worktree → Kiro → git/PR → Slack → cleanup
- [ ] Always run `git worktree remove` on success or failure (finally-style cleanup)
- [ ] Ensure one failed incident doesn't block others (isolation + error boundaries)

## Phase 8 — Containerization (`Dockerfile`)

- [ ] Base image with Git, Node (or Python), and Kiro installed
- [ ] Install app deps and copy source
- [ ] Configure the container as an always-on worker (simulating ECS Fargate)
- [ ] Expose the webhook port; pass env vars/secrets securely (not baked into the image)

## Phase 9 — Testing & Local Simulation

- [ ] `tests/simulate_webhook.sh` — fire a mock CloudWatch `[ERROR]` POST at localhost
- [ ] Unit tests: payload parsing, incident ID generation, env validation, input sanitization
- [ ] Unit tests with mocked `child_process` for worktree + git helpers
- [ ] Integration test: webhook → worktree created → cleanup (Kiro/Git/Slack mocked)
- [ ] Document how to run a full local dry-run against the mock production app

## Phase 10 — Production Mock App (test target)

- [ ] Minimal API that intentionally throws (null pointer, bad JSON parse)
- [ ] Emit logs where exceptions start with `[ERROR]` + stack trace
- [ ] Document CloudWatch `awslogs-multiline-pattern` for multiline grouping
- [ ] Use as the single repository target (`REPO_URL`) for end-to-end demos

## Phase 11 — Documentation

- [ ] `README.md`: architecture overview, setup, env vars, run/deploy instructions
- [ ] Document the human-in-the-loop constraint and security considerations
- [ ] Document hackathon scope limits (single repo, simulated webhooks, codebase-only errors)

---

## Cross-Cutting Concerns

- **Security:** authenticate the webhook endpoint; never log secret values; sanitize shell inputs.
- **Human-in-the-loop:** agent stops at PR — no auto-merge, no direct push to `main`.
- **Isolation:** every incident is fully isolated via its own worktree; guaranteed cleanup.
- **Scope:** codebase-related runtime errors only (not infra/OOM), single target repo.

## Suggested Build Order

1. Phase 0 → 1 → 2 (skeleton + webhook + worktree foundation)
2. Phase 3 → 4 (Kiro integration + prompt)
3. Phase 5 → 6 → 7 (git/PR + Slack + orchestration)
4. Phase 8 (containerize)
5. Phase 9 → 10 (testing + mock app)
6. Phase 11 (docs) — kept current throughout
