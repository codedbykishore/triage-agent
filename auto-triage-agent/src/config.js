/**
 * config.js — Config_Loader (Module 1 / Person A)
 *
 * Loads environment variables via dotenv and builds the validated `Config`
 * data model. Fails fast at startup when any required variable is missing,
 * emitting a message that names the offending variable by KEY only — secret
 * VALUES are never logged or included in error messages.
 *
 * Requirements: 10.1, 10.2, 11.1
 */

"use strict";

require("dotenv").config();

/**
 * Required environment variables mapped to their `Config` field names.
 * The order here defines the order missing keys are reported in.
 * @type {Array<{ key: string, field: string, secret: boolean, numeric?: boolean }>}
 */
const REQUIRED_VARS = [
  { key: "GITHUB_TOKEN", field: "githubToken", secret: true },
  { key: "SLACK_WEBHOOK_URL", field: "slackWebhookUrl", secret: true },
  { key: "REPO_URL", field: "repoUrl", secret: false },
  { key: "WEBHOOK_SECRET", field: "webhookSecret", secret: true },
  { key: "KIRO_TIMEOUT_MS", field: "kiroTimeoutMs", secret: false, numeric: true },
];

/**
 * Determine whether a raw env value counts as "present".
 * Empty strings and whitespace-only values are treated as missing so that an
 * uncommented-but-blank entry in `.env` still fails fast.
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Load and validate configuration from the process environment.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment source (injectable for tests).
 * @returns {{
 *   githubToken: string,
 *   slackWebhookUrl: string,
 *   repoUrl: string,
 *   webhookSecret: string,
 *   kiroTimeoutMs: number,
 *   getSecretValues: function(): string[]
 * }} The validated Config object.
 * @throws {Error} Fails fast naming the missing/invalid variable(s) by KEY (never value).
 */
function loadConfig(env = process.env) {
  const missing = [];
  const config = {};

  for (const { key, field } of REQUIRED_VARS) {
    if (!isPresent(env[key])) {
      missing.push(key);
      continue;
    }
    config[field] = env[key];
  }

  if (missing.length > 0) {
    // Name the missing variables by KEY only — never echo any secret value.
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }

  // KIRO_TIMEOUT_MS must parse to a positive, finite number.
  const timeoutMs = Number(config.kiroTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Invalid environment variable KIRO_TIMEOUT_MS: expected a positive number of milliseconds"
    );
  }
  config.kiroTimeoutMs = timeoutMs;

  /**
   * The configured secret VALUES, for downstream secret-scrubbing (e.g. the
   * Slack notifier / orchestrator strip these from any error snippet).
   * Only non-empty secret values are returned.
   * @returns {string[]}
   */
  config.getSecretValues = function getSecretValues() {
    return REQUIRED_VARS.filter((v) => v.secret)
      .map((v) => config[v.field])
      .filter((value) => typeof value === "string" && value.length > 0);
  };

  return config;
}

module.exports = { loadConfig };
