/**
 * Property test for the Orchestrator cleanup guarantee.
 *
 * Feature: auto-triage-agent, Property 5: Cleanup guarantee
 *
 * For ANY incident handling execution — Kiro success, non-zero exit, timeout, or
 * a thrown error anywhere in the pipeline (createWorktree, commitAndPush,
 * createPullRequest, notify) — IF a worktree was created (createWorktree
 * resolved), THEN removeWorktree(id) is called EXACTLY ONCE before
 * handleIncident resolves. When createWorktree itself fails, no worktree exists,
 * so removeWorktree is not called.
 *
 * Validates: Requirements 9.1, 9.2
 */

"use strict";

const fc = require("fast-check");
const { handleIncident } = require("../src/orchestrator");

/**
 * Build a fresh set of mocked deps + call counters for a generated scenario.
 * No real Git/process/network side effects occur.
 */
function makeHarness(scenario) {
  const counters = { removeWorktree: 0, removeArgs: [] };

  const okKiro = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  const kiroByKind = {
    success: okKiro,
    nonzero: { exitCode: 1, stdout: "", stderr: "boom", timedOut: false },
    timeout: { exitCode: 124, stdout: "", stderr: "", timedOut: true },
  };

  const deps = {
    loadSystemPrompt: () => "system prompt",
    buildErrorSnippet: () => "snippet",
    buildPrBody: () => "pr body",
    config: { getSecretValues: () => [] },
    logger: { error() {}, warn() {}, info() {} },

    createWorktree: async (id) => {
      if (scenario.createWorktreeFails) {
        throw new Error("worktree add failed");
      }
      return `/tmp/worktrees/${id}`;
    },

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

    notify: async () => {
      if (scenario.notifyThrows) {
        throw new Error("slack threw");
      }
      return { delivered: true };
    },

    removeWorktree: async (id) => {
      counters.removeWorktree += 1;
      counters.removeArgs.push(id);
    },
  };

  return { deps, counters };
}

describe("Feature: auto-triage-agent, Property 5: Cleanup guarantee", () => {
  test("a created worktree is always removed exactly once before handleIncident resolves", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          kiro: fc.constantFrom("success", "nonzero", "timeout", "throw"),
          createWorktreeFails: fc.boolean(),
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

          const { deps, counters } = makeHarness(scenario);
          const result = await handleIncident(incident, deps);

          // handleIncident always resolves (never rejects) to an IncidentResult.
          expect(result).toBeDefined();
          expect(["fixed", "failed"]).toContain(result.status);

          if (scenario.createWorktreeFails) {
            // No worktree was created → nothing to clean up.
            expect(counters.removeWorktree).toBe(0);
          } else {
            // A worktree was created → removed exactly once, with the incident id.
            expect(counters.removeWorktree).toBe(1);
            expect(counters.removeArgs[0]).toBe(incident.id);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
