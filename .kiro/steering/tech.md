# Technical Architecture

## 1. System Components
The system is divided into two primary environments: the **Production Mock** and the **Agent Controller**.

### Production Mock (Simulated App)
* **Application:** A simple API that intentionally throws errors.
* **Logging:** Emits logs where exceptions start with `[ERROR]` followed by the stack trace.
* **Log Ingestion:** AWS CloudWatch with `awslogs-multiline-pattern` configured to group the full stack trace into a single event payload.

### Agent Controller (The Persistent Worker)
* **Host:** A single, always-on Docker container (simulating an ECS Fargate task).
* **Git Strategy:** Uses `git worktree` to allow concurrent, zero-clone-time isolated environments for the Kiro agent to operate within.
* **LLM Engine:** Kiro.

## 2. Execution Flow
1. **Webhook Receiver (Express/FastAPI):** Listens for incoming POST requests from CloudWatch/SNS.
2. **Worktree Manager:** 
   * Receives the payload.
   * Generates a unique incident ID (`inc-1234`).
   * Executes: `git worktree add ../worktrees/inc-1234 main`.
   * Writes the `error.log` payload into the new worktree directory.
3. **Kiro Invoker:** 
   * Spawns a child process running Kiro inside `../worktrees/inc-1234`.
   * Passes the system prompt and instructions to read `error.log` and fix the bug.
4. **Git Operations:** 
   * Kiro executes bash commands to `git checkout -b hotfix/inc-1234`, `git add .`, `git commit`, and `git push`.
   * Kiro uses the GitHub API (or CLI) to create the PR.
5. **Slack Integrator:** 
   * Dispatches the Slack Webhook with the PR link and error context.
6. **Cleanup:** 
   * The Controller detects the Kiro process exit.
   * Executes: `git worktree remove ../worktrees/inc-1234`.

## 3. Environment Variables Required
* `GITHUB_TOKEN`: For pushing branches and creating PRs.
* `SLACK_WEBHOOK_URL`: For the `#qa` channel alerts.
* `KIRO_API_KEY` (or equivalent auth context for Kiro).
* `REPO_URL`: The target application repository.