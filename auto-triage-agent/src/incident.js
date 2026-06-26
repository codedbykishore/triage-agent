/**
 * incident.js — Core data models and pure helpers (Module 1 / Person A)
 *
 * Defines the shared `Incident`, `KiroResult`, and `Notification` model shapes
 * plus their validators, and the two pure helpers consumed by the Webhook
 * Receiver:
 *
 *   - `generateIncidentId(now)` produces a unique, injection-safe incident id
 *     matching ^inc-[A-Za-z0-9-]+$ by combining a timestamp with random entropy.
 *   - `parsePayload(rawBody)` normalizes a CloudWatch-style payload into an
 *     `Incident`, preserving the raw payload verbatim for `error.log`.
 *
 * All functions here are pure (no I/O, no shared mutable state) so they can be
 * exercised by unit and property tests without mocks.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2
 */

"use strict";

const crypto = require("crypto");

/**
 * Allowlist pattern for incident identifiers. Anything outside this alphabet
 * could carry path separators, whitespace, or shell metacharacters, so it is
 * rejected everywhere ids are used (generation here, sanitization downstream).
 * @type {RegExp}
 */
const INCIDENT_ID_PATTERN = /^inc-[A-Za-z0-9-]+$/;

/**
 * Marker used by the first error line of a CloudWatch-style payload.
 * @type {string}
 */
const ERROR_MARKER = "[ERROR]";

/**
 * Build an invalid-payload error the Webhook Receiver can map to HTTP 400.
 * @param {string} message
 * @returns {Error & { code: string, statusCode: number }}
 */
function invalidPayloadError(message) {
  const err = new Error(message);
  err.code = "INVALID_PAYLOAD";
  err.statusCode = 400;
  return err;
}

/**
 * Generate a unique, injection-safe incident id.
 *
 * The id combines a base36-encoded timestamp (human-correlatable, monotonic
 * across distinct instants) with random entropy (collision resistance for ids
 * minted within the same millisecond). The result always matches
 * `^inc-[A-Za-z0-9-]+$`.
 *
 * @param {number|Date} [now=Date.now()] - Timestamp source (epoch millis or Date).
 * @returns {string} An id like "inc-1a2b3c-9f8e7d6c".
 */
function generateIncidentId(now = Date.now()) {
  const millis = now instanceof Date ? now.getTime() : Number(now);
  // Fall back to the current time for a non-finite/invalid input so we never
  // emit "inc-NaN-...". A valid id is always produced.
  const safeMillis = Number.isFinite(millis) ? Math.abs(Math.trunc(millis)) : Date.now();

  const timePart = safeMillis.toString(36);
  // 8 hex chars (4 bytes) of entropy — characters are within [0-9a-f].
  const randomPart = crypto.randomBytes(4).toString("hex");

  return `inc-${timePart}-${randomPart}`;
}

/**
 * Parse a CloudWatch-style error payload into a normalized `Incident`.
 *
 * The first line containing `[ERROR]` becomes `errorMessage`; the lines after
 * it become the `stackTrace`. `rawPayload` is preserved exactly equal to the
 * input so it can be written verbatim to `error.log`.
 *
 * @param {string} rawBody - The raw request body.
 * @param {number|Date} [now=Date.now()] - Receipt timestamp source.
 * @returns {{
 *   errorMessage: string,
 *   stackTrace: string,
 *   rawPayload: string,
 *   receivedAt: number
 * }} A partial Incident (the `id` is assigned separately by the receiver).
 * @throws {Error} INVALID_PAYLOAD (statusCode 400) for empty, non-string, or
 *   `[ERROR]`-free input.
 */
function parsePayload(rawBody, now = Date.now()) {
  if (typeof rawBody !== "string") {
    throw invalidPayloadError("payload must be a string");
  }
  if (rawBody.length === 0) {
    throw invalidPayloadError("payload must not be empty");
  }

  // Split on both LF and CRLF without mutating the original (rawPayload stays
  // exactly equal to rawBody).
  const lines = rawBody.split(/\r?\n/);
  const errorIndex = lines.findIndex((line) => line.includes(ERROR_MARKER));

  if (errorIndex === -1) {
    throw invalidPayloadError(`payload contains no ${ERROR_MARKER} line`);
  }

  const errorMessage = lines[errorIndex];
  const stackTrace = lines.slice(errorIndex + 1).join("\n");

  const millis = now instanceof Date ? now.getTime() : Number(now);
  const receivedAt = Number.isFinite(millis) ? millis : Date.now();

  return {
    errorMessage,
    stackTrace,
    rawPayload: rawBody,
    receivedAt,
  };
}

/**
 * Validate an `Incident` against the contract rules:
 * - `id` matches ^inc-[A-Za-z0-9-]+$
 * - `errorMessage` is a non-empty string
 * - `stackTrace` is a string
 * - `rawPayload` is a string
 * - `receivedAt` is a finite number
 *
 * @param {*} incident
 * @returns {boolean}
 */
function validateIncident(incident) {
  if (!incident || typeof incident !== "object") {
    return false;
  }
  return (
    typeof incident.id === "string" &&
    INCIDENT_ID_PATTERN.test(incident.id) &&
    typeof incident.errorMessage === "string" &&
    incident.errorMessage.length > 0 &&
    typeof incident.stackTrace === "string" &&
    typeof incident.rawPayload === "string" &&
    typeof incident.receivedAt === "number" &&
    Number.isFinite(incident.receivedAt)
  );
}

/**
 * Validate a `KiroResult`. Triage is only successful when
 * `exitCode === 0 && timedOut === false` (callers enforce that separately).
 *
 * @param {*} result
 * @returns {boolean}
 */
function validateKiroResult(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  return (
    typeof result.exitCode === "number" &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.timedOut === "boolean"
  );
}

/**
 * Validate a `Notification`:
 * - `status` is "fixed" or "failed"
 * - `incidentId` is a string
 * - `errorSnippet` is a string
 * - when status === "fixed": `prUrl` is a non-empty string
 * - when status === "failed": `reason` is a non-empty string
 *
 * @param {*} notification
 * @returns {boolean}
 */
function validateNotification(notification) {
  if (!notification || typeof notification !== "object") {
    return false;
  }
  if (notification.status !== "fixed" && notification.status !== "failed") {
    return false;
  }
  if (
    typeof notification.incidentId !== "string" ||
    typeof notification.errorSnippet !== "string"
  ) {
    return false;
  }
  if (notification.status === "fixed") {
    return typeof notification.prUrl === "string" && notification.prUrl.length > 0;
  }
  // status === "failed"
  return typeof notification.reason === "string" && notification.reason.length > 0;
}

module.exports = {
  // Constants
  INCIDENT_ID_PATTERN,
  ERROR_MARKER,
  // Pure helpers
  generateIncidentId,
  parsePayload,
  // Validators
  validateIncident,
  validateKiroResult,
  validateNotification,
};
