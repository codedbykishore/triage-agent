/**
 * Unit tests for src/config.js (Config_Loader).
 *
 * Verifies fail-fast validation: a fully-present config loads successfully,
 * and each missing required variable triggers a fail-fast error that names
 * the offending KEY without ever exposing a secret VALUE.
 *
 * Requirements: 10.1, 10.2, 11.1
 */

"use strict";

const { loadConfig } = require("../src/config");

/** A complete, valid environment with distinctive secret values. */
function validEnv() {
  return {
    GITHUB_TOKEN: "ghp_supersecrettoken1234567890",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/secretpath",
    KIRO_API_KEY: "kiro-key-abcdef-secret",
    REPO_URL: "https://github.com/acme/target-repo.git",
    WEBHOOK_SECRET: "hmac-shared-secret-value",
    KIRO_TIMEOUT_MS: "120000",
  };
}

const REQUIRED_KEYS = [
  "GITHUB_TOKEN",
  "SLACK_WEBHOOK_URL",
  "KIRO_API_KEY",
  "REPO_URL",
  "WEBHOOK_SECRET",
  "KIRO_TIMEOUT_MS",
];

const SECRET_KEYS = [
  "GITHUB_TOKEN",
  "SLACK_WEBHOOK_URL",
  "KIRO_API_KEY",
  "WEBHOOK_SECRET",
];

describe("loadConfig — successful load", () => {
  test("loads all fields when every required variable is present", () => {
    const env = validEnv();
    const config = loadConfig(env);

    expect(config.githubToken).toBe(env.GITHUB_TOKEN);
    expect(config.slackWebhookUrl).toBe(env.SLACK_WEBHOOK_URL);
    expect(config.kiroApiKey).toBe(env.KIRO_API_KEY);
    expect(config.repoUrl).toBe(env.REPO_URL);
    expect(config.webhookSecret).toBe(env.WEBHOOK_SECRET);
  });

  test("parses KIRO_TIMEOUT_MS into a number", () => {
    const config = loadConfig(validEnv());
    expect(typeof config.kiroTimeoutMs).toBe("number");
    expect(config.kiroTimeoutMs).toBe(120000);
  });

  test("getSecretValues returns the configured secret values for scrubbing", () => {
    const env = validEnv();
    const config = loadConfig(env);
    const secrets = config.getSecretValues();

    for (const key of SECRET_KEYS) {
      expect(secrets).toContain(env[key]);
    }
    // The non-secret repo URL is not part of the scrub list.
    expect(secrets).not.toContain(env.REPO_URL);
  });
});

describe("loadConfig — fail-fast on missing variables", () => {
  test.each(REQUIRED_KEYS)(
    "throws naming %s when it is missing, without leaking secret values",
    (missingKey) => {
      const env = validEnv();
      const removedValue = env[missingKey];
      delete env[missingKey];

      let thrown;
      try {
        loadConfig(env);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      // Message names the missing KEY.
      expect(thrown.message).toContain(missingKey);
      // Message must never contain any of the remaining secret VALUES.
      for (const secretKey of SECRET_KEYS) {
        if (env[secretKey] !== undefined) {
          expect(thrown.message).not.toContain(env[secretKey]);
        }
      }
      // And never the removed secret's value either.
      if (SECRET_KEYS.includes(missingKey)) {
        expect(thrown.message).not.toContain(removedValue);
      }
    }
  );

  test("treats empty/whitespace values as missing", () => {
    const env = validEnv();
    env.WEBHOOK_SECRET = "   ";
    expect(() => loadConfig(env)).toThrow(/WEBHOOK_SECRET/);
  });

  test("reports all missing keys together", () => {
    const env = validEnv();
    delete env.GITHUB_TOKEN;
    delete env.REPO_URL;
    expect(() => loadConfig(env)).toThrow(/GITHUB_TOKEN/);
    expect(() => loadConfig(env)).toThrow(/REPO_URL/);
  });
});

describe("loadConfig — KIRO_TIMEOUT_MS validation", () => {
  test("rejects a non-numeric timeout", () => {
    const env = validEnv();
    env.KIRO_TIMEOUT_MS = "not-a-number";
    expect(() => loadConfig(env)).toThrow(/KIRO_TIMEOUT_MS/);
  });

  test("rejects a non-positive timeout", () => {
    const env = validEnv();
    env.KIRO_TIMEOUT_MS = "0";
    expect(() => loadConfig(env)).toThrow(/KIRO_TIMEOUT_MS/);
  });
});
