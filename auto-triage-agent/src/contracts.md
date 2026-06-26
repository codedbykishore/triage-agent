# Shared Module Contract

> The single most important coordination artifact for the Auto-Triage Agent.
> The **Orchestrator** (Module 1 / Person A) is the only component that calls into
> Module 2 (Person B) and Module 3 (Person C). These interfaces are locked **before**
> parallel work begins so every track can mock against them.
>
> Implementation language is **Node.js (CommonJS)**: modules use `require(...)` and
> `module.exports`. All functions returning `Promise`s are marked `async`.

## Conventions

- All side effects (shell commands, network calls, process spawning, filesystem) live
  behind module boundaries. Orchestration and parsing/validation logic stay pure.
- `child_process` invocations use **argument arrays**, never interpolated shell strings.
- Incident IDs are sanitized against `^inc-[A-Za-z0-9-]+$` before touching any shell
  command or filesystem path.
- Secret values come from environment variables, are never logged, and are scrubbed
  from any text sent to Slack.

## Shared Incident object (produced by Module 1, consumed by Modules 2 & 3)

```javascript
/**
 * Normalized representation of a CloudWatch error event.
 */
const Incident = {
  id: "string",            // sanitized, matches ^inc-[A-Za-z0-9-]+$ e.g. "inc-1718031200-a1b2"
  errorMessage: "string",  // first [ERROR] line of the payload
  stackTrace: "string",    // remaining lines of the payload
  rawPayload: "string",    // original payload, written verbatim to error.log
  receivedAt: "number"     // epoch milliseconds
};
```

**Validation rules**

- `id` matches `^inc-[A-Za-z0-9-]+$` (no path separators, whitespace, or shell metacharacters).
- `errorMessage` is a non-empty string.
- `rawPayload` is preserved exactly as received (it becomes `error.log`).

## Supporting data shapes

```javascript
const KiroResult = {
  exitCode: "number",   // 0 = success
  stdout: "string",
  stderr: "string",
  timedOut: "boolean"
};
// Triage is successful only when exitCode === 0 && timedOut === false.

const Notification = {
  status: "string",       // "fixed" | "failed"
  incidentId: "string",
  errorSnippet: "string", // truncated, secret-free excerpt
  prUrl: "string|null",   // non-null when status === "fixed"
  reason: "string|null"   // present when status === "failed"
};

const Config = {
  githubToken: "string",     // GITHUB_TOKEN
  slackWebhookUrl: "string", // SLACK_WEBHOOK_URL
  kiroApiKey: "string",      // KIRO_API_KEY
  repoUrl: "string",         // REPO_URL
  webhookSecret: "string",   // WEBHOOK_SECRET
  kiroTimeoutMs: "number"    // KIRO_TIMEOUT_MS
};
```

---

## Module 2 (Person B) — Isolated Workspace & AI Triage

Source: `src/worktreeManager.js`, `src/kiroRunner.js`

```javascript
// worktreeManager.js
async function createWorktree(incidentId, errorLog) // -> worktreePath (string)
async function removeWorktree(incidentId)           // -> void
function sanitizeIncidentId(incidentId)             // -> string | throws
function worktreePathFor(incidentId)                // -> string

// kiroRunner.js
async function runKiro(worktreePath, systemPrompt, options) // -> KiroResult
function loadSystemPrompt(path)                             // -> string
function buildKiroArgs(systemPrompt)                        // -> string[] (headless CLI args)
```

**Guarantees**

- `createWorktree` sanitizes the id, runs `git worktree add` (argument array) and writes
  `errorLog` verbatim into the worktree as `error.log`; raises a structured error on failure.
- `worktreePathFor` derives a distinct path under `../worktrees/<id>` so concurrent
  incidents never collide.
- `runKiro` invokes the Kiro CLI **headlessly** (non-interactive, one-shot) with `cwd`
  set to the worktree, authenticates via `KIRO_API_KEY`, captures stdout/stderr/exit code,
  and enforces a timeout that kills the process (sets `timedOut: true`).

## Module 3 (Person C) — Resolution Delivery & Notifications

Source: `src/githubInteractions.js`, `src/slackNotifier.js`

```javascript
// githubInteractions.js
async function commitAndPush(worktreePath, incidentId, message) // -> branchName ("hotfix/<id>")
async function createPullRequest(incidentId, prMeta)            // -> prUrl (string)
function buildBranchName(incidentId)                            // -> "hotfix/<id>"
function buildPrBody(incident, affectedFiles)                  // -> string

// slackNotifier.js
async function notify(notification) // -> { delivered: boolean }
function buildBlocks(notification)  // -> object (Slack Block Kit payload)
```

**Guarantees**

- `commitAndPush` creates and pushes `hotfix/<incident-id>` **only**; it rejects any
  operation that resolves to a protected branch (`main`/`production`) and never alters
  `main` history on failure.
- `createPullRequest` opens a PR via the GitHub API using `GITHUB_TOKEN`, returns the PR
  URL, and raises a structured error on failure. The controller **never merges**.
- `notify` posts a Block Kit message to `SLACK_WEBHOOK_URL`; on a non-2xx response it logs
  the failure and returns without throwing (never crashes the orchestrator or blocks cleanup).

## Module 1 (Person A) — Orchestrator

Source: `src/server.js`, `src/orchestrator.js`, `src/config.js`, `src/incident.js`

```javascript
// orchestrator.js
async function handleIncident(incident) // -> IncidentResult

// server.js (Express handlers + pure helpers)
function handleWebhook(req, res)                 // POST /webhook
function handleHealth(req, res)                  // GET /health
function authenticate(headers, rawBody, secret)  // -> boolean (timing-safe HMAC compare)

// incident.js
function parsePayload(rawBody)        // -> Incident (rawPayload === rawBody exactly)
function generateIncidentId(now)      // -> "inc-<...>"

// config.js
function loadConfig()                 // -> Config (fail-fast on missing vars)
```

**Lifecycle (call order)**

`createWorktree` → `runKiro` → on success `commitAndPush` + `createPullRequest` +
`notify({status:"fixed", prUrl})`; on Kiro failure/timeout `notify({status:"failed", reason})`
with no push/PR. `removeWorktree` always runs in a `finally` block.
