/**
 * Unit tests for src/kiroRunner.js with mocked child_process.
 *
 * Asserts:
 *   - buildKiroArgs produces a HEADLESS arg array (never IDE/interactive/TTY).
 *   - runKiro spawns with cwd set to the worktree and the headless arg array.
 *   - A timeout kills the process and sets `timedOut: true`.
 *   - stdout/stderr/exitCode are captured into the KiroResult.
 *
 * Requirements: 5.1, 5.3, 5.4
 */

"use strict";

const EventEmitter = require("events");

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

const { spawn } = require("child_process");
const { buildKiroArgs, runKiro } = require("../src/kiroRunner");

/**
 * Build a fake child process: stdout/stderr emitters, a kill spy, and the
 * EventEmitter surface runKiro listens on ("error", "close").
 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe("buildKiroArgs — headless, non-interactive", () => {
  test("includes non-interactive flags and never IDE/interactive/TTY flags", () => {
    const args = buildKiroArgs("SYSTEM PROMPT");

    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("chat");
    expect(args).toContain("--no-interactive");
    expect(args).toContain("--trust-all-tools");
    expect(args).toContain("SYSTEM PROMPT");

    // No flag may request an interactive session, a TTY, or the IDE.
    const joined = args.join(" ");
    expect(joined).not.toMatch(/--tty\b/);
    expect(joined).not.toMatch(/--ide\b/);
    expect(joined).not.toMatch(/\bopen\b/);
  });
});

describe("runKiro — spawn wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("spawns with cwd set to the worktree and the headless arg array", async () => {
    const child = makeFakeChild();
    spawn.mockReturnValue(child);

    const promise = runKiro("/tmp/worktrees/inc-1", "PROMPT", { apiKey: "k" });

    // Drive the process to completion.
    child.stdout.emit("data", Buffer.from("done"));
    child.emit("close", 0);
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [binary, args, opts] = spawn.mock.calls[0];
    expect(typeof binary).toBe("string");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("--no-interactive");
    expect(args).toContain("--trust-all-tools");
    expect(opts.cwd).toBe("/tmp/worktrees/inc-1");
    // Auth is passed via env, not args.
    expect(opts.env.KIRO_API_KEY).toBe("k");
    // No shell is used.
    expect(opts.shell).toBeUndefined();
  });

  test("captures stdout, stderr, and exit code into the KiroResult", async () => {
    const child = makeFakeChild();
    spawn.mockReturnValue(child);

    const promise = runKiro("/wt", "PROMPT", { apiKey: "k" });
    child.stdout.emit("data", Buffer.from("hello "));
    child.stdout.emit("data", Buffer.from("world"));
    child.stderr.emit("data", Buffer.from("a warning"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello world",
      stderr: "a warning",
      timedOut: false,
    });
  });

  test("reports a non-zero exit code", async () => {
    const child = makeFakeChild();
    spawn.mockReturnValue(child);

    const promise = runKiro("/wt", "PROMPT", { apiKey: "k" });
    child.emit("close", 2);

    const result = await promise;
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  test("kills the process and sets timedOut when the timeout elapses", async () => {
    jest.useFakeTimers();
    try {
      const child = makeFakeChild();
      spawn.mockReturnValue(child);

      const promise = runKiro("/wt", "PROMPT", { apiKey: "k", timeoutMs: 1000 });

      // Advance past the timeout — runKiro should kill the child.
      jest.advanceTimersByTime(1001);
      expect(child.kill).toHaveBeenCalledTimes(1);

      // The killed process eventually emits close with a null code.
      child.emit("close", null);

      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects with a structured error when spawn emits 'error'", async () => {
    const child = makeFakeChild();
    spawn.mockReturnValue(child);

    const promise = runKiro("/wt", "PROMPT", { apiKey: "k" });
    child.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toMatchObject({ code: "KIRO_SPAWN_FAILED" });
  });
});
