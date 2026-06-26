/**
 * worktreeManager.js — Worktree Manager (Module 2 / Person B)
 *
 * Provisions and tears down isolated `git worktree` directories per incident and
 * writes the raw error payload into them as `error.log`.
 *
 * Security-critical invariants:
 *   - Incident IDs are sanitized against ^inc-[A-Za-z0-9-]+$ BEFORE they ever
 *     touch a shell command or a filesystem path (no path/command injection).
 *   - Every `git` invocation uses `child_process.execFile` with an ARGUMENT
 *     ARRAY — never an interpolated shell string — so payload-derived values
 *     can never be interpreted by a shell.
 *
 * Public surface (see src/contracts.md):
 *   - sanitizeIncidentId(incidentId)          -> string | throws
 *   - worktreePathFor(incidentId)             -> string
 *   - async createWorktree(incidentId, log)   -> worktreePath
 *   - async removeWorktree(incidentId)        -> void
 *
 * Requirements: 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 9.2
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const fsp = fs.promises;

/**
 * Allowlist pattern for incident identifiers. Anything outside this alphabet
 * could carry path separators, whitespace, or shell metacharacters.
 * @type {RegExp}
 */
const INCIDENT_ID_PATTERN = /^inc-[A-Za-z0-9-]+$/;

/**
 * Default git ref the worktree is created from. Override per call via
 * `options.baseRef` or globally via the GIT_BASE_REF env var.
 * @type {string}
 */
const DEFAULT_BASE_REF = "main";

/**
 * Filename the raw payload is written to inside each worktree.
 * @type {string}
 */
const ERROR_LOG_FILENAME = "error.log";

/**
 * Build a structured error the Orchestrator can branch on for failure
 * notifications. Carries a stable `code` and the offending `incidentId`.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {Error & { code: string }}
 */
function structuredError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Resolve the base directory that holds per-incident worktrees.
 *
 * Defaults to `../worktrees` relative to the project root (the directory that
 * contains `src/`), matching the design's `../worktrees/<id>` layout. Override
 * with the WORKTREES_DIR env var (useful for tests / containers).
 * @returns {string} Absolute path to the worktrees base directory.
 */
function worktreesBaseDir() {
  if (typeof process.env.WORKTREES_DIR === "string" && process.env.WORKTREES_DIR.length > 0) {
    return path.resolve(process.env.WORKTREES_DIR);
  }
  // __dirname is .../auto-triage-agent/src — go up to the project root, then
  // to a sibling `worktrees` directory.
  return path.resolve(__dirname, "..", "worktrees");
}

/**
 * Resolve the directory git commands run from (the target repository root).
 * Defaults to the project root; override with REPO_DIR for containers/tests.
 * @returns {string}
 */
function repoDir() {
  if (typeof process.env.REPO_DIR === "string" && process.env.REPO_DIR.length > 0) {
    return path.resolve(process.env.REPO_DIR);
  }
  return path.resolve(__dirname, "..");
}

/**
 * Sanitize an incident identifier before it is used in any shell command or
 * filesystem path.
 *
 * Returns the id UNCHANGED only when it matches ^inc-[A-Za-z0-9-]+$; otherwise
 * raises. Because acceptance is by strict allowlist, a returned value can never
 * contain path separators (`/`, `\`), whitespace, or shell metacharacters.
 *
 * @param {string} incidentId
 * @returns {string} the same id, guaranteed safe.
 * @throws {Error} INVALID_INCIDENT_ID when null/empty/non-matching.
 */
function sanitizeIncidentId(incidentId) {
  if (typeof incidentId !== "string" || incidentId.length === 0) {
    throw structuredError("INVALID_INCIDENT_ID", "incident id required");
  }
  if (!INCIDENT_ID_PATTERN.test(incidentId)) {
    throw structuredError(
      "INVALID_INCIDENT_ID",
      "invalid incident id: must match ^inc-[A-Za-z0-9-]+$"
    );
  }
  return incidentId;
}

/**
 * Derive the distinct worktree path for an incident under the worktrees base
 * directory. The id is sanitized first, so the resulting path can never escape
 * the base directory via separators or traversal sequences.
 *
 * @param {string} incidentId
 * @returns {string} Absolute, collision-free worktree path.
 * @throws {Error} INVALID_INCIDENT_ID for an unsafe id.
 */
function worktreePathFor(incidentId) {
  const safeId = sanitizeIncidentId(incidentId);
  return path.join(worktreesBaseDir(), safeId);
}

/**
 * Promise wrapper around `execFile` that ALWAYS uses an argument array (no
 * shell). Resolves with { stdout, stderr } or rejects with a structured error.
 * @param {string[]} args - git arguments (e.g. ["worktree", "add", path, ref]).
 * @param {object} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    // NOTE: execFile does NOT spawn a shell — `args` are passed to git verbatim.
    execFile("git", args, { cwd: repoDir(), ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(
          structuredError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${error.message}`, {
            stderr: typeof stderr === "string" ? stderr : "",
          })
        );
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * Create an isolated worktree for an incident and write the payload as
 * `error.log` inside it.
 *
 * Steps:
 *   1. Sanitize the id and derive a distinct path.
 *   2. `git worktree add <path> <baseRef>` via an argument array (no shell).
 *   3. Write `errorLog` verbatim to `<path>/error.log`.
 *
 * @param {string} incidentId
 * @param {string} errorLog - raw payload, written verbatim.
 * @param {object} [options]
 * @param {string} [options.baseRef] - git ref to branch the worktree from.
 * @returns {Promise<string>} the created worktree path.
 * @throws {Error} WORKTREE_CREATE_FAILED (or INVALID_INCIDENT_ID) on failure.
 */
async function createWorktree(incidentId, errorLog, options = {}) {
  const worktreePath = worktreePathFor(incidentId);
  const baseRef = options.baseRef || process.env.GIT_BASE_REF || DEFAULT_BASE_REF;

  try {
    // Argument array — the sanitized path and ref are passed to git directly.
    // Use --detach so the worktree starts at the ref's commit without "checking
    // out" the branch (which would fail if that branch is already checked out in
    // the primary working tree). The hotfix branch is created later by
    // githubInteractions.commitAndPush.
    await runGit(["worktree", "add", "--detach", worktreePath, baseRef]);
  } catch (err) {
    throw structuredError(
      "WORKTREE_CREATE_FAILED",
      `failed to create worktree for ${incidentId}: ${err.message}`,
      { incidentId, cause: err }
    );
  }

  try {
    const payload = typeof errorLog === "string" ? errorLog : String(errorLog ?? "");
    await fsp.writeFile(path.join(worktreePath, ERROR_LOG_FILENAME), payload, "utf8");
  } catch (err) {
    throw structuredError(
      "WORKTREE_CREATE_FAILED",
      `failed to write ${ERROR_LOG_FILENAME} for ${incidentId}: ${err.message}`,
      { incidentId, cause: err }
    );
  }

  return worktreePath;
}

/**
 * Remove an incident's worktree, tolerating partial or failed states.
 *
 * Attempts `git worktree remove --force <path>` and then `git worktree prune`.
 * Neither failure is propagated: cleanup must never throw, so the Orchestrator's
 * finally-block cleanup can always complete (Requirement 9.2).
 *
 * @param {string} incidentId
 * @returns {Promise<void>}
 */
async function removeWorktree(incidentId) {
  let worktreePath;
  try {
    worktreePath = worktreePathFor(incidentId);
  } catch (_err) {
    // An unsafe id never created a worktree; nothing to clean up.
    return;
  }

  // Best-effort removal — swallow failures (partial/locked/already-gone).
  try {
    await runGit(["worktree", "remove", "--force", worktreePath]);
  } catch (_err) {
    // ignore: fall through to prune
  }

  try {
    await runGit(["worktree", "prune"]);
  } catch (_err) {
    // ignore: cleanup is best-effort and must not throw
  }
}

module.exports = {
  // Constants
  INCIDENT_ID_PATTERN,
  ERROR_LOG_FILENAME,
  // Public API
  sanitizeIncidentId,
  worktreePathFor,
  createWorktree,
  removeWorktree,
};
