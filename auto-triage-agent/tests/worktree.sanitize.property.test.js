/**
 * Property test for incident ID sanitization.
 *
 * Feature: auto-triage-agent, Property 1: Incident ID safety
 *
 * For any string input (including injection payloads), `sanitizeIncidentId`
 * either returns a value matching ^inc-[A-Za-z0-9-]+$ or raises an error — it
 * never returns a value containing path separators, whitespace, or shell
 * metacharacters.
 *
 * Validates: Requirements 3.3, 3.4, 4.3
 */

"use strict";

const fc = require("fast-check");
const {
  sanitizeIncidentId,
  INCIDENT_ID_PATTERN,
} = require("../src/worktreeManager");

/** Characters that must NEVER appear in a returned (accepted) id. */
const UNSAFE_CHARS = /[\s/\\;:$`'"(){}[\]|&<>*?~!#%^,]/;

/** Concrete injection payloads that MUST be rejected. */
const INJECTION_PAYLOADS = [
  "../",
  "../../etc/passwd",
  "inc-../escape",
  "inc-foo/bar",
  "inc-foo\\bar",
  "; rm -rf /",
  "inc-foo; rm -rf /",
  "inc foo",
  "inc-foo bar",
  "$(whoami)",
  "inc-$(whoami)",
  "`reboot`",
  "inc-`reboot`",
  "inc-foo|cat",
  "inc-foo&echo",
  "inc-foo>out",
  "inc-foo\n",
  "inc-foo\t",
  "",
  "inc-",
  "INC-NOPREFIX",
  "notinc-123",
  "inc-héllo",
];

describe("Feature: auto-triage-agent, Property 1: Incident ID safety", () => {
  test("for any string input, output matches the safe pattern or it throws", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.fullUnicodeString(),
          fc.constantFrom(...INJECTION_PAYLOADS),
          // Build plausible-looking ids that may still embed unsafe chars.
          fc
            .tuple(fc.string(), fc.string())
            .map(([a, b]) => `inc-${a}${b}`)
        ),
        (input) => {
          let result;
          let threw = false;
          try {
            result = sanitizeIncidentId(input);
          } catch (err) {
            threw = true;
            expect(err).toBeInstanceOf(Error);
          }

          if (!threw) {
            // Accepted ids MUST match the allowlist and carry no unsafe chars.
            expect(INCIDENT_ID_PATTERN.test(result)).toBe(true);
            expect(UNSAFE_CHARS.test(result)).toBe(false);
            // Acceptance returns the input unchanged.
            expect(result).toBe(input);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  test("all known injection payloads are rejected", () => {
    for (const payload of INJECTION_PAYLOADS) {
      expect(() => sanitizeIncidentId(payload)).toThrow();
    }
  });

  test("well-formed ids are returned unchanged", () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.constantFrom(
              ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split(
                ""
              )
            ),
            { minLength: 1, maxLength: 40 }
          )
          .map((chars) => `inc-${chars.join("")}`),
        (id) => {
          expect(sanitizeIncidentId(id)).toBe(id);
          expect(INCIDENT_ID_PATTERN.test(id)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
