/**
 * Unit tests for the Webhook Receiver routes (Module 1 / Person A).
 *
 * Uses supertest against an app built with `createApp({ config, handleIncident })`
 * so the routes are exercised WITHOUT the real orchestrator. Covers:
 *   - 401 unauthenticated (bad/missing signature) with no handoff
 *   - 400 malformed payload (authenticated but no [ERROR] line) with no handoff
 *   - 202 accepted with async handoff (injected handler invoked with the incident)
 *   - 200 health liveness
 *
 * Requirements: 1.1, 1.2, 1.5, 1.6, 2.4
 */

"use strict";

const request = require("supertest");
const { createApp, computeSignature, SIGNATURE_HEADER } = require("../src/server");

const SECRET = "test-webhook-secret";

/**
 * Build an app plus a jest mock handler. The handler resolves on a deferred
 * promise so tests can await the async handoff deterministically.
 * @param {object} [opts]
 * @param {function} [opts.handler]
 */
function buildHarness(opts = {}) {
  const calls = [];
  let resolveCalled;
  const called = new Promise((resolve) => {
    resolveCalled = resolve;
  });
  const handleIncident =
    opts.handler ||
    jest.fn(async (incident) => {
      calls.push(incident);
      resolveCalled(incident);
    });
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const app = createApp({ config: { webhookSecret: SECRET }, handleIncident, logger });
  return { app, handleIncident, calls, called, logger };
}

const VALID_PAYLOAD = "[ERROR] NullPointerException in handler\n  at app.js:42";

describe("GET /health", () => {
  test("responds 200 with a liveness body", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /webhook authentication", () => {
  test("responds 401 when the signature header is missing and does not hand off", async () => {
    const { app, handleIncident } = buildHarness();
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(401);
    expect(handleIncident).not.toHaveBeenCalled();
  });

  test("responds 401 when the signature is invalid and does not hand off", async () => {
    const { app, handleIncident } = buildHarness();
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, "deadbeef")
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(401);
    expect(handleIncident).not.toHaveBeenCalled();
  });
});

describe("POST /webhook payload parsing", () => {
  test("responds 400 for an authenticated but malformed payload (no [ERROR] line)", async () => {
    const { app, handleIncident } = buildHarness();
    const badPayload = "INFO just a normal log line\nnothing to see";
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, computeSignature(badPayload, SECRET))
      .send(badPayload);
    expect(res.status).toBe(400);
    expect(handleIncident).not.toHaveBeenCalled();
  });
});

describe("POST /webhook accepted", () => {
  test("responds 202 and asynchronously invokes the injected handler with the incident", async () => {
    const { app, handleIncident, called } = buildHarness();
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, computeSignature(VALID_PAYLOAD, SECRET))
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.incidentId).toMatch(/^inc-[A-Za-z0-9-]+$/);

    // The handoff is async; wait for it to complete.
    const incident = await called;
    expect(handleIncident).toHaveBeenCalledTimes(1);
    expect(incident.id).toBe(res.body.incidentId);
    expect(incident.rawPayload).toBe(VALID_PAYLOAD);
    expect(incident.errorMessage).toContain("[ERROR]");
  });

  test("an async handler rejection is swallowed and logged, response is still 202", async () => {
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    const handleIncident = jest.fn().mockRejectedValue(new Error("boom"));
    const app = createApp({ config: { webhookSecret: SECRET }, handleIncident, logger });

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .set(SIGNATURE_HEADER, computeSignature(VALID_PAYLOAD, SECRET))
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(202);
    // allow the rejected handoff microtask/promise chain to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(logger.error).toHaveBeenCalled();
  });
});
