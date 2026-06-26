/**
 * Property test for protected-branch safety.
 *
 * Feature: auto-triage-agent, Property 6: No push to protected branches
 *
 * For any incident id, buildBranchName produces `hotfix/<id>` and never `main`
 * or `production`; commitAndPush rejects any target that resolves to a
 * Protected_Branch, and the only branch it pushes is the hotfix branch.
 *
 * Validates: Requirements 6.1, 6.2, 6.3
 */

"use strict";

const fc = require("fast-check");

// Mock child_process so commitAndPush never touches a real git repository.
jest.mock("child_process", () => ({
  execFile: jest.fn((cmd, args, opts, cb) => cb(null, "", "")),
}));

const { execFile } = require("child_process");
const {
  buildBranchName,
  isProtectedBranch,
  assertNotProtectedBranch,
  commitAndPush,
  PROTECTED_BRANCHES,
} = require("../src/githubInteractions");

/**
 * Arbitrary that produces valid incident ids matching ^inc-[A-Za-z0-9-]+$.
 */
function incidentIdArb() {
  return fc
    .stringMatching(/^[A-Za-z0-9-]+$/)
    .filter((s) => s.length > 0)
    .map((s) => `inc-${s}`);
}

describe("Feature: auto-triage-agent, Property 6: No push to protected branches", () => {
  beforeEach(() => {
    execFile.mockClear();
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));
  });

  test("buildBranchName always yields hotfix/<id> and never a protected branch", () => {
    fc.assert(
      fc.property(incidentIdArb(), (incidentId) => {
        const branch = buildBranchName(incidentId);
        expect(branch).toBe(`hotfix/${incidentId}`);
        expect(branch.startsWith("hotfix/")).toBe(true);
        expect(isProtectedBranch(branch)).toBe(false);
        for (const protectedBranch of PROTECTED_BRANCHES) {
          expect(branch).not.toBe(protectedBranch);
        }
      }),
      { numRuns: 200 }
    );
  });

  test("commitAndPush pushes only the hotfix branch and never a protected branch", async () => {
    await fc.assert(
      fc.asyncProperty(incidentIdArb(), async (incidentId) => {
        execFile.mockClear();
        const branch = await commitAndPush("/tmp/worktree", incidentId, "fix");
        expect(branch).toBe(`hotfix/${incidentId}`);

        // Inspect every git invocation: any branch-bearing arg is the hotfix
        // branch, and a protected branch is never passed to push.
        const calls = execFile.mock.calls;
        const pushCalls = calls.filter((c) => Array.isArray(c[1]) && c[1][0] === "push");
        expect(pushCalls.length).toBe(1);
        for (const pushCall of pushCalls) {
          const args = pushCall[1];
          expect(args).toContain(branch);
          for (const protectedBranch of PROTECTED_BRANCHES) {
            expect(args).not.toContain(protectedBranch);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  test("assertNotProtectedBranch rejects protected targets for any casing/padding", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_BRANCHES),
        fc.constantFrom("", " ", "  "),
        (name, pad) => {
          const variant = `${pad}${name}${pad}`;
          expect(() => assertNotProtectedBranch(variant)).toThrow();
          expect(isProtectedBranch(variant)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
