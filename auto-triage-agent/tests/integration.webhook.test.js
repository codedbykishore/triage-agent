/**
 * Integration test: webhook → worktree → orchestration → cleanup
 * (Module 1 / Person A).
 *
 * Fires a signed webhook via supertest against the REAL Express app
 * (`createApp`) wired to the REAL orchestrator `handleIncident`, with Kiro, Git,
 * and Slack collaborators MOCKED (injected as deps). This verifies the
 * end-to-end WIRING — not external service behavior:
 *
 *   POST /webhook (202) → handleIncident runs → createWorktree → runKiro →
 *   commitAndPush → createPullRequest → notify(fixed) → removeWorktree (cleanup)
 *
 * Assertions:
 *   - the endpoint responds 202 with a sanitized incident id
 *   - a worktree is CREATED with that incident id
 *   - orchestration runs (Kiro + git + PR + Slack collaborators invoked)
 *   - the worktree is REMOVED (cleanup) with the same incident id, AFTER creation
 *
 * The async handoff is awaited deterministically so the test is not racy.
 *
 * Requirements: 1.6, 9.1, 9.3
 */

"use strict";

const request = require("supertest");
const { createApp, computeSignature, SIGNATURE_HEADER } = require("../src/server");
const { handleIncident } = require("../src/orchestrator");

const SECRET = "integration-webhook-secret";

// A realistic mock CloudWatch payload matching the mock app's [ERROR] format.
const PAYLOAD = [
  "[ERROR] Cannot read properties of null (reading 'profile')",
  "    at readUserId (/app/mock-app/server.js:77:15)",
  "    at /app/mock-app/server.js:113:16",
].join("\n");

/**
 * Build a harness wiring the REAL orchestrator into the REAL app, with all
 * side-effecting collaborators replaced by spies. Records the order of the
 * create/remove lifecycle events so we can assert creation precedes cleanup.
 */
function buildHarness() {
  const events = [];

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const deps = {
    createWorktree: jest.fn(async (id) => {
      events.push({ kind: "create", id });
      return `/tmp/worktrees/${id}`;
    }),
    runKiro: jest.fn(async () => {
      events.push({ kind: "kiro" });
      return { exitCode: 0, stdout: "fixed it", stderr: "", timedOut: false };
    }),
    loadSystemPrompt: jest.fn(() => "system prompt"),
    commitAndPush: jest.fn(async (worktreePath, id) => {
      events.push({ kind: "commit", id });
      return `hotfix/${id}`;
    }),
    createPullRequest: jest.fn(async () => {
      events.push({ kind: "pr" });
      return "https://github.com/acme/repo/pull/1";
    }),
    buildPrBody: jest.fn(() => "pr body"),
    buildErrorSnippet: jest.fn(() => "snippet"),
    notify: jest.fn(async () => {
      events.push({ kind: "notify" });
      return { delivered: true };
    }),
    removeWorktree: jest.fn(async (id) => {
      events.push({ kind: "remove", id });
    }),
    config: { getSecretValues: () => [] },
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  };

  // Wire the REAL orchestrator with mocked collaborators, resolving `done` when
  // the full lifecycle (including finally-cleanup) has completed.
  const boundHandleIncident = (incident) =>
    handleIncident(incident, deps).then((res) => {
      resolveDone(res);
      return res;
    });

  const app = createApp({
    config: { webhookSecret: SECRET },
    handleIncident: boundHandleIncident,
    logger: deps.logger,
  });

  return { app, deps, events, done };
}

describe("Integration: webhook → worktree → orchestration → cleanup", () => {
  test("fires a signed webhook and runs the real orchestrator end-to-end with mocked collaborators", async () => {
    const { app, deps, events, done } = buildHarness();

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, computeSignature(PAYLOAD, SECRET))
      .send(PAYLOAD);

    // The receiver accepts immediately and hands off asynchronously.
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    const incidentId = res.body.incidentId;
    expect(incidentId).toMatch(/^inc-[A-Za-z0-9-]+$/);

    // Await the async handoff (orchestration + cleanup) deterministically.
    const result = await done;
    expect(result.status).toBe("fixed");
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");

    // Worktree was created for this incident...
    expect(deps.createWorktree).toHaveBeenCalledTimes(1);
    expect(deps.createWorktree.mock.calls[0][0]).toBe(incidentId);

    // ...orchestration ran end-to-end...
    expect(deps.runKiro).toHaveBeenCalledTimes(1);
    expect(deps.commitAndPush).toHaveBeenCalledTimes(1);
    expect(deps.createPullRequest).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][0]).toMatchObject({
      status: "fixed",
      incidentId,
    });

    // ...and the worktree was cleaned up (removed) with the same incident id.
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree.mock.calls[0][0]).toBe(incidentId);

    // Creation strictly precedes cleanup in the lifecycle.
    const createIndex = events.findIndex((e) => e.kind === "create");
    const removeIndex = events.findIndex((e) => e.kind === "remove");
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(createIndex);
  });

  test("cleanup still runs when triage fails (no PR, worktree removed)", async () => {
    const { app, deps, done } = buildHarness();

    // Make Kiro report a failed triage (non-zero exit) for this run.
    deps.runKiro.mockImplementationOnce(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "could not fix",
      timedOut: false,
    }));

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, computeSignature(PAYLOAD, SECRET))
      .send(PAYLOAD);

    expect(res.status).toBe(202);
    const incidentId = res.body.incidentId;

    const result = await done;
    expect(result.status).toBe("failed");

    // No push / PR on failed triage...
    expect(deps.commitAndPush).not.toHaveBeenCalled();
    expect(deps.createPullRequest).not.toHaveBeenCalled();

    // ...exactly one failure notification...
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ status: "failed" });

    // ...and the worktree is still cleaned up.
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree.mock.calls[0][0]).toBe(incidentId);
  });
});
