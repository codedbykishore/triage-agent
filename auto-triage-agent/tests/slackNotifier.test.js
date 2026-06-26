/**
 * Unit tests for slackNotifier (Module 3 / Person C).
 *
 * The Slack webhook is exercised through a mocked axios. Covers the success and
 * failure block variants, secret-scrubbed/length-bounded snippets, and that a
 * non-2xx response (or transport error) is logged WITHOUT throwing.
 *
 * Requirements: 8.2, 8.3, 8.4
 */

"use strict";

const slack = require("../src/slackNotifier");

describe("buildBlocks", () => {
  test("success variant includes status fixed and a PR link", () => {
    const payload = slack.buildBlocks({
      status: "fixed",
      incidentId: "inc-1",
      errorSnippet: "null pointer",
      prUrl: "https://github.com/acme/repo/pull/3",
    });

    const json = JSON.stringify(payload);
    expect(json).toContain("Fix prepared");
    expect(json).toContain("https://github.com/acme/repo/pull/3");
    expect(json).toContain("null pointer");
    expect(payload.blocks.some((b) => JSON.stringify(b).includes("Pull Request"))).toBe(true);
  });

  test("failure variant includes status failed and the reason, no PR link", () => {
    const payload = slack.buildBlocks({
      status: "failed",
      incidentId: "inc-2",
      errorSnippet: "bad json",
      reason: "Kiro timed out",
    });

    const json = JSON.stringify(payload);
    expect(json).toContain("Triage failed");
    expect(json).toContain("Kiro timed out");
    expect(json).not.toContain("Pull Request");
  });
});

describe("buildErrorSnippet", () => {
  test("scrubs configured secret values", () => {
    const snippet = slack.buildErrorSnippet(
      "token=ghp_supersecret failed at db pw=hunter2",
      ["ghp_supersecret", "hunter2"]
    );
    expect(snippet).not.toContain("ghp_supersecret");
    expect(snippet).not.toContain("hunter2");
    expect(snippet).toContain("[REDACTED]");
  });

  test("truncates to the fixed max length", () => {
    const snippet = slack.buildErrorSnippet("a".repeat(1000), []);
    expect(snippet.length).toBeLessThanOrEqual(slack.MAX_SNIPPET_LENGTH);
  });
});

describe("notify", () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("returns { delivered: true } on a 2xx webhook response", async () => {
    const httpClient = { post: jest.fn().mockResolvedValue({ status: 200 }) };
    const result = await slack.notify(
      { status: "fixed", incidentId: "inc-1", errorSnippet: "x", prUrl: "https://pr" },
      { webhookUrl: "https://hooks.slack.test/abc", httpClient }
    );
    expect(result).toEqual({ delivered: true });
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  test("logs and returns { delivered: false } on a non-2xx response without throwing", async () => {
    const httpClient = { post: jest.fn().mockResolvedValue({ status: 500 }) };
    const result = await slack.notify(
      { status: "failed", incidentId: "inc-3", errorSnippet: "x", reason: "boom" },
      { webhookUrl: "https://hooks.slack.test/abc", httpClient }
    );
    expect(result).toEqual({ delivered: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  test("logs and returns { delivered: false } on a transport error without throwing", async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const result = await slack.notify(
      { status: "failed", incidentId: "inc-4", errorSnippet: "x", reason: "boom" },
      { webhookUrl: "https://hooks.slack.test/abc", httpClient }
    );
    expect(result).toEqual({ delivered: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  test("returns { delivered: false } when the webhook URL is not configured", async () => {
    const httpClient = { post: jest.fn() };
    const result = await slack.notify(
      { status: "failed", incidentId: "inc-5", errorSnippet: "x", reason: "boom" },
      { webhookUrl: "", httpClient }
    );
    expect(result).toEqual({ delivered: false });
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});
