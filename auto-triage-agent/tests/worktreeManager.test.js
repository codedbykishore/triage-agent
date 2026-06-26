/**
 * Unit tests for src/worktreeManager.js with mocked child_process and fs.
 *
 * Asserts:
 *   - `git` is invoked via execFile with ARGUMENT ARRAYS (never a shell string).
 *   - `error.log` is written verbatim into the worktree.
 *   - Distinct incident ids yield distinct worktree paths.
 *   - `removeWorktree` tolerates failed/partial states (never throws).
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 9.2
 */

"use strict";

const path = require("path");

// Mock child_process so no real git runs.
jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

const { execFile } = require("child_process");
const fs = require("fs");

const {
  createWorktree,
  removeWorktree,
  worktreePathFor,
  sanitizeIncidentId,
} = require("../src/worktreeManager");

/** Make execFile succeed: invoke its callback with no error. */
function execFileSucceeds() {
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));
}

/** Make execFile fail: invoke its callback with an error. */
function execFileFails(message = "git boom") {
  execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error(message), "", message));
}

describe("worktreeManager — createWorktree", () => {
  let writeSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    writeSpy = jest.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test("invokes git via execFile with an argument array (not a shell string)", async () => {
    execFileSucceeds();

    const id = "inc-1718031200-abcd";
    const worktreePath = await createWorktree(id, "[ERROR] boom");

    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFile.mock.calls[0];
    expect(cmd).toBe("git");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(["worktree", "add", "--detach", worktreePath, "main"]);
    // options object carries cwd; no shell flag is ever passed.
    expect(opts).toEqual(expect.objectContaining({ cwd: expect.any(String) }));
    expect(opts.shell).toBeUndefined();
  });

  test("writes error.log verbatim into the worktree", async () => {
    execFileSucceeds();

    const id = "inc-1718031200-abcd";
    const payload = "[ERROR] Cannot read properties of null\n    at f (/app/x.js:1:1)";
    const worktreePath = await createWorktree(id, payload);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [filePath, contents, encoding] = writeSpy.mock.calls[0];
    expect(filePath).toBe(path.join(worktreePath, "error.log"));
    expect(contents).toBe(payload); // verbatim, byte-for-byte
    expect(encoding).toBe("utf8");
  });

  test("rejects with a structured error when git worktree add fails", async () => {
    execFileFails("locked ref");

    await expect(createWorktree("inc-1718031200-abcd", "[ERROR] boom")).rejects.toMatchObject({
      code: "WORKTREE_CREATE_FAILED",
    });
    // error.log is never written when worktree creation fails.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("rejects an unsafe incident id before touching git", async () => {
    execFileSucceeds();
    await expect(createWorktree("inc-foo; rm -rf /", "x")).rejects.toMatchObject({
      code: "INVALID_INCIDENT_ID",
    });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("worktreeManager — distinct paths", () => {
  test("distinct ids yield distinct worktree paths", () => {
    const a = worktreePathFor("inc-aaaa-1111");
    const b = worktreePathFor("inc-bbbb-2222");
    expect(a).not.toBe(b);
    expect(a.endsWith(path.join("worktrees", "inc-aaaa-1111"))).toBe(true);
    expect(b.endsWith(path.join("worktrees", "inc-bbbb-2222"))).toBe(true);
  });

  test("sanitizeIncidentId returns valid ids unchanged", () => {
    expect(sanitizeIncidentId("inc-1718031200-abcd")).toBe("inc-1718031200-abcd");
  });
});

describe("worktreeManager — removeWorktree tolerates failures", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("does not throw when git worktree remove/prune fail", async () => {
    execFileFails("no such worktree");
    await expect(removeWorktree("inc-1718031200-abcd")).resolves.toBeUndefined();
    // Attempts both remove and prune despite failures.
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0][1]).toEqual([
      "worktree",
      "remove",
      "--force",
      expect.any(String),
    ]);
    expect(execFile.mock.calls[1][1]).toEqual(["worktree", "prune"]);
  });

  test("returns silently (no git) for an unsafe id", async () => {
    execFileSucceeds();
    await expect(removeWorktree("../escape")).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});
