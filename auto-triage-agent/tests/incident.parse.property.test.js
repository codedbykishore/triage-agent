/**
 * Property test for payload parsing.
 *
 * Feature: auto-triage-agent, Property 3: Payload parsing round-trip
 *
 * For any well-formed payload (containing at least one [ERROR] line),
 * parsePayload(rawBody).rawPayload === rawBody exactly (the original payload is
 * preserved verbatim for error.log).
 *
 * Validates: Requirements 2.1, 2.3, 4.2
 */

"use strict";

const fc = require("fast-check");
const { parsePayload, ERROR_MARKER } = require("../src/incident");

/**
 * Arbitrary that produces a well-formed CloudWatch-style payload: a sequence of
 * arbitrary text lines with at least one line containing the [ERROR] marker
 * inserted at an arbitrary position. Lines avoid newline characters so the
 * structure is controlled by the join, but the resulting payload string is
 * otherwise unconstrained.
 */
function wellFormedPayload() {
  const lineArb = fc.string().map((s) => s.replace(/[\r\n]/g, " "));
  return fc
    .record({
      before: fc.array(lineArb, { maxLength: 10 }),
      errorSuffix: fc.string().map((s) => s.replace(/[\r\n]/g, " ")),
      after: fc.array(lineArb, { maxLength: 10 }),
      newline: fc.constantFrom("\n", "\r\n"),
    })
    .map(({ before, errorSuffix, after, newline }) => {
      const errorLine = `${ERROR_MARKER}${errorSuffix}`;
      return [...before, errorLine, ...after].join(newline);
    });
}

describe("Feature: auto-triage-agent, Property 3: Payload parsing round-trip", () => {
  test("rawPayload equals the original rawBody exactly", () => {
    fc.assert(
      fc.property(wellFormedPayload(), (rawBody) => {
        const incident = parsePayload(rawBody);
        expect(incident.rawPayload).toBe(rawBody);
      }),
      { numRuns: 200 }
    );
  });

  test("the first [ERROR] line becomes errorMessage and contains the marker", () => {
    fc.assert(
      fc.property(wellFormedPayload(), (rawBody) => {
        const incident = parsePayload(rawBody);
        expect(incident.errorMessage).toContain(ERROR_MARKER);
        // errorMessage is the first [ERROR] line of the raw payload.
        const firstErrorLine = rawBody
          .split(/\r?\n/)
          .find((line) => line.includes(ERROR_MARKER));
        expect(incident.errorMessage).toBe(firstErrorLine);
      }),
      { numRuns: 200 }
    );
  });
});
