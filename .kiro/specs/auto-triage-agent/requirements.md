# Requirements Document

## Introduction

The Auto-Triage Agent is an autonomous, event-driven incident response system powered by Kiro. An always-on Agent Controller exposes an authenticated webhook that receives simulated CloudWatch/SNS error notifications. For each notification, the Controller generates a unique incident identifier, provisions an isolated `git worktree`, writes the raw error payload into that worktree as `error.log`, and spawns a sandboxed Kiro child process that reads the error, locates the failing file(s), and writes a code fix.

When Kiro produces a fix, the Controller commits the change to a `hotfix/<incident-id>` branch, pushes that branch to the remote, opens a GitHub Pull Request, and posts a Slack alert to the `#qa` channel. The worktree is then always removed. The defining constraint is human-in-the-loop safety: the Agent Controller never pushes to `main`/production and never merges — it stops at the Pull Request, leaving review and merge to a human engineer.

These requirements are derived from the approved design document and the project steering material (`product.md`, `tech.md`, `structure.md`, `docs/PLAN.md`). Scope is limited to the Agent Controller for a single target repository, with simulated CloudWatch webhooks and codebase-related runtime errors only.

## Glossary

- **Agent_Controller**: The always-on Node.js service (single Docker container simulating an ECS Fargate task) that orchestrates the incident lifecycle.
- **Webhook_Receiver**: The `server.js` component that exposes `POST /webhook` and `GET /health`, authenticates requests, parses payloads, and hands off to the Orchestrator.
- **Orchestrator**: The component that sequences the incident lifecycle (worktree → Kiro → git/PR → Slack → cleanup) and guarantees cleanup.
- **Worktree_Manager**: The `worktreeManager.js` component that creates and removes isolated `git worktree` directories and writes `error.log`.
- **Kiro_Runner**: The `kiroRunner.js` component that invokes the Kiro CLI headlessly (non-interactive, not the IDE) as a supervised child process under a timeout.
- **GitHub_Interactions**: The `githubInteractions.js` component that creates branches, commits, pushes, and opens Pull Requests.
- **Slack_Notifier**: The `slackNotifier.js` component that formats and delivers Slack Block Kit alerts.
- **Config_Loader**: The startup component that loads and validates required environment variables.
- **Incident**: A normalized representation of a CloudWatch error event (`id`, `errorMessage`, `stackTrace`, `rawPayload`, `receivedAt`).
- **Incident_ID**: A unique, injection-safe identifier matching `^inc-[A-Za-z0-9-]+$`.
- **Protected_Branch**: The `main` or `production` branch, which the Agent Controller must never push to or target.
- **Hotfix_Branch**: A branch named `hotfix/<incident-id>` that holds the candidate fix.
- **Error_Snippet**: A length-bounded, secret-free excerpt of the error placed in a Slack notification.

## Requirements

### Requirement 1: Authenticated Webhook Receipt

**User Story:** As a platform operator, I want the incident webhook endpoint to authenticate every request, so that only legitimate CloudWatch/SNS notifications can trigger autonomous triage.

#### Acceptance Criteria

1. THE Webhook_Receiver SHALL expose a `POST /webhook` endpoint for receiving error notifications.
2. THE Webhook_Receiver SHALL expose a `GET /health` endpoint that reports liveness.
3. WHEN a request is received at `/webhook`, THE Webhook_Receiver SHALL authenticate the request by comparing the provided signature to the HMAC of the raw request body computed with the configured webhook secret.
4. THE Webhook_Receiver SHALL perform the signature comparison using a constant-time comparison that does not short-circuit on the first mismatched character.
5. IF a request to `/webhook` has a missing or invalid signature, THEN THE Webhook_Receiver SHALL respond with HTTP `401` and SHALL NOT parse the payload, generate an incident, or start orchestration.
6. WHEN a request to `/webhook` is successfully authenticated and parsed, THE Webhook_Receiver SHALL respond with HTTP `202` and hand off incident processing to the Orchestrator asynchronously.

### Requirement 2: Payload Parsing

**User Story:** As an engineer, I want incoming error payloads parsed into a normalized incident, so that downstream triage receives consistent structured data while preserving the original log.

#### Acceptance Criteria

1. WHEN a valid CloudWatch payload containing at least one `[ERROR]` line is received, THE Webhook_Receiver SHALL parse it into an Incident object.
2. WHEN a payload is parsed, THE Webhook_Receiver SHALL set the Incident `errorMessage` to the first `[ERROR]` line and the `stackTrace` to the remaining lines.
3. WHEN a payload is parsed, THE Webhook_Receiver SHALL set the Incident `rawPayload` to a value exactly equal to the received raw body.
4. IF the payload is empty, non-string, or contains no `[ERROR]` line, THEN THE Webhook_Receiver SHALL respond with HTTP `400` and SHALL log a structured warning that contains no secret values.

### Requirement 3: Incident ID Generation and Sanitization

**User Story:** As a security-conscious engineer, I want incident identifiers to be unique and injection-safe, so that they can be used in shell commands and filesystem paths without risk.

#### Acceptance Criteria

1. WHEN an authenticated payload is accepted, THE Webhook_Receiver SHALL generate an Incident_ID that matches the pattern `^inc-[A-Za-z0-9-]+$`.
2. WHEN `generateIncidentId` is invoked with distinct time or entropy inputs, THE Webhook_Receiver SHALL produce distinct Incident_ID values.
3. WHEN `sanitizeIncidentId` receives an identifier that matches `^inc-[A-Za-z0-9-]+$`, THE Worktree_Manager SHALL return that identifier unchanged.
4. IF `sanitizeIncidentId` receives a null, empty, or non-matching identifier, THEN THE Worktree_Manager SHALL raise an error and SHALL NOT return a value containing path separators, whitespace, or shell metacharacters.

### Requirement 4: Isolated Worktree Provisioning

**User Story:** As an engineer, I want each incident handled in its own isolated worktree containing the error log, so that triage runs in a sandboxed environment without affecting other incidents or the main checkout.

#### Acceptance Criteria

1. WHEN the Orchestrator begins handling an incident, THE Worktree_Manager SHALL create an isolated worktree for that incident using `git worktree add` invoked with argument arrays rather than interpolated shell strings.
2. WHEN a worktree is created, THE Worktree_Manager SHALL write the Incident `rawPayload` verbatim into that worktree as `error.log`.
3. THE Worktree_Manager SHALL sanitize the Incident_ID before it is used in any shell command or filesystem path.
4. WHILE multiple incidents are being handled, THE Worktree_Manager SHALL assign each incident a distinct worktree path so that no collisions occur.
5. IF `git worktree add` fails, THEN THE Worktree_Manager SHALL raise a structured error so that the Orchestrator can send a failure notification and run cleanup.

### Requirement 5: Kiro Invocation with Timeout

**User Story:** As an engineer, I want Kiro to run sandboxed inside the worktree under a timeout, so that triage is bounded in duration and cannot affect other incidents.

#### Acceptance Criteria

1. WHEN a worktree is ready, THE Kiro_Runner SHALL invoke the Kiro CLI headlessly (non-interactive, one-shot) as a child process whose working directory is set to that worktree, and SHALL NOT launch or attach to the Kiro IDE.
2. THE Kiro_Runner SHALL load the system prompt from `system_prompts/incident_responder.txt` and supply it to the Kiro process.
3. THE Kiro_Runner SHALL capture the Kiro process stdout, stderr, and exit code and return them as a structured KiroResult.
4. IF the Kiro process exceeds the configured timeout, THEN THE Kiro_Runner SHALL terminate the process and report the result with `timedOut` set to true.
5. THE Orchestrator SHALL treat triage as successful only when the KiroResult has `exitCode` equal to 0 and `timedOut` equal to false.

### Requirement 6: Protected Branch Safety and Human-in-the-Loop

**User Story:** As an engineering lead, I want the agent to commit fixes only to hotfix branches and never to production, so that a human always reviews and merges changes.

#### Acceptance Criteria

1. WHEN triage succeeds, THE GitHub_Interactions SHALL create a branch named `hotfix/<incident-id>` and SHALL commit and push the fix to that branch only.
2. THE GitHub_Interactions SHALL never push to or target a Protected_Branch.
3. IF a requested git operation resolves to a Protected_Branch, THEN THE GitHub_Interactions SHALL reject the operation and raise a structured error.
4. THE Agent_Controller SHALL never merge a Pull Request.
5. IF a git push or branch operation fails, THEN THE GitHub_Interactions SHALL raise a structured error and SHALL NOT alter `main` history.

### Requirement 7: Pull Request Creation

**User Story:** As a reviewing engineer, I want a Pull Request opened only when a fix was produced, so that I have a clear, reviewable artifact for each successful triage.

#### Acceptance Criteria

1. WHEN triage succeeds and the hotfix branch is pushed, THE GitHub_Interactions SHALL create a GitHub Pull Request authenticated with the configured GitHub token.
2. IF triage did not succeed, THEN THE GitHub_Interactions SHALL NOT create a Pull Request and SHALL NOT push any branch.
3. WHEN a Pull Request is created, THE GitHub_Interactions SHALL set a title shorter than 70 characters and a body containing the error summary, the affected file(s), and what was tested.
4. WHEN a Pull Request is created, THE GitHub_Interactions SHALL return the Pull Request URL to the Orchestrator.
5. IF Pull Request creation fails, THEN THE GitHub_Interactions SHALL raise a structured error so that a failure notification is sent.

### Requirement 8: Slack Notification

**User Story:** As a member of the QA team, I want a Slack alert for every incident outcome, so that I am informed whether a fix was prepared or triage failed.

#### Acceptance Criteria

1. WHEN incident handling reaches a terminal state, THE Slack_Notifier SHALL dispatch exactly one Slack Block Kit notification to the `#qa` channel via the configured Slack webhook URL.
2. WHEN triage succeeds, THE Slack_Notifier SHALL send a notification with status `fixed`, the Error_Snippet, and a non-null Pull Request URL.
3. WHEN triage fails or no fix is produced, THE Slack_Notifier SHALL send a notification with status `failed`, the Error_Snippet, and a failure reason.
4. IF the Slack webhook returns a non-2xx response, THEN THE Slack_Notifier SHALL log the delivery failure and SHALL NOT crash the Orchestrator or block worktree cleanup.

### Requirement 9: Guaranteed Worktree Cleanup

**User Story:** As an operator, I want every worktree removed after handling, so that disk usage and stale state do not accumulate regardless of outcome.

#### Acceptance Criteria

1. WHEN incident handling completes by any path — Kiro success, failure, timeout, or thrown error — IF a worktree was created, THEN THE Orchestrator SHALL remove that worktree before `handleIncident` returns.
2. WHILE removing a worktree, THE Worktree_Manager SHALL tolerate partial or failed states by attempting `git worktree remove` and prune.
3. WHEN one incident fails, THE Orchestrator SHALL isolate that failure so that handling of other incidents is not blocked or corrupted.

### Requirement 10: Fail-Fast Configuration Validation

**User Story:** As an operator, I want the Controller to validate its configuration at startup, so that missing secrets are caught immediately rather than mid-incident.

#### Acceptance Criteria

1. WHEN the Agent_Controller starts, THE Config_Loader SHALL verify that `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `KIRO_API_KEY`, `REPO_URL`, the webhook secret, and the Kiro timeout are present.
2. IF any required configuration value is missing at startup, THEN THE Config_Loader SHALL fail fast and emit a message naming the missing variable by key, not by value.

### Requirement 11: Secret Hygiene

**User Story:** As a security reviewer, I want secrets kept out of logs and notifications, so that sensitive values are never exposed.

#### Acceptance Criteria

1. THE Agent_Controller SHALL source all secret values from environment variables and SHALL never write secret values to logs.
2. WHEN an Error_Snippet is built for a notification, THE Slack_Notifier SHALL truncate the snippet to a fixed maximum length.
3. THE Slack_Notifier SHALL exclude all configured secret values from the Error_Snippet.

### Requirement 12: Scope Limits

**User Story:** As a hackathon participant, I want the system scoped to a single repository and codebase-related errors, so that the demonstration stays focused and predictable.

#### Acceptance Criteria

1. THE Agent_Controller SHALL operate against a single target repository identified by `REPO_URL`.
2. THE Agent_Controller SHALL accept incidents delivered as simulated CloudWatch webhooks sent as direct HTTP POST requests.
3. WHERE an incident describes a codebase-related runtime error such as a null pointer or bad JSON parsing, THE Agent_Controller SHALL attempt triage; infrastructure-level failures such as out-of-memory crashes are out of scope.
