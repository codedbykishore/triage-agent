/**
 * kiroRunner.js — Kiro Runner (Module 2 / Person B)
 *
 * Invokes the Kiro CLI in HEADLESS (non-interactive, one-shot) mode as a child
 * process scoped to a specific worktree, supplies the system prompt, captures
 * output, and enforces a timeout that kills a hung run.
 *
 * Hard constraints (the Controller runs in a headless Docker container):
 *   - NEVER launch or attach to the Kiro IDE.
 *   - NEVER use interactive / TTY flags that require human input.
 *   - The child is spawned via `child_process.spawn` with an ARGUMENT ARRAY —
 *     never an interpolated shell string.
 *   - `cwd` is set to the worktree so the run cannot affect other incidents.
 *   - Authentication is supplied via the KIRO_API_KEY environment variable.
 *
 * Public surface (see src/contracts.md):
 *   - loadSystemPrompt(path)                          -> string
 *   - buildKiroArgs(systemPrompt)                     -> string[]
 *   - async runKiro(worktreePath, systemPrompt, opts) -> KiroResult
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

/**
 * Default location of the incident-responder system prompt, relative to the
 * project root (the directory that contains `src/`).
 * @type {string}
 */
const DEFAULT_PROMPT_PATH = path.resolve(
  __dirname,
  "..",
  "system_prompts",
  "incident_responder.txt"
);

/**
 * Default Kiro CLI binary name. Override via the KIRO_CLI_BIN env var or
 * `options.binary` (handy for tests / alternate installs).
 * @type {string}
 */
const DEFAULT_BINARY = "kiro-cli";

/**
 * Fallback timeout (ms) if neither `options.timeoutMs` nor KIRO_TIMEOUT_MS is set.
 * @type {number}
 */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Exit code reported when a run is killed for exceeding its timeout (mirrors the
 * conventional 128+SIGTERM-ish "timeout" code; the authoritative signal is the
 * `timedOut` flag).
 * @type {number}
 */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Build a structured error for spawn failures.
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function structuredError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Read the system prompt from disk (synchronous — it is small and read once per
 * run before spawning).
 *
 * @param {string} [promptPath=DEFAULT_PROMPT_PATH]
 * @returns {string} the prompt text.
 * @throws {Error} SYSTEM_PROMPT_UNREADABLE when the file cannot be read.
 */
function loadSystemPrompt(promptPath = DEFAULT_PROMPT_PATH) {
  try {
    return fs.readFileSync(promptPath, "utf8");
  } catch (err) {
    throw structuredError(
      "SYSTEM_PROMPT_UNREADABLE",
      `failed to read system prompt at ${promptPath}: ${err.message}`
    );
  }
}

/**
 * Build the CLI argument array for a HEADLESS, non-interactive Kiro run.
 *
 * Uses `kiro-cli chat --no-interactive --trust-all-tools` with the system prompt
 * passed as the initial INPUT argument. This runs Kiro in one-shot mode: it
 * processes the prompt, performs the task, and exits. No TTY or interactive
 * flags are used.
 *
 * @param {string} systemPrompt
 * @returns {string[]} argument array (never a shell string).
 */
function buildKiroArgs(systemPrompt) {
  return [
    "chat",
    "--no-interactive",
    "--trust-all-tools",
    typeof systemPrompt === "string" ? systemPrompt : "",
  ];
}

/**
 * Run the Kiro CLI headlessly inside a worktree and capture a structured result.
 *
 * @param {string} worktreePath - cwd for the child; isolates the run.
 * @param {string} systemPrompt - prompt text supplied to Kiro.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - kill the process after this many ms.
 * @param {string} [options.binary] - override the Kiro CLI binary.
 * @param {string} [options.apiKey] - override KIRO_API_KEY.
 * @param {function} [options.spawn] - injectable spawn (tests).
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runKiro(worktreePath, systemPrompt, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number(process.env.KIRO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const binary = options.binary || process.env.KIRO_CLI_BIN || DEFAULT_BINARY;
  const apiKey =
    typeof options.apiKey === "string" ? options.apiKey : process.env.KIRO_API_KEY;
  const spawnFn = typeof options.spawn === "function" ? options.spawn : spawn;
  const args = buildKiroArgs(systemPrompt);

  return new Promise((resolve, reject) => {
    let child;
    try {
      // HOME must point to the user home where kiro-cli auth is cached (device flow).
      // When running under PM2/root, the system HOME is /root but the kiro-cli login
      // was done as ec2-user. Prefer KIRO_HOME env var, fall back to HOME.
      const kiroHome = process.env.KIRO_HOME || process.env.HOME;
      child = spawnFn(binary, args, {
        cwd: worktreePath,
        // Pass HOME so kiro-cli finds its cached auth token from device flow.
        // KIRO_API_KEY is kept for backward compat but kiro-cli uses its own auth.
        env: { ...process.env, KIRO_API_KEY: apiKey, HOME: kiroHome },
        // No stdin: headless runs never read from a TTY.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(structuredError("KIRO_SPAWN_FAILED", `failed to spawn Kiro CLI: ${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_err) {
        // process may already be gone
      }
    }, timeoutMs);

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(structuredError("KIRO_SPAWN_FAILED", `Kiro CLI process error: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let exitCode;
      if (typeof code === "number") {
        exitCode = code;
      } else {
        exitCode = timedOut ? TIMEOUT_EXIT_CODE : 1;
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

module.exports = {
  // Constants
  DEFAULT_PROMPT_PATH,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_EXIT_CODE,
  // Public API
  loadSystemPrompt,
  buildKiroArgs,
  runKiro,
};
