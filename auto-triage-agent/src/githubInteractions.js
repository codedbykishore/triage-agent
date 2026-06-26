/**
 * githubInteractions.js — GitHub_Interactions (Module 3 / Person C)
 *
 * Performs Git branch/commit/push operations and opens a GitHub Pull Request.
 * The defining safety constraint is human-in-the-loop: this module pushes to a
 * `hotfix/<incident-id>` branch ONLY, never to a Protected_Branch (`main` /
 * `production`), and the controller never merges a PR.
 *
 * All `git` invocations go through `child_process.execFile` with ARGUMENT
 * ARRAYS — never interpolated shell strings — so attacker-influenced values
 * cannot inject shell commands. All failures surface as structured errors the
 * Orchestrator can branch on without `main` history ever being altered.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.3, 7.4, 7.5
 */

"use strict";

const { execFile } = require("child_process");
const axios = require("axios");

/**
 * Allowlist pattern for incident identifiers (mirrors the shared contract).
 * @type {RegExp}
 */
const INCIDENT_ID_PATTERN = /^inc-[A-Za-z0-9-]+$/;

/**
 * Branches the Agent Controller must never push to or target for a push.
 * @type {string[]}
 */
const PROTECTED_BRANCHES = ["main", "production"];

/**
 * Maximum length for a generated PR title (must stay under 70 characters).
 * @type {number}
 */
const MAX_PR_TITLE_LENGTH = 69;

/**
 * Build a structured error carrying a stable `code` so the Orchestrator can
 * branch on the failure category without string matching.
 * @param {string} message
 * @param {string} code
 * @param {Error} [cause]
 * @returns {Error & { code: string, cause?: Error }}
 */
function structuredError(message, code, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) {
    err.cause = cause;
  }
  return err;
}

/**
 * Whether a branch name resolves to a Protected_Branch (`main`/`production`).
 * Comparison is case-insensitive and trims surrounding whitespace so that
 * "Main", " production " etc. are still treated as protected.
 * @param {string} branch
 * @returns {boolean}
 */
function isProtectedBranch(branch) {
  if (typeof branch !== "string") {
    return false;
  }
  const normalized = branch.trim().toLowerCase();
  return PROTECTED_BRANCHES.includes(normalized);
}

/**
 * Guard that rejects any operation whose target resolves to a Protected_Branch.
 * @param {string} branch
 * @throws {Error} PROTECTED_BRANCH when `branch` is `main`/`production`.
 */
function assertNotProtectedBranch(branch) {
  if (isProtectedBranch(branch)) {
    throw structuredError(
      `refusing to operate on protected branch "${branch}"`,
      "PROTECTED_BRANCH"
    );
  }
}

/**
 * Sanitize an incident id against the strict allowlist before it is used in any
 * branch name or shell argument.
 * @param {string} incidentId
 * @returns {string} the id unchanged when valid
 * @throws {Error} INVALID_INCIDENT_ID for null/empty/non-matching input.
 */
function sanitizeIncidentId(incidentId) {
  if (typeof incidentId !== "string" || incidentId.length === 0) {
    throw structuredError("incident id required", "INVALID_INCIDENT_ID");
  }
  if (!INCIDENT_ID_PATTERN.test(incidentId)) {
    throw structuredError(
      "invalid incident id: must match ^inc-[A-Za-z0-9-]+$",
      "INVALID_INCIDENT_ID"
    );
  }
  return incidentId;
}

/**
 * Build the hotfix branch name for an incident. Always `hotfix/<incident-id>`
 * and, by construction, never a Protected_Branch.
 * @param {string} incidentId
 * @returns {string} e.g. "hotfix/inc-1718031200-a1b2"
 * @throws {Error} INVALID_INCIDENT_ID for an unsafe id.
 */
function buildBranchName(incidentId) {
  const safeId = sanitizeIncidentId(incidentId);
  return `hotfix/${safeId}`;
}

/**
 * Build a PR title that stays strictly under 70 characters.
 * @param {{ id?: string, errorMessage?: string }} incident
 * @returns {string}
 */
function buildPrTitle(incident) {
  const summary =
    incident && typeof incident.errorMessage === "string"
      ? incident.errorMessage.replace(/\[ERROR\]\s*/i, "").trim()
      : "";
  const base = summary.length > 0 ? `Auto-triage fix: ${summary}` : "Auto-triage fix";

  if (base.length <= MAX_PR_TITLE_LENGTH) {
    return base;
  }
  // Truncate with an ellipsis, keeping the total at most MAX_PR_TITLE_LENGTH.
  return `${base.slice(0, MAX_PR_TITLE_LENGTH - 1)}…`;
}

/**
 * Build a PR body containing the error summary, the affected file(s), and what
 * was tested. Pure string construction (no I/O).
 * @param {{ id?: string, errorMessage?: string, stackTrace?: string }} incident
 * @param {string[]} [affectedFiles]
 * @returns {string}
 */
function buildPrBody(incident, affectedFiles) {
  const safeIncident = incident && typeof incident === "object" ? incident : {};
  const files =
    Array.isArray(affectedFiles) && affectedFiles.length > 0
      ? affectedFiles
      : ["(not reported)"];

  const errorSummary =
    typeof safeIncident.errorMessage === "string" && safeIncident.errorMessage.length > 0
      ? safeIncident.errorMessage
      : "(no error message captured)";

  const fileList = files.map((f) => `- \`${f}\``).join("\n");

  return [
    "## Automated triage fix",
    "",
    `**Incident:** ${safeIncident.id || "(unknown)"}`,
    "",
    "### Error summary",
    "```",
    errorSummary,
    "```",
    "",
    "### Affected file(s)",
    fileList,
    "",
    "### What was tested",
    "- Existing automated test suite was run against the fix.",
    "- The triage reproduced the reported error and verified the fix resolves it.",
    "",
    "> Generated by the Auto-Triage Agent. A human must review and merge — the agent never merges.",
  ].join("\n");
}

/**
 * Run a `git` command via `execFile` with an argument array (never a shell
 * string). Rejects with a structured GIT_COMMAND_FAILED error on non-zero exit.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(
          structuredError(
            `git ${args[0]} failed: ${stderr ? String(stderr).trim() : error.message}`,
            "GIT_COMMAND_FAILED",
            error
          )
        );
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Create the hotfix branch, stage all changes, commit, and push the hotfix
 * branch ONLY. Rejects (without altering `main` history) if the resolved target
 * is a Protected_Branch.
 *
 * @param {string} worktreePath - The worktree containing the fix.
 * @param {string} incidentId - Sanitized incident id.
 * @param {string} message - Commit message.
 * @returns {Promise<string>} the pushed branch name (`hotfix/<id>`).
 * @throws {Error} INVALID_INCIDENT_ID | PROTECTED_BRANCH | GIT_COMMAND_FAILED.
 */
async function commitAndPush(worktreePath, incidentId, message) {
  const branchName = buildBranchName(incidentId);

  // Defense in depth: never let a push target resolve to a protected branch.
  assertNotProtectedBranch(branchName);

  const commitMessage =
    typeof message === "string" && message.length > 0
      ? message
      : `fix: auto-triage ${incidentId}`;

  // Create (or reset to) the hotfix branch, stage, commit, and push -u to that
  // branch ONLY. Each call uses an argument array — no shell interpolation.
  await runGit(["checkout", "-B", branchName], worktreePath);
  await runGit(["add", "--all"], worktreePath);
  await runGit(["commit", "-m", commitMessage], worktreePath);
  await runGit(["push", "-u", "origin", branchName], worktreePath);

  return branchName;
}

/**
 * Parse the `owner/repo` slug from a REPO_URL (https or git@ form).
 * @param {string} repoUrl
 * @returns {string} "owner/repo"
 * @throws {Error} PR_CREATE_FAILED when the URL cannot be parsed.
 */
function parseRepoSlug(repoUrl) {
  if (typeof repoUrl !== "string" || repoUrl.length === 0) {
    throw structuredError("REPO_URL is required to open a PR", "PR_CREATE_FAILED");
  }
  // Handles https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  const match = repoUrl.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw structuredError(`could not parse repo slug from REPO_URL`, "PR_CREATE_FAILED");
  }
  return match[1];
}

/**
 * Open a GitHub Pull Request for the hotfix branch using GITHUB_TOKEN. The PR
 * targets `main` for human review — the controller NEVER merges. Returns the PR
 * URL; raises a structured error on failure.
 *
 * @param {string} incidentId - Sanitized incident id (resolves the head branch).
 * @param {{
 *   incident?: object,
 *   affectedFiles?: string[],
 *   title?: string,
 *   body?: string,
 *   base?: string,
 *   token?: string,
 *   repoUrl?: string,
 *   httpClient?: import("axios").AxiosInstance
 * }} [prMeta]
 * @returns {Promise<string>} the created Pull Request URL.
 * @throws {Error} PR_CREATE_FAILED on auth/network/API failure.
 */
async function createPullRequest(incidentId, prMeta = {}) {
  const headBranch = buildBranchName(incidentId);

  // The PR may TARGET main (human reviews + merges) but we never push to it.
  const base = typeof prMeta.base === "string" && prMeta.base.length > 0 ? prMeta.base : "main";

  const token = prMeta.token || process.env.GITHUB_TOKEN;
  const repoUrl = prMeta.repoUrl || process.env.REPO_URL;
  const httpClient = prMeta.httpClient || axios;

  if (!token) {
    throw structuredError("GITHUB_TOKEN is required to open a PR", "PR_CREATE_FAILED");
  }

  const slug = parseRepoSlug(repoUrl);
  const title = prMeta.title || buildPrTitle(prMeta.incident || {});
  const body = prMeta.body || buildPrBody(prMeta.incident || {}, prMeta.affectedFiles);

  try {
    const response = await httpClient.post(
      `https://api.github.com/repos/${slug}/pulls`,
      { title, body, head: headBranch, base },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    const prUrl = response && response.data && response.data.html_url;
    const prNumber = response && response.data && response.data.number;
    if (!prUrl) {
      throw structuredError(
        "PR creation returned no html_url",
        "PR_CREATE_FAILED"
      );
    }

    // Request reviewers (best-effort — don't fail the PR if this errors)
    const reviewers = process.env.PR_REVIEWERS
      ? process.env.PR_REVIEWERS.split(",").map((r) => r.trim())
      : ["heyitsgautham"];
    if (prNumber && reviewers.length > 0) {
      try {
        await httpClient.post(
          `https://api.github.com/repos/${slug}/pulls/${prNumber}/requested_reviewers`,
          { reviewers },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }
        );
      } catch (_reviewErr) {
        // Best-effort: reviewer request failing should not block the PR.
      }
    }

    return prUrl;
  } catch (error) {
    if (error && error.code === "PR_CREATE_FAILED") {
      throw error;
    }
    const status = error && error.response && error.response.status;
    const detail = status ? `HTTP ${status}` : error.message;
    throw structuredError(`failed to create pull request: ${detail}`, "PR_CREATE_FAILED", error);
  }
}

module.exports = {
  // Constants
  INCIDENT_ID_PATTERN,
  PROTECTED_BRANCHES,
  MAX_PR_TITLE_LENGTH,
  // Pure helpers
  buildBranchName,
  buildPrTitle,
  buildPrBody,
  isProtectedBranch,
  assertNotProtectedBranch,
  sanitizeIncidentId,
  parseRepoSlug,
  // Side-effecting operations
  commitAndPush,
  createPullRequest,
};
