/**
 * mock-app/server.js — Mock Production App (Module 2 / Person B, test target)
 *
 * A deliberately minimal API that intentionally throws the two codebase-related
 * runtime errors the Auto-Triage Agent is scoped to handle:
 *
 *   GET  /null-pointer  -> a null/undefined dereference (TypeError)
 *   POST /bad-json      -> an unguarded JSON.parse on malformed input (SyntaxError)
 *
 * When an endpoint throws, the error is logged to STDERR in the EXACT format the
 * webhook parser (`src/incident.js#parsePayload`) expects:
 *
 *   [ERROR] <message>
 *   <full stack trace>
 *
 * The first line begins with the `[ERROR]` marker; every following line is part
 * of the stack trace. This matches `tests/simulate_webhook.sh` and the parser.
 *
 * ---------------------------------------------------------------------------
 * CloudWatch multiline grouping
 * ---------------------------------------------------------------------------
 * A single error spans multiple lines (message + stack frames). To keep those
 * lines grouped into ONE CloudWatch log event (so the whole stack trace arrives
 * as one webhook payload), configure the awslogs driver with a multiline
 * pattern that starts a new event only on the `[ERROR]` marker:
 *
 *   awslogs-multiline-pattern: "^\\[ERROR\\]"
 *
 * Example (Docker awslogs log driver / ECS task definition logConfiguration):
 *
 *   "logConfiguration": {
 *     "logDriver": "awslogs",
 *     "options": {
 *       "awslogs-group": "/auto-triage/mock-app",
 *       "awslogs-region": "us-east-1",
 *       "awslogs-stream-prefix": "mock-app",
 *       "awslogs-multiline-pattern": "^\\[ERROR\\]"
 *     }
 *   }
 *
 * Any line NOT matching `^\[ERROR\]` (i.e. the indented "    at ..." stack
 * frames) is appended to the current event, so the message and its full stack
 * trace are delivered together. See mock-app/README.md for details.
 *
 * Requirements: 12.1, 12.3
 */

"use strict";

const express = require("express");

/**
 * Log an exception in the exact `[ERROR]` + stack-trace format the parser and
 * the CloudWatch multiline pattern expect.
 * @param {Error} err
 */
function logError(err) {
  // First line carries the [ERROR] marker and message; the stack follows.
  // We strip the stack's own leading "Error: <message>" line so the marker
  // line is authoritative and the rest is pure frames.
  const stackBody = (err.stack || "")
    .split("\n")
    .slice(1) // drop the duplicated "<ErrorType>: <message>" first line
    .join("\n");
  process.stderr.write(`[ERROR] ${err.message}\n${stackBody}\n`);
}

/**
 * Trigger a null-pointer style dereference. The bug: `user` is null but the
 * handler reads `user.profile.id` without a guard.
 * @returns {string}
 */
function readUserId() {
  const user = null; // simulated: lookup miss returns null
  return user.profile.id; // TypeError: Cannot read properties of null
}

/**
 * Parse a request body as JSON without guarding against malformed input.
 * @param {string} body
 * @returns {object}
 */
function parseConfig(body) {
  return JSON.parse(body); // SyntaxError on malformed/empty JSON
}

/**
 * Build the Express app (exported so it can be mounted/tested without binding
 * a port).
 * @returns {import("express").Express}
 */
function createApp() {
  const app = express();

  // Capture the raw body so /bad-json can attempt to parse arbitrary text.
  app.use(express.text({ type: "*/*" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Bug 1: null-pointer dereference.
  app.get("/null-pointer", (_req, res) => {
    const id = readUserId();
    res.status(200).json({ id });
  });

  // Bug 2: bad JSON parse on unguarded input.
  app.post("/bad-json", (req, res) => {
    const config = parseConfig(req.body);
    res.status(200).json({ config });
  });

  // Centralized error handler: log in [ERROR] format, return a generic 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logError(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

/* istanbul ignore next — only runs when started directly, not under tests. */
if (require.main === module) {
  const port = Number(process.env.MOCK_APP_PORT) || 4000;
  createApp().listen(port, () => {
    process.stdout.write(`[mock-app] listening on http://localhost:${port}\n`);
    process.stdout.write(
      "[mock-app] try: GET /null-pointer  and  POST /bad-json (body: 'not json')\n"
    );
  });
}

module.exports = { createApp, readUserId, parseConfig, logError };
