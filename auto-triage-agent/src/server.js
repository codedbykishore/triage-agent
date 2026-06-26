/**
 * server.js — Webhook Receiver (Module 1 / Person A)
 *
 * Exposes the network endpoints, authenticates inbound `/webhook` requests with
 * a timing-safe HMAC comparison, parses CloudWatch-style payloads into an
 * `Incident`, generates a unique incident id, responds `202 Accepted`
 * immediately, then hands the incident off to an injected handler asynchronously.
 *
 * The Express app is built by a factory, `createApp({ config, handleIncident })`,
 * that accepts an injectable incident handler so the routes stay testable
 * WITHOUT the real orchestrator. The pure helper `authenticate` is exported for
 * unit/property tests.
 *
 * Task 8.5 wires the real pieces together: when this module is run directly
 * (`node src/server.js`), `startServer()` loads + validates configuration
 * (fail-fast), binds the real orchestrator's `handleIncident` with real deps and
 * config, and starts the Express server listening on the configured port.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 9.3, 10.1
 */

"use strict";

const crypto = require("crypto");
const express = require("express");

const { parsePayload, generateIncidentId } = require("./incident");
const { loadConfig } = require("./config");
const { handleIncident } = require("./orchestrator");

/**
 * Header carrying the HMAC-SHA256 signature of the raw request body.
 * @type {string}
 */
const SIGNATURE_HEADER = "x-signature";

/**
 * Compute the lowercase hex HMAC-SHA256 of `rawBody` using `secret`.
 *
 * @param {string|Buffer} rawBody
 * @param {string} secret
 * @returns {string} hex digest
 */
function computeSignature(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Authenticate a webhook request.
 *
 * Computes the HMAC-SHA256 of the raw body under the configured secret and
 * compares it to the signature supplied in the `x-signature` header using
 * `crypto.timingSafeEqual` — a constant-time comparison that does NOT
 * short-circuit on the first mismatched byte.
 *
 * A missing/empty signature, a missing secret, a non-hex signature, or a length
 * mismatch all safely return `false` (the length check is handled before the
 * timing-safe compare, which requires equal-length buffers).
 *
 * @param {object} headers - Request headers (lowercased keys, as Express provides).
 * @param {string|Buffer} rawBody - The exact raw request body used for the HMAC.
 * @param {string} secret - The configured webhook secret.
 * @returns {boolean} true iff the provided signature equals the expected HMAC.
 */
function authenticate(headers, rawBody, secret) {
  if (!headers || typeof secret !== "string" || secret.length === 0) {
    return false;
  }
  if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const provided = headers[SIGNATURE_HEADER];
  if (typeof provided !== "string" || provided.length === 0) {
    return false;
  }

  const expected = computeSignature(rawBody, secret);

  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on differing lengths; guard first so a wrong-length
  // signature returns false safely (still without leaking timing about content).
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Resolve the exact raw body string captured for HMAC verification.
 * The `express.raw` body parser (configured below) leaves a Buffer on
 * `req.body`; we also stash the string on `req.rawBody` for convenience.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRawBody(req) {
  if (typeof req.rawBody === "string") {
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return "";
}

/**
 * Build the Express app with an injectable incident handler.
 *
 * @param {object} deps
 * @param {object} deps.config - Loaded Config (provides `webhookSecret`).
 * @param {function(object): (void|Promise<void>)} deps.handleIncident -
 *   Async incident handler invoked out-of-band after the 202 response.
 * @param {object} [deps.logger=console] - Logger with `error`/`warn`/`info`.
 * @returns {import('express').Express}
 */
function createApp({ config, handleIncident, logger = console } = {}) {
  if (!config || typeof config.webhookSecret !== "string") {
    throw new Error("createApp requires a config with a webhookSecret");
  }
  if (typeof handleIncident !== "function") {
    throw new Error("createApp requires a handleIncident function");
  }

  const app = express();

  // Capture the RAW body verbatim for HMAC verification. express.raw yields a
  // Buffer on req.body; the verify callback preserves the exact bytes as a
  // string on req.rawBody so parsePayload sees precisely what was signed.
  app.use(
    "/webhook",
    express.raw({
      type: () => true,
      verify: (req, _res, buf) => {
        req.rawBody = buf && buf.length ? buf.toString("utf8") : "";
      },
    })
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/webhook", (req, res) => {
    const rawBody = getRawBody(req);

    // Step 1: authenticate FIRST. On failure, do not parse/generate/orchestrate.
    if (!authenticate(req.headers, rawBody, config.webhookSecret)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // Step 2: parse the payload; malformed input -> 400 (no orchestration).
    let parsed;
    try {
      parsed = parsePayload(rawBody);
    } catch (err) {
      if (err && err.code === "INVALID_PAYLOAD") {
        logger.warn("rejected malformed webhook payload", { code: err.code });
        return res.status(400).json({ error: "invalid payload" });
      }
      throw err;
    }

    // Step 3: assign a unique, injection-safe incident id.
    const incident = {
      ...parsed,
      id: generateIncidentId(Date.now()),
      receivedAt: Date.now(),
    };

    // Step 4: respond 202 immediately; process out of band.
    res.status(202).json({ accepted: true, incidentId: incident.id });

    // Step 5: async handoff — never block the response; swallow/log async errors
    // so a handler failure cannot crash the receiver.
    Promise.resolve()
      .then(() => handleIncident(incident))
      .catch((err) =>
        logger.error("incident handling failed", {
          id: incident.id,
          err: err && err.message,
        })
      );
  });

  return app;
}

/**
 * Default port the Controller listens on when neither config nor env provides one.
 * @type {number}
 */
const DEFAULT_PORT = 3000;

/**
 * Resolve the listen port from config / environment, falling back to a default.
 * @param {object} [config]
 * @returns {number}
 */
function resolvePort(config) {
  const fromEnv = Number(process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  if (config && Number.isFinite(Number(config.port)) && Number(config.port) > 0) {
    return Number(config.port);
  }
  return DEFAULT_PORT;
}

/**
 * Boot the Agent Controller: validate configuration (fail-fast), bind the real
 * orchestrator's `handleIncident` with real deps + config, build the Express
 * app, and start listening. Any startup failure (e.g. missing env var) exits
 * the process non-zero with a key-only message (never a secret value).
 *
 * @param {object} [options]
 * @param {object} [options.logger=console]
 * @returns {import('http').Server}
 */
function startServer({ logger = console } = {}) {
  let config;
  try {
    // Fail-fast configuration validation at process start.
    config = loadConfig();
  } catch (err) {
    logger.error(`Configuration error: ${err && err.message}`);
    // Exit non-zero so a missing/invalid env var stops the Controller at boot.
    process.exit(1);
    return undefined; // unreachable; aids testability if exit is stubbed.
  }

  // Bind the real orchestrator handler with real collaborators + config so the
  // webhook handler actually invokes the full incident lifecycle (no orphaned
  // code). The orchestrator defaults to the real modules; we inject config so
  // its secret values are scrubbed from Slack snippets.
  const boundHandleIncident = (incident) => handleIncident(incident, { config, logger });

  const app = createApp({ config, handleIncident: boundHandleIncident, logger });

  const port = resolvePort(config);
  const server = app.listen(port, () => {
    logger.info(`Auto-Triage Agent Controller listening on port ${port}`);
  });

  return server;
}

module.exports = {
  createApp,
  startServer,
  authenticate,
  computeSignature,
  SIGNATURE_HEADER,
};

// When run directly (`node src/server.js`), boot the Controller. Guarded so
// importing this module in tests never starts a listener or validates config.
if (require.main === module) {
  startServer();
}
