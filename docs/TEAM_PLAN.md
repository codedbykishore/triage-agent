# Auto-Triage Kiro Agent — Team Plan (3-Person, Feature-Based Ownership)

> Expands `PLAN.md` into granular, actionable sub-tasks grouped into **three self-contained
> feature modules**. Each developer owns the **full vertical slice** of their feature (logic,
> config, error handling, security, and tests) — work is split by feature, **not** by technical layer.

## Module Map

| Module | Feature | Owner | Source files |
|--------|---------|-------|--------------|
| 1 | Incident Ingestion & Orchestration | **Person A** | `server.js`, orchestrator, `Dockerfile`, `.env.example`, `simulate_webhook.sh` |
| 2 | Isolated Workspace & AI Triage | **Person B** | `worktreeManager.js`, `kiroRunner.js`, `system_prompts/incident_responder.txt`, mock app |
| 3 | Resolution Delivery & Notifications | **Person C** | `githubInteractions.js`, `slackNotifier.js`, README/docs |

### The Shared Contract (agree on this FIRST — Day 1, all three)

The orchestrator (A) is the only component that calls into B and C. Lock these interfaces before
parallel work begins so everyone can mock against them:

```text
# Module 2 (Person B) exposes:
createWorktree(incidentId, errorPayload) -> { worktreePath }
runKiro(worktreePath) -> { success: bool, summary, changedFiles[], logs }
removeWorktree(incidentId) -> void

# Module 3 (Person C) exposes:
publishFix(worktreePath, incidentId, errorContext) -> { prUrl, branchName }
notify({ status, errorSnippet, prUrl }) -> void

# Shared incident object (produced by A, consumed by B & C):
{ incidentId, errorSnippet, stackTrace, rawPayload, timestamp }
```

This contract is the single most important coordination artifact. Put it in a shared
`src/contracts.md` (or typed interface) that all three reference.

---

## 👤 Person A — Module 1: Incident Ingestion & Orchestration

**Owns:** the entry point, request intake, the end-to-end conductor, container, and local sim tooling.
Also leads shared project scaffolding (Phase 0) since they own the bootstrap/entry point.

### Tasks

1. **Project scaffolding (shared, A-led)**
   - [ ] Create `auto-triage-agent/` tree per `structure.md`
   - [ ] `package.json` with `express`, `axios`, `dotenv` (+ dev: test runner, ESLint/Prettier)
   - [ ] `.gitignore` (`node_modules`, `.env`, `worktrees/`, `*.log`)
   - [ ] npm scripts: `start`, `dev`, `test`, `lint`
   - **Acceptance:** `npm install` succeeds; `npm start` boots an empty server; lint runs clean.

2. **Config & env validation**
   - [ ] `.env.example` with `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `KIRO_API_KEY`, `REPO_URL`
   - [ ] Loader that validates required vars on startup, **fail-fast** with a clear message
   - **Acceptance:** missing var → process exits non-zero with the var name (no secret values logged).

3. **Webhook receiver (`server.js`)**
   - [ ] `POST /webhook` accepting CloudWatch/SNS payloads
   - [ ] `GET /health` returning 200
   - [ ] **Security:** authenticate inbound requests (shared secret header or SNS signature) — reject
         unauthenticated calls (endpoint is network-exposed)
   - [ ] Return `202 Accepted` immediately; process asynchronously
   - **Acceptance:** unauthenticated POST → 401; valid POST → 202 and triggers orchestration.

4. **Payload parsing & incident ID**
   - [ ] Parse multiline `[ERROR]` + stack trace into the shared incident object
   - [ ] Generate unique `inc-<timestamp/uuid>` ID
   - **Acceptance:** sample CloudWatch payload → correct incident object; IDs never collide.

5. **Orchestration & cleanup (the conductor)**
   - [ ] Wire flow: parse → `createWorktree` → `runKiro` → (on success) `publishFix` → `notify` → cleanup
   - [ ] Guaranteed `removeWorktree` in a `finally` block (success or failure)
   - [ ] Error boundaries so one failing incident never blocks others; send failure Slack variant
   - **Acceptance:** simulated end-to-end run (B/C mocked) completes and always cleans up the worktree.

6. **Containerization (`Dockerfile`)**
   - [ ] Base image with Git + Node + Kiro installed
   - [ ] Install deps, copy source, run as always-on worker; expose webhook port
   - [ ] Secrets via env (never baked into image)
   - **Acceptance:** `docker build` succeeds; container boots and responds on `/health`.

7. **Local simulation (`tests/simulate_webhook.sh`)**
   - [ ] Script that POSTs a mock CloudWatch `[ERROR]` to localhost
   - **Acceptance:** running it against the local server triggers a full (mocked) incident flow.

8. **Tests (own slice):** unit tests for parsing, ID generation, env validation, auth middleware; integration test for orchestration with B/C mocked.

### Person A coordinates with:
- **B & C:** owns and maintains the **shared contract**; circulates any interface change.
- **B:** confirms `createWorktree/runKiro/removeWorktree` signatures + return shapes.
- **C:** confirms `publishFix/notify` signatures; agrees what `errorContext` the orchestrator passes.
- **B:** aligns on the `simulate_webhook.sh` error format so it matches the mock app's real output.

---

## 👤 Person B — Module 2: Isolated Workspace & AI Triage

**Owns:** the isolation layer, the Kiro fix engine, the agent's behavior prompt, and the mock
production app that serves as the triage test target.

### Tasks

1. **Worktree Manager (`worktreeManager.js`)**
   - [ ] `createWorktree(incidentId, errorPayload)` → `git worktree add ../worktrees/<id> main`
   - [ ] Write `error.log` payload into the new worktree dir
   - [ ] `removeWorktree(incidentId)` → `git worktree remove` (handle/cleanup partial failures)
   - [ ] **Security:** sanitize/escape incident IDs and all shell inputs (no path/command injection)
   - [ ] Guarantee isolation for concurrent incidents (no worktree collisions)
   - **Acceptance:** two simultaneous incidents get separate worktrees; malicious ID is rejected; removal leaves no orphan dirs.

2. **Kiro Invoker (`kiroRunner.js`)**
   - [ ] `runKiro(worktreePath)` spawns a Kiro child process scoped to the worktree
   - [ ] Load system prompt; instruct it to read `error.log`, locate failing file, write fix
   - [ ] Capture stdout/stderr + exit code; enforce a timeout
   - [ ] Return `{ success, summary, changedFiles, logs }`
   - **Acceptance:** given a worktree with a known bug, Kiro exits with a fix; timeout kills a hung run.

3. **System prompt (`system_prompts/incident_responder.txt`)**
   - [ ] Define Kiro's role inside the worktree
   - [ ] Constrain to codebase-related bugs (null pointer, bad JSON parse) — not infra/OOM
   - [ ] Limit edits to affected file(s); **explicit guardrail: never push to `main`/production**
   - **Acceptance:** prompt reliably produces a scoped fix on the mock app's seeded bugs.

4. **Mock Production App (test target)**
   - [ ] Minimal API that intentionally throws (null pointer, bad JSON parse)
   - [ ] Logs exceptions starting with `[ERROR]` + full stack trace
   - [ ] Document the CloudWatch `awslogs-multiline-pattern` for multiline grouping
   - **Acceptance:** hitting the bad endpoints emits the exact `[ERROR]` format the webhook expects.

5. **Tests (own slice):** unit tests with mocked `child_process` for worktree create/remove; a test that runs Kiro against a seeded bug in the mock app and asserts a fix is produced.

### Person B coordinates with:
- **A:** lock `createWorktree/runKiro/removeWorktree` signatures; agree on the incident object shape and the `error.log` file location/format.
- **A:** align the mock app's `[ERROR]` log format with `simulate_webhook.sh` and the parser.
- **C (critical):** decide the **git ownership boundary** — does **Kiro** run `checkout/commit/push/PR`
  (per `tech.md` flow), or does it only edit files and hand off to C's `publishFix`? This overlap
  must be resolved so commits aren't done twice or skipped. Agree on the post-run worktree state
  (e.g., "changes made and committed to `hotfix/<id>`" vs. "uncommitted edits ready for C").

---

## 👤 Person C — Module 3: Resolution Delivery & Notifications

**Owns:** turning a completed fix into a reviewable PR and notifying humans — the human-in-the-loop
delivery layer — plus project documentation.

### Tasks

1. **Git operations & PR (`githubInteractions.js`)**
   - [ ] Helpers: `git checkout -b hotfix/<id>`, `git add .`, `git commit`, `git push -u`
   - [ ] **Push to a new branch only — never `main`/production**
   - [ ] `publishFix(worktreePath, incidentId, errorContext)` creates a PR via GitHub API/CLI (`gh pr create`) using `GITHUB_TOKEN`
   - [ ] PR title < 70 chars; body = error summary, affected file(s), what was tested
   - [ ] Return `{ prUrl, branchName }`; handle auth/push/PR failures gracefully
   - **Acceptance:** a fixed worktree produces a real PR against the target repo; failure returns a clear error, never crashes the orchestrator.

2. **Slack notifier (`slackNotifier.js`)**
   - [ ] `notify({ status, errorSnippet, prUrl })` posts to `SLACK_WEBHOOK_URL`
   - [ ] Block Kit message: status (Fix prepared), error snippet, PR link → `#qa`
   - [ ] Failure variant when triage couldn't produce a fix; handle delivery errors
   - **Acceptance:** success path posts a formatted card with a clickable PR link; failure path posts the alert variant.

3. **Documentation (`README.md` + docs)**
   - [ ] Architecture overview, setup, env var reference, run/deploy instructions
   - [ ] Document human-in-the-loop constraint and security considerations
   - [ ] Document hackathon scope limits (single repo, simulated webhooks, codebase-only errors)
   - **Acceptance:** a new dev can set up and run a local dry-run from the README alone.

4. **Tests (own slice):** unit tests for PR body formatting and branch-naming; Slack payload formatting test with the webhook mocked; both success and failure variants covered.

### Person C coordinates with:
- **A:** lock `publishFix/notify` signatures; agree what `errorContext`/`errorSnippet` the orchestrator passes and the call order (publish → then notify with the returned `prUrl`).
- **B (critical):** resolve the **git ownership boundary** (see B's note) — confirm whether C commits/pushes or only opens the PR on top of Kiro's commits. Agree on `hotfix/<id>` branch naming so both sides match.
- **B:** the mock app is the repo C's PRs target — coordinate `REPO_URL`/permissions for the demo.

---

## Workload Balance & Critical Integration Points

**Balance:** Each owner gets one heavy core component plus supporting work — A: scaffolding + webhook + orchestration + Docker; B: worktree + Kiro + prompt + mock app; C: git/PR + Slack + docs. Roughly even in effort and complexity.

**Critical integration points (watch these):**
1. **Shared contract (A↔B↔C):** the interface signatures above — agree Day 1, mock against them.
2. **Git ownership boundary (B↔C):** the biggest risk — who runs the git commit/push (Kiro vs. `githubInteractions.js`). Decide explicitly to avoid duplicate/missing commits.
3. **Error log format (A↔B):** the mock app's `[ERROR]` output, the `simulate_webhook.sh` payload, and the parser must all agree.
4. **Branch naming `hotfix/<id>` (B↔C):** must be consistent wherever the branch is created.
5. **Target repo / `REPO_URL` (all three):** the mock app is both B's deliverable and C's PR target and A's error source.

## Day-1 Joint Tasks (all three together)
- [ ] Finalize and commit the shared contract (`src/contracts.md` or typed interfaces)
- [ ] Resolve the git ownership boundary decision and record it
- [ ] Agree on the `[ERROR]` log format and the incident object shape
