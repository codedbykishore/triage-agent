/**
 * Unit tests for src/incident.js payload parsing edge cases.
 *
 * Covers rejection of empty, non-string, and no-[ERROR]-line inputs (which the
 * Webhook Receiver maps to HTTP 400) and correct splitting of the error message
 * versus the stack trace.
 *
 * Requirements: 2.2, 2.4
 */

"use strict";

const {
  parsePayload,
  validateIncident,
  validateKiroResult,
  validateNotification,
  generateIncidentId,
} = require("../src/incident");

describe("parsePayload — rejection of malformed input", () => {
  test("throws an INVALID_PAYLOAD/400 error for an empty string", () => {
    let thrown;
    try {
      parsePayload("");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe("INVALID_PAYLOAD");
    expect(thrown.statusCode).toBe(400);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", { error: "boom" }],
    ["array", ["[ERROR] boom"]],
  ])("throws for non-string input (%s)", (_label, value) => {
    let thrown;
    try {
      parsePayload(value);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe("INVALID_PAYLOAD");
    expect(thrown.statusCode).toBe(400);
  });

  test("throws when the payload contains no [ERROR] line", () => {
    const payload = "INFO starting up\nWARN disk space low\nDEBUG tick";
    let thrown;
    try {
      parsePayload(payload);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe("INVALID_PAYLOAD");
    expect(thrown.statusCode).toBe(400);
  });
});

describe("parsePayload — correct message/stack-trace splitting", () => {
  test("splits the first [ERROR] line from the remaining stack trace", () => {
    const payload = [
      "[ERROR] Cannot read properties of null (reading 'id')",
      "    at getUser (/app/src/user.js:12:18)",
      "    at handler (/app/src/routes.js:7:5)",
    ].join("\n");

    const incident = parsePayload(payload);

    expect(incident.errorMessage).toBe(
      "[ERROR] Cannot read properties of null (reading 'id')"
    );
    expect(incident.stackTrace).toBe(
      [
        "    at getUser (/app/src/user.js:12:18)",
        "    at handler (/app/src/routes.js:7:5)",
      ].join("\n")
    );
    expect(incident.rawPayload).toBe(payload);
    expect(typeof incident.receivedAt).toBe("number");
  });

  test("uses the FIRST [ERROR] line when multiple are present", () => {
    const payload = [
      "INFO request received",
      "[ERROR] first failure",
      "    at a (/app/a.js:1:1)",
      "[ERROR] second failure",
    ].join("\n");

    const incident = parsePayload(payload);

    expect(incident.errorMessage).toBe("[ERROR] first failure");
    expect(incident.stackTrace).toBe(
      ["    at a (/app/a.js:1:1)", "[ERROR] second failure"].join("\n")
    );
  });

  test("handles a single [ERROR] line with an empty stack trace", () => {
    const payload = "[ERROR] standalone failure";
    const incident = parsePayload(payload);
    expect(incident.errorMessage).toBe("[ERROR] standalone failure");
    expect(incident.stackTrace).toBe("");
  });

  test("handles CRLF line endings while preserving the raw payload", () => {
    const payload = "[ERROR] boom\r\n    at x (/app/x.js:3:9)";
    const incident = parsePayload(payload);
    expect(incident.errorMessage).toBe("[ERROR] boom");
    expect(incident.stackTrace).toBe("    at x (/app/x.js:3:9)");
    expect(incident.rawPayload).toBe(payload);
  });
});

describe("model validators", () => {
  test("validateIncident accepts a well-formed incident", () => {
    const incident = {
      ...parsePayload("[ERROR] boom\n    at x (/app/x.js:1:1)"),
      id: generateIncidentId(1718031200000),
    };
    expect(validateIncident(incident)).toBe(true);
  });

  test("validateIncident rejects bad ids and missing fields", () => {
    const base = {
      ...parsePayload("[ERROR] boom"),
      id: generateIncidentId(1718031200000),
    };
    expect(validateIncident({ ...base, id: "../etc/passwd" })).toBe(false);
    expect(validateIncident({ ...base, id: "inc-bad id" })).toBe(false);
    expect(validateIncident({ ...base, errorMessage: "" })).toBe(false);
    expect(validateIncident(null)).toBe(false);
  });

  test("validateKiroResult enforces the result shape", () => {
    expect(
      validateKiroResult({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
    ).toBe(true);
    expect(validateKiroResult({ exitCode: 0, stdout: "", stderr: "" })).toBe(false);
    expect(validateKiroResult(null)).toBe(false);
  });

  test("validateNotification enforces fixed/failed variants", () => {
    expect(
      validateNotification({
        status: "fixed",
        incidentId: "inc-1",
        errorSnippet: "boom",
        prUrl: "https://github.com/acme/repo/pull/1",
      })
    ).toBe(true);
    expect(
      validateNotification({
        status: "fixed",
        incidentId: "inc-1",
        errorSnippet: "boom",
        prUrl: null,
      })
    ).toBe(false);
    expect(
      validateNotification({
        status: "failed",
        incidentId: "inc-1",
        errorSnippet: "boom",
        reason: "kiro timed out",
      })
    ).toBe(true);
    expect(
      validateNotification({
        status: "failed",
        incidentId: "inc-1",
        errorSnippet: "boom",
      })
    ).toBe(false);
    expect(validateNotification({ status: "weird" })).toBe(false);
  });
});
