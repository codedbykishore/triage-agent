/**
 * Property test for incident ID generation.
 *
 * Feature: auto-triage-agent, Property 2: Incident ID uniqueness
 *
 * For any sequence of generateIncidentId calls with distinct time/entropy
 * inputs, all generated IDs are distinct, and each matches ^inc-[A-Za-z0-9-]+$.
 *
 * Validates: Requirements 3.1, 3.2
 */

"use strict";

const fc = require("fast-check");
const {
  generateIncidentId,
  INCIDENT_ID_PATTERN,
} = require("../src/incident");

describe("Feature: auto-triage-agent, Property 2: Incident ID uniqueness", () => {
  test("all generated IDs are distinct and well-formed across distinct time inputs", () => {
    fc.assert(
      fc.property(
        // A set of distinct timestamps; fast-check's uniqueArray guarantees
        // distinct time inputs feeding the generator.
        fc.uniqueArray(fc.integer({ min: 0, max: 4_000_000_000_000 }), {
          minLength: 1,
          maxLength: 200,
        }),
        (timestamps) => {
          const ids = timestamps.map((t) => generateIncidentId(t));

          // Every id matches the injection-safe pattern.
          for (const id of ids) {
            expect(INCIDENT_ID_PATTERN.test(id)).toBe(true);
          }

          // All ids are distinct.
          expect(new Set(ids).size).toBe(ids.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  test("IDs minted within the same millisecond are still distinct via entropy", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 2, max: 100 }),
        (fixedTime, count) => {
          const ids = Array.from({ length: count }, () =>
            generateIncidentId(fixedTime)
          );

          for (const id of ids) {
            expect(INCIDENT_ID_PATTERN.test(id)).toBe(true);
          }
          expect(new Set(ids).size).toBe(ids.length);
        }
      ),
      { numRuns: 200 }
    );
  });
});
