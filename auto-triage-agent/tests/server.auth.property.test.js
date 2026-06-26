/**
 * Property test for webhook authentication.
 *
 * Feature: auto-triage-agent, Property 4: Authentication soundness
 *
 * For any request, `authenticate` returns true if and only if the provided
 * signature equals the HMAC of the raw body under the configured secret; any
 * tampered body or missing/incorrect signature returns false.
 *
 * Validates: Requirements 1.3, 1.4, 1.5
 */

"use strict";

const fc = require("fast-check");
const { authenticate, computeSignature, SIGNATURE_HEADER } = require("../src/server");

describe("Feature: auto-triage-agent, Property 4: Authentication soundness", () => {
  test("a correctly signed body authenticates", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        (rawBody, secret) => {
          const signature = computeSignature(rawBody, secret);
          const headers = { [SIGNATURE_HEADER]: signature };
          expect(authenticate(headers, rawBody, secret)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  test("a tampered body fails authentication", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (rawBody, secret, suffix) => {
          const signature = computeSignature(rawBody, secret);
          const headers = { [SIGNATURE_HEADER]: signature };
          const tampered = rawBody + suffix; // guaranteed different bytes
          expect(authenticate(headers, tampered, secret)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  test("a missing signature header fails authentication", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (rawBody, secret) => {
        expect(authenticate({}, rawBody, secret)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  test("an incorrect signature fails authentication", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        // a fresh random hex signature that is overwhelmingly unlikely to match
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (rawBody, secret, wrongSignature) => {
          const expected = computeSignature(rawBody, secret);
          fc.pre(wrongSignature !== expected);
          const headers = { [SIGNATURE_HEADER]: wrongSignature };
          expect(authenticate(headers, rawBody, secret)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  test("returns true iff the provided signature equals the expected HMAC", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        // bias the candidate toward the real signature half the time so both
        // sides of the iff are exercised
        fc.oneof(fc.string(), fc.constant("__USE_EXPECTED__")),
        (rawBody, secret, candidateSeed) => {
          const expected = computeSignature(rawBody, secret);
          const candidate =
            candidateSeed === "__USE_EXPECTED__" ? expected : candidateSeed;
          const headers = { [SIGNATURE_HEADER]: candidate };
          const result = authenticate(headers, rawBody, secret);
          expect(result).toBe(candidate === expected);
        }
      ),
      { numRuns: 200 }
    );
  });
});
