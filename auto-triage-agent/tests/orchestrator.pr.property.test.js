/**
 * Property test for the Orchestrator: a Pull Request is opened ONLY on a
 * successful triage.
 *
 * Feature: auto-triage-agent, Property 7: PR only on successful triage
 *
 * For ANY incident, `createPullRequest` is called if and only if the Kiro
 * process exited successfully — i.e. `kiroResult.exitCode === 0 &&
 * kiroResult.timedOut === false`. A non-zero exit, a timeout, or a thrown Kiro
 * error must never produce a PR (and must never push a branch).
 *
 * Validates: Requirements 5.5, 7.1, 7.2
 */

"use strict";

const fc = require("fast-check");
const { handleIncident } = require("../src/orchestrator");

/**
 * Build mocked deps + counters for a generated Kiro outcome. All collaborators
 * (other than runKiro) succeed so the property isolates the PR decision to the
 * Kiro result alone. No real Git/process/network side effects occur.
 */
function makeHarness(kiroKind) {
  const counters = { createPullRequest: 0, commitAndPush: 0 };

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
      if (kiroKind === "throw") {
        throw new Error("kiro spawn failed");
      }
      return kiroByKind[kiroKind];
    },

    commitAndPush: async (worktreePath, id) => {
      counters.commitAndPush += 1;
      return `hotfix/${id}`;
    },

    createPullRequest: async () => {
      counters.createPullRequest += 1;
      return "https://github.com/acme/repo/pull/1";
    },

    notify: async () => ({ delivered: true }),

    removeWorktree: async () => {},
  };

  return { deps, counters };
}

describe("Feature: auto-triage-agent, Property 7: PR only on successful triage", () => {
  test("createPullRequest is called iff exitCode === 0 && timedOut === false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("success", "nonzero", "timeout", "throw"),
        fc.hexaString({ minLength: 1, maxLength: 8 }),
        async (kiroKind, idSuffix) => {
          const incident = {
            id: `inc-${idSuffix}`,
            errorMessage: "[ERROR] something broke",
            stackTrace: "at x.js:1",
            rawPayload: "[ERROR] something broke\nat x.js:1",
            receivedAt: 1,
          };

          const { deps, counters } = makeHarness(kiroKind);
          const result = await handleIncident(incident, deps);

          const triageSucceeded = kiroKind === "success";

          if (triageSucceeded) {
            // A PR (and a push) is produced exactly once on success.
            expect(counters.commitAndPush).toBe(1);
            expect(counters.createPullRequest).toBe(1);
            expect(result.status).toBe("fixed");
            expect(result.prUrl).toBeTruthy();
          } else {
            // No success → no branch pushed and no PR created.
            expect(counters.commitAndPush).toBe(0);
            expect(counters.createPullRequest).toBe(0);
            expect(result.status).toBe("failed");
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
