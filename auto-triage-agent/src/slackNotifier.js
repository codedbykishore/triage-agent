/**
 * slackNotifier.js — Slack_Notifier (Module 3 / Person C)
 *
 * Formats and delivers Slack Block Kit alerts to the `#qa` channel for both
 * success ("fixed") and failure ("failed") outcomes. Delivery is best-effort:
 * a non-2xx response or a thrown transport error is LOGGED and surfaced as
 * `{ delivered: false }` — it never throws, so it can never crash the
 * Orchestrator or block worktree cleanup.
 *
 * The Error_Snippet is built secret-free: every configured secret value is
 * scrubbed before the text is truncated to a fixed maximum length.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 11.2, 11.3
 */

"use strict";

const axios = require("axios");

/**
 * Fixed maximum length for an Error_Snippet placed in a notification.
 * @type {number}
 */
const MAX_SNIPPET_LENGTH = 500;

/**
 * Preferred, human-readable placeholder substituted in place of a configured
 * secret value. It is only used when it can be proven safe for the specific set
 * of configured secrets (see {@link buildErrorSnippet}); otherwise a sentinel
 * marker built from a guaranteed-absent character is used instead.
 * @type {string}
 */
const REDACTION = "[REDACTED]";

/**
 * Ordered list of readable candidate characters considered for the redaction
 * sentinel. The first one that does not occur in ANY configured secret is used.
 * @type {string[]}
 */
const SENTINEL_CANDIDATES = [
  "\u2588", // █ full block
  "#",
  "*",
  "=",
  "X",
  "@",
  "~",
  "^",
  "|",
  "%",
];

/**
 * Find a single character that is guaranteed to be ABSENT from every configured
 * secret value. Readable candidates are tried first; if every one of them
 * appears in some secret, we fall back to scanning the Unicode Private Use Area
 * (U+E000…) for the first code point absent from all secrets. Because the set of
 * secrets is finite, such a character always exists.
 *
 * @param {string[]} secrets - Non-empty secret values.
 * @returns {string} A character present in none of the secrets.
 */
function pickSentinelChar(secrets) {
  const present = new Set();
  for (const secret of secrets) {
    for (const ch of secret) {
      present.add(ch);
    }
  }

  for (const candidate of SENTINEL_CANDIDATES) {
    if (!present.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: scan the Private Use Area for an unused code point.
  for (let code = 0xe000; code <= 0xf8ff; code += 1) {
    const candidate = String.fromCodePoint(code);
    if (!present.has(candidate)) {
      return candidate;
    }
  }

  // Theoretical last resort (the PUA cannot be fully exhausted by finite input).
  return "\u0000";
}

/**
 * Choose a redaction marker that is provably safe for the given secrets.
 *
 * The readable {@link REDACTION} marker is used only when BOTH hold:
 *   1. No secret is a substring of the marker (so the marker itself never
 *      re-exposes a secret), AND
 *   2. The marker's first and last characters are absent from every secret
 *      (its surrounding brackets then act as hard separators, so no secret can
 *      span a marker/kept-text boundary, nor span two adjacent markers).
 *
 * Otherwise the marker is built solely from a sentinel character guaranteed to
 * be absent from every secret, so it can never reintroduce or recombine into a
 * secret value.
 *
 * @param {string[]} secrets - Non-empty secret values.
 * @returns {string} A redaction marker safe for these secrets.
 */
function pickRedactionMarker(secrets) {
  const first = REDACTION[0];
  const last = REDACTION[REDACTION.length - 1];
  const bracketsAreSeparators = secrets.every(
    (s) => !s.includes(first) && !s.includes(last)
  );
  const markerIsClean = secrets.every((s) => !REDACTION.includes(s));

  if (bracketsAreSeparators && markerIsClean) {
    return REDACTION;
  }

  const sentinel = pickSentinelChar(secrets);
  return sentinel.repeat(3);
}

/**
 * Build a length-bounded, provably secret-free Error_Snippet.
 *
 * Secrets are scrubbed FIRST (every full occurrence replaced with a marker that
 * cannot reintroduce or recombine into a secret), then the result is truncated
 * to `maxLength`. Truncation only removes trailing characters, so it can never
 * reintroduce a secret, and the final length is always `<= maxLength`.
 *
 * @param {string} rawText - The raw error text (may contain secrets).
 * @param {string[]} [secretValues] - Configured secret values to remove.
 * @param {number} [maxLength=MAX_SNIPPET_LENGTH] - Hard length cap.
 * @returns {string}
 */
function buildErrorSnippet(rawText, secretValues = [], maxLength = MAX_SNIPPET_LENGTH) {
  let text = typeof rawText === "string" ? rawText : "";

  // Keep only non-empty string secrets.
  const secrets = Array.isArray(secretValues)
    ? secretValues.filter((s) => typeof s === "string" && s.length > 0)
    : [];

  if (secrets.length > 0) {
    const marker = pickRedactionMarker(secrets);

    // Replace every occurrence of every secret with the safe marker.
    for (const secret of secrets) {
      text = text.split(secret).join(marker);
    }

    // Stabilization safety net: keep replacing until no secret remains. The
    // chosen marker either separates surrounding text with a guaranteed-absent
    // character (sentinel marker — strictly reduces non-sentinel characters per
    // replacement) or is bracket-protected (readable marker — no residue), so
    // this loop always terminates. The character-count bound makes that
    // explicit and guards against pathological inputs.
    let guard = text.length + 1;
    let unstable = true;
    while (unstable && guard > 0) {
      unstable = false;
      for (const secret of secrets) {
        if (text.includes(secret)) {
          text = text.split(secret).join(marker);
          unstable = true;
        }
      }
      guard -= 1;
    }
  }

  // Truncate by removing trailing characters only (a prefix of secret-free text
  // is itself secret-free), keeping the length at most maxLength.
  const cap = Math.max(0, maxLength);
  if (text.length > cap) {
    text = text.slice(0, cap);
  }
  return text;
}

/**
 * Build a Slack Block Kit payload for the `#qa` channel.
 *
 * Success ("fixed") shows the status, error snippet, and a clickable PR link.
 * Failure ("failed") is a distinct variant that shows the failure reason and
 * the error snippet (no PR link).
 *
 * @param {{
 *   status: "fixed"|"failed",
 *   incidentId: string,
 *   errorSnippet: string,
 *   prUrl?: string|null,
 *   reason?: string|null
 * }} notification
 * @returns {{ text: string, blocks: object[] }}
 */
function buildBlocks(notification) {
  const n = notification && typeof notification === "object" ? notification : {};
  const isFixed = n.status === "fixed";
  const incidentId = n.incidentId || "(unknown)";
  const snippet = typeof n.errorSnippet === "string" ? n.errorSnippet : "";

  const headerText = isFixed
    ? `:white_check_mark: Fix prepared — ${incidentId}`
    : `:x: Triage failed — ${incidentId}`;

  const fallbackText = isFixed
    ? `Fix prepared for ${incidentId}`
    : `Triage failed for ${incidentId}`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status:*\n${isFixed ? "Fixed" : "Failed"}` },
        { type: "mrkdwn", text: `*Incident:*\n${incidentId}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Error:*\n\`\`\`${snippet}\`\`\`` },
    },
  ];

  if (isFixed) {
    const prUrl = n.prUrl || "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Pull Request:*\n<${prUrl}|Review the fix>` },
    });
  } else {
    const reason = n.reason || "Triage did not produce a fix.";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Reason:*\n${reason}` },
    });
  }

  return { text: fallbackText, blocks };
}

/**
 * Deliver a Slack notification. Posts the Block Kit payload to the configured
 * Slack webhook URL via axios. On a non-2xx response or any transport error,
 * the failure is logged and `{ delivered: false }` is returned — this function
 * NEVER throws.
 *
 * @param {object} notification - A Notification object.
 * @param {{ webhookUrl?: string, httpClient?: import("axios").AxiosInstance }} [options]
 * @returns {Promise<{ delivered: boolean }>}
 */
async function notify(notification, options = {}) {
  const webhookUrl = options.webhookUrl || process.env.SLACK_WEBHOOK_URL;
  const httpClient = options.httpClient || axios;

  if (!webhookUrl) {
    // Misconfiguration is logged (by key, not value) and reported, not thrown.
    console.error("Slack delivery skipped: SLACK_WEBHOOK_URL is not configured");
    return { delivered: false };
  }

  const payload = buildBlocks(notification);

  try {
    const response = await httpClient.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
      // Treat any status as resolved so we classify 2xx vs non-2xx ourselves.
      validateStatus: () => true,
    });

    const status = response && typeof response.status === "number" ? response.status : 0;
    if (status >= 200 && status < 300) {
      return { delivered: true };
    }

    console.error(
      `Slack delivery failed: webhook returned non-2xx status ${status}`
    );
    return { delivered: false };
  } catch (error) {
    console.error(`Slack delivery failed: ${error && error.message ? error.message : error}`);
    return { delivered: false };
  }
}

module.exports = {
  // Constants
  MAX_SNIPPET_LENGTH,
  REDACTION,
  // Pure helpers
  buildErrorSnippet,
  buildBlocks,
  // Side-effecting operation
  notify,
};
