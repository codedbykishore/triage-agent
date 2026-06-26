/**
 * Property test for the Orchestrator: notification completeness.
 *
 * Feature: auto-triage-agent, Property 8: Notification completeness
 *
 * For ANY incident handling execution that reaches a terminal state — Kiro
 * success, non-zero exit, timeout, a thrown error in the git/PR pipeline, or
 * even a notifier that throws — EXACTLY ONE Slack notification is dispatched,
 * and its `status` reflects the outcome:
 *   - `fixed` carries a non-null `prUrl`, or
 *   - `failed` carries a non-empty `reason`.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */

"use strict";

const fc = require("fast-check");
const { handleIncident } = require("../src/orchestrator");

/**
 * Build mocked deps that record every notify call for a generated scenario.
 * No real Git/process/network side effects occur.
 */
function makeHarness(scenario) {
  const notifications = [];

  const kiroByKind = {
    success: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false },
    nonzero: { exitCode: 1, stdout: "", stderr: "boom", timedOut: false },
    timeout: { exitCode: 124, stdout: "", stderr: "", timedOut: true },
  };

  const deps = {
    loadSystemPrompt: () => "system prompt",
    buildErrorSnippet: () => "snippet",
    buildPrBody: () => "pr body",
    config: { getSecretValues: () => [] },
    logger: { error() {}, warn() {}, info() {} },

    createWorktree: async (id) => `/tmp/worktrees/${id}`,

    runKiro: async () => {
      if (scenario.kiro === "throw") {
        throw new Error("kiro spawn failed");
      }
      return kiroByKind[scenario.kiro];
    },

    commitAndPush: async (worktreePath, id) => {
      if (scenario.commitFails) {
        throw new Error("push failed");
      }
      return `hotfix/${id}`;
    },

    createPullRequest: async () => {
      if (scenario.prFails) {
        throw new Error("pr failed");
      }
      return "https://github.com/acme/repo/pull/1";
    },

    notify: async (notification) => {
      notifications.push(notification);
      if (scenario.notifyThrows) {
        throw new Error("slack threw");
      }
      return { delivered: true };
    },

    removeWorktree: async () => {},
  };

  return { deps, notifications };
}

describe("Feature: auto-triage-agent, Property 8: Notification completeness", () => {
  test("exactly one notification is dispatched and its status reflects the outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kiro: fc.constantFrom("success", "nonzero", "timeout", "throw"),
          commitFails: fc.boolean(),
          prFails: fc.boolean(),
          notifyThrows: fc.boolean(),
        }),
        fc.hexaString({ minLength: 1, maxLength: 8 }),
        async (scenario, idSuffix) => {
          const incident = {
            id: `inc-${idSuffix}`,
            errorMessage: "[ERROR] something broke",
            stackTrace: "at x.js:1",
            rawPayload: "[ERROR] something broke\nat x.js:1",
            receivedAt: 1,
          };

          const { deps, notifications } = makeHarness(scenario);
          const result = await handleIncident(incident, deps);

          // Exactly ONE notification per terminal execution.
          expect(notifications).toHaveLength(1);

          const note = notifications[0];
          expect(note.incidentId).toBe(incident.id);
          expect(["fixed", "failed"]).toContain(note.status);

          if (note.status === "fixed") {
            // A fixed notification always carries a non-null PR URL.
            expect(note.prUrl).toBeTruthy();
          } else {
            // A failed notification always carries a non-empty reason.
            expect(typeof note.reason).toBe("string");
            expect(note.reason.length).toBeGreaterThan(0);
          }

          // handleIncident always resolves to an IncidentResult.
          expect(["fixed", "failed"]).toContain(result.status);
        }
      ),
      { numRuns: 200 }
    );
  });
});
