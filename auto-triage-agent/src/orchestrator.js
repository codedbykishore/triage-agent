/**
 * orchestrator.js — Orchestrator (Module 1 / Person A — integration wiring)
 *
 * Sequences the full incident lifecycle and GUARANTEES worktree cleanup:
 *
 *   createWorktree → runKiro
 *     ├─ success (exitCode === 0 && timedOut === false):
 *     │     commitAndPush → createPullRequest → notify({status:"fixed", prUrl})
 *     └─ failure / timeout:
 *           notify({status:"failed", reason})  (no push, no PR)
 *
 * The entire body is wrapped in try/catch/finally so that:
 *   - a thrown error anywhere sends a single `failed` notification (catch), and
 *   - whenever a worktree was created, `removeWorktree` ALWAYS runs (finally),
 *     on success, Kiro failure/timeout, or a thrown error.
 *
 * All collaborators are INJECTABLE via a `deps` object (defaulting to the real
 * modules) so the orchestration logic can be unit/property tested with mocks
 * without performing any real Git, process, or network side effects. Incidents
 * are isolated: a thrown error in one `handleIncident` call cannot leak into or
 * affect another (no shared mutable state).
 *
 * Returns an IncidentResult: { status: "fixed"|"failed", prUrl?, reason? }.
 *
 * Requirements: 5.5, 7.1, 7.2, 8.1, 9.1, 9.3, 11.2, 11.3
 */

"use strict";

const worktreeManager = require("./worktreeManager");
const kiroRunner = require("./kiroRunner");
const githubInteractions = require("./githubInteractions");
const slackNotifier = require("./slackNotifier");

/**
 * Build the human-readable reason a triage did not succeed from its KiroResult.
 * @param {{ exitCode?: number, timedOut?: boolean }} [kiroResult]
 * @returns {string}
 */
function failureReason(kiroResult) {
  if (!kiroResult || typeof kiroResult !== "object") {
    return "Kiro produced no result";
  }
  if (kiroResult.timedOut === true) {
    return "Kiro triage timed out before producing a fix";
  }
  if (typeof kiroResult.exitCode === "number") {
    return `Kiro exited with non-zero status ${kiroResult.exitCode}`;
  }
  return "Kiro triage did not produce a fix";
}

/**
 * Build the commit message for a hotfix.
 * @param {{ id?: string, errorMessage?: string }} incident
 * @returns {string}
 */
function commitMessage(incident) {
  const id = (incident && incident.id) || "unknown";
  const summary =
    incident && typeof incident.errorMessage === "string"
      ? incident.errorMessage.replace(/\[ERROR\]\s*/i, "").trim()
      : "";
  return summary.length > 0
    ? `fix: auto-triage ${id} — ${summary}`
    : `fix: auto-triage ${id}`;
}

/**
 * Derive the raw text an Error_Snippet is built from. Prefers the parsed error
 * message + stack trace, falling back to the raw payload.
 * @param {object} incident
 * @returns {string}
 */
function snippetSource(incident) {
  if (!incident || typeof incident !== "object") {
    return "";
  }
  const parts = [incident.errorMessage, incident.stackTrace].filter(
    (p) => typeof p === "string" && p.length > 0
  );
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return typeof incident.rawPayload === "string" ? incident.rawPayload : "";
}

/**
 * Handle a single incident end-to-end with guaranteed cleanup.
 *
 * @param {{
 *   id: string,
 *   errorMessage?: string,
 *   stackTrace?: string,
 *   rawPayload?: string,
 *   receivedAt?: number
 * }} incident - A validated, sanitized Incident.
 * @param {object} [deps] - Injectable collaborators (default to real modules).
 * @param {function} [deps.createWorktree]
 * @param {function} [deps.removeWorktree]
 * @param {function} [deps.runKiro]
 * @param {function} [deps.loadSystemPrompt]
 * @param {function} [deps.commitAndPush]
 * @param {function} [deps.createPullRequest]
 * @param {function} [deps.buildPrBody]
 * @param {function} [deps.buildErrorSnippet]
 * @param {function} [deps.notify]
 * @param {object}   [deps.config] - Loaded Config (provides getSecretValues()).
 * @param {object}   [deps.logger=console]
 * @returns {Promise<{ status: "fixed"|"failed", prUrl?: string, reason?: string }>}
 */
async function handleIncident(incident, deps = {}) {
  const {
    createWorktree = worktreeManager.createWorktree,
    removeWorktree = worktreeManager.removeWorktree,
    runKiro = kiroRunner.runKiro,
    loadSystemPrompt = kiroRunner.loadSystemPrompt,
    commitAndPush = githubInteractions.commitAndPush,
    createPullRequest = githubInteractions.createPullRequest,
    buildPrBody = githubInteractions.buildPrBody,
    buildErrorSnippet = slackNotifier.buildErrorSnippet,
    notify = slackNotifier.notify,
    config,
    logger = console,
  } = deps;

  const incidentId = incident && incident.id;

  // Build a secret-free, length-bounded snippet ONCE up front so it is available
  // to every notification path (success, Kiro failure, or thrown error).
  const secretValues =
    config && typeof config.getSecretValues === "function"
      ? config.getSecretValues()
      : [];
  const errorSnippet = buildErrorSnippet(snippetSource(incident), secretValues);

  let worktreePath = null;
  // Guard so that EXACTLY ONE notification is dispatched per terminal execution
  // (set just before the intent to notify, so a throwing notify still counts as
  // the single dispatch and the catch block does not double-send).
  let notificationDispatched = false;
  let result;

  try {
    // Step 1: isolated environment.
    worktreePath = await createWorktree(incidentId, incident && incident.rawPayload);

    // Step 2: triage with Kiro (headless, scoped to the worktree). Pass the
    // incident id as a label so the live-streamed output (shown in a tmux/ttyd
    // demo terminal) is clearly attributed to this run.
    const kiroResult = await runKiro(worktreePath, loadSystemPrompt(), {
      label: incidentId,
    });

    // Triage is successful ONLY when exitCode === 0 AND timedOut === false.
    const triageSucceeded =
      !!kiroResult &&
      kiroResult.exitCode === 0 &&
      kiroResult.timedOut === false;

    if (triageSucceeded) {
      // Step 3: git operations — new hotfix branch ONLY (never main/production).
      const branch = await commitAndPush(
        worktreePath,
        incidentId,
        commitMessage(incident)
      );

      // Step 4: open the Pull Request for human review (never merged here).
      const prUrl = await createPullRequest(incidentId, {
        incident,
        branch,
        body: buildPrBody(incident, (incident && incident.affectedFiles) || []),
      });

      // Step 5: notify success.
      notificationDispatched = true;
      await notify({
        status: "fixed",
        incidentId,
        errorSnippet,
        prUrl,
      });
      result = { status: "fixed", prUrl };
    } else {
      // Triage failed/timed out: notify, push nothing, open no PR.
      const reason = failureReason(kiroResult);
      notificationDispatched = true;
      await notify({
        status: "failed",
        incidentId,
        errorSnippet,
        reason,
      });
      result = { status: "failed", reason };
    }
  } catch (error) {
    const reason =
      error && error.message ? error.message : "incident handling failed";
    // Only send the failure notification if one was not already dispatched, so
    // every terminal execution dispatches exactly one notification.
    if (!notificationDispatched) {
      notificationDispatched = true;
      try {
        await notify({
          status: "failed",
          incidentId,
          errorSnippet,
          reason,
        });
      } catch (notifyErr) {
        // notify is best-effort and must never prevent cleanup.
        logger.error("failed to dispatch failure notification", {
          id: incidentId,
          err: notifyErr && notifyErr.message,
        });
      }
    }
    result = { status: "failed", reason };
  } finally {
    // Step 6: GUARANTEED cleanup. If a worktree was created (worktreePath set),
    // remove it before returning — on success, failure, timeout, or throw.
    if (worktreePath !== null && worktreePath !== undefined) {
      try {
        await removeWorktree(incidentId);
      } catch (cleanupErr) {
        // removeWorktree is best-effort, but guard anyway so cleanup failure
        // never masks the result or escapes handleIncident.
        logger.error("worktree cleanup failed", {
          id: incidentId,
          err: cleanupErr && cleanupErr.message,
        });
      }
    }
  }

  return result;
}

module.exports = {
  handleIncident,
  // Exposed for unit testing / reuse.
  failureReason,
  commitMessage,
  snippetSource,
};
