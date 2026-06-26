/**
 * Property test for Error_Snippet secret-safety.
 *
 * Feature: auto-triage-agent, Property 9: Snippet secret-safety
 *
 * For any incident text and any configured secret values, the errorSnippet is
 * bounded in length (<= MAX_SNIPPET_LENGTH) and contains none of the configured
 * secret values.
 *
 * Validates: Requirements 11.2, 11.3
 */

"use strict";

const fc = require("fast-check");
const { buildErrorSnippet, MAX_SNIPPET_LENGTH } = require("../src/slackNotifier");

describe("Feature: auto-triage-agent, Property 9: Snippet secret-safety", () => {
  test("snippet is length-bounded and free of every configured secret", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 6 }),
        (baseText, secrets) => {
          // Weave the secrets into the text so they genuinely appear in it.
          const woven = secrets.reduce(
            (acc, s, i) => `${acc} ${s} segment-${i} ${s}`,
            baseText
          );

          const snippet = buildErrorSnippet(woven, secrets);

          // Bounded length.
          expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);

          // No configured secret value survives in the snippet.
          for (const secret of secrets) {
            if (secret.length > 0) {
              expect(snippet.includes(secret)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  test("respects a custom maxLength bound for any input", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 50 }), (text, maxLen) => {
        const snippet = buildErrorSnippet(text, [], maxLen);
        expect(snippet.length).toBeLessThanOrEqual(maxLen);
      }),
      { numRuns: 200 }
    );
  });
});
