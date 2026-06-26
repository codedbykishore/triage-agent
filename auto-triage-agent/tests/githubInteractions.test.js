/**
 * Unit tests for githubInteractions (Module 3 / Person C).
 *
 * Git is exercised through a mocked `child_process.execFile` and the GitHub API
 * through a mocked axios so logic is verified without real Git/network calls.
 *
 * Covers: protected-branch rejection, hotfix-only push, PR body/title content,
 * the returned PR URL, and graceful structured errors on push/PR failure.
 *
 * Requirements: 6.3, 6.5, 7.3, 7.4, 7.5
 */

"use strict";

jest.mock("child_process", () => ({
  execFile: jest.fn((cmd, args, opts, cb) => cb(null, "", "")),
}));

const { execFile } = require("child_process");
const gh = require("../src/githubInteractions");

const incident = {
  id: "inc-1718031200-a1b2",
  errorMessage: "[ERROR] TypeError: Cannot read properties of null (reading 'name')",
  stackTrace: "at handler (src/app.js:42:10)",
};

beforeEach(() => {
  execFile.mockClear();
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));
});

describe("buildBranchName", () => {
  test("returns hotfix/<id> for a valid incident id", () => {
    expect(gh.buildBranchName("inc-abc-123")).toBe("hotfix/inc-abc-123");
  });

  test("throws a structured error for an unsafe incident id", () => {
    expect(() => gh.buildBranchName("../../etc/passwd")).toThrow(/invalid incident id/);
    try {
      gh.buildBranchName("");
    } catch (err) {
      expect(err.code).toBe("INVALID_INCIDENT_ID");
    }
  });
});

describe("buildPrTitle", () => {
  test("stays under 70 characters even for a long error message", () => {
    const longIncident = {
      errorMessage: "[ERROR] " + "x".repeat(200),
    };
    const title = gh.buildPrTitle(longIncident);
    expect(title.length).toBeLessThan(70);
  });

  test("includes the error summary when present", () => {
    const title = gh.buildPrTitle({ errorMessage: "[ERROR] boom" });
    expect(title).toContain("boom");
  });
});

describe("buildPrBody", () => {
  test("contains the error summary, affected files, and what was tested", () => {
    const body = gh.buildPrBody(incident, ["src/app.js", "src/util.js"]);
    expect(body).toContain(incident.errorMessage);
    expect(body).toContain("src/app.js");
    expect(body).toContain("src/util.js");
    expect(body).toMatch(/What was tested/i);
    expect(body).toContain(incident.id);
  });

  test("handles a missing affected-file list gracefully", () => {
    const body = gh.buildPrBody(incident, undefined);
    expect(body).toMatch(/Affected file/i);
  });
});

describe("isProtectedBranch / assertNotProtectedBranch", () => {
  test("flags main and production as protected", () => {
    expect(gh.isProtectedBranch("main")).toBe(true);
    expect(gh.isProtectedBranch("production")).toBe(true);
    expect(gh.isProtectedBranch("hotfix/inc-1")).toBe(false);
  });

  test("assertNotProtectedBranch throws PROTECTED_BRANCH for a protected target", () => {
    expect.assertions(2);
    try {
      gh.assertNotProtectedBranch("main");
    } catch (err) {
      expect(err.code).toBe("PROTECTED_BRANCH");
      expect(err.message).toMatch(/protected branch/);
    }
  });
});

describe("commitAndPush", () => {
  test("creates, commits, and pushes the hotfix branch only via argument arrays", async () => {
    const branch = await gh.commitAndPush("/tmp/wt", incident.id, "fix: triage");
    expect(branch).toBe(`hotfix/${incident.id}`);

    // Every git call uses an argument array (args is index 1), never a string.
    for (const call of execFile.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }

    const pushCall = execFile.mock.calls.find((c) => c[1][0] === "push");
    expect(pushCall[1]).toEqual(["push", "-u", "origin", `hotfix/${incident.id}`]);
    expect(pushCall[1]).not.toContain("main");
    // cwd is the worktree path.
    expect(pushCall[2]).toEqual(expect.objectContaining({ cwd: "/tmp/wt" }));
  });

  test("rejects an unsafe incident id and never invokes git", async () => {
    await expect(gh.commitAndPush("/tmp/wt", "main; rm -rf /", "msg")).rejects.toMatchObject({
      code: "INVALID_INCIDENT_ID",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  test("raises a structured error on push failure without altering main", async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === "push") {
        cb(new Error("remote rejected"), "", "remote rejected");
        return;
      }
      cb(null, "", "");
    });

    await expect(gh.commitAndPush("/tmp/wt", incident.id, "msg")).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
    });
    // No git command targeted main.
    for (const call of execFile.mock.calls) {
      expect(call[1]).not.toContain("main");
    }
  });
});

describe("createPullRequest", () => {
  test("posts to the GitHub API and returns the PR URL", async () => {
    const httpClient = {
      post: jest.fn().mockResolvedValue({
        data: { html_url: "https://github.com/acme/repo/pull/7" },
      }),
    };

    const prUrl = await gh.createPullRequest(incident.id, {
      incident,
      affectedFiles: ["src/app.js"],
      token: "ghp_test",
      repoUrl: "https://github.com/acme/repo.git",
      httpClient,
    });

    expect(prUrl).toBe("https://github.com/acme/repo/pull/7");
    expect(httpClient.post).toHaveBeenCalledTimes(1);

    const [url, payload, opts] = httpClient.post.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/repo/pulls");
    expect(payload.head).toBe(`hotfix/${incident.id}`);
    expect(payload.base).toBe("main");
    expect(payload.title.length).toBeLessThan(70);
    expect(payload.body).toContain("src/app.js");
    expect(opts.headers.Authorization).toBe("Bearer ghp_test");
  });

  test("raises a structured PR_CREATE_FAILED error when the API call fails", async () => {
    const httpClient = {
      post: jest.fn().mockRejectedValue({ response: { status: 401 }, message: "Unauthorized" }),
    };

    await expect(
      gh.createPullRequest(incident.id, {
        incident,
        token: "bad",
        repoUrl: "https://github.com/acme/repo.git",
        httpClient,
      })
    ).rejects.toMatchObject({ code: "PR_CREATE_FAILED" });
  });

  test("raises PR_CREATE_FAILED when GITHUB_TOKEN is absent", async () => {
    const httpClient = { post: jest.fn() };
    await expect(
      gh.createPullRequest(incident.id, {
        incident,
        token: "",
        repoUrl: "https://github.com/acme/repo.git",
        httpClient,
      })
    ).rejects.toMatchObject({ code: "PR_CREATE_FAILED" });
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});
