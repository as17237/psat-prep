/**
 * js/engine/adaptive_config.js — the single source of record for the tunable
 * constants behind adaptive routing, raw→scaled score modelling, and the
 * official test blueprints. WI-16 lifted these three objects OUT of scoring.js
 * (verbatim — same keys, same values) so that every number a student or parent
 * ultimately sees can be traced to one documented place, and so a change to a
 * threshold or curve is a one-file, reviewable diff.
 *
 * PROVENANCE — read before changing any value here:
 *
 *   OFFICIAL_BLUEPRINTS / PSAT_89_SPECS — MEASURED, published.
 *     Section/module counts, per-domain targets and time limits come from the
 *     College Board's published PSAT 8/9 (2026) test specification. These are
 *     real facts about the exam; the `version` strings pin the spec edition.
 *
 *   SCALING_ASSUMPTIONS — MIXED. Two kinds of number live here, and the
 *     difference is the whole point of CLAUDE.md failure mode 1:
 *       • Structural facts (published): SECTION_FLOOR/CEILING 120–720,
 *         TOTAL_FLOOR/CEILING 240–1440 — the real score scale.
 *       • Hand-authored ESTIMATES (NOT published, NOT validated): the power-curve
 *         exponents (HARD_TRACK_EXPONENT, EASY_TRACK_EXPONENT), the lower-track
 *         cap (EASY_TRACK_MAX), and the routing cutoff (ROUTING_THRESHOLD). These
 *         are our modelling choices, flagged `(unvalidated)` inline. Anything the
 *         UI derives from them MUST be labelled an "Estimate" — never "Official",
 *         "Actual", or "Projected". MIN_PER_SECTION=15 is the sample-size gate
 *         below which no score may be shown at all.
 *
 * Consumers get these THROUGH scoring.js (which lists this file in its DEPS and
 * re-exports SCALING_ASSUMPTIONS / OFFICIAL_BLUEPRINTS / PSAT_89_SPECS under the
 * same names), so the frozen PSAT_ENGINE public API is unchanged. Equivalence is
 * pinned by tests/test_adaptive_config.js.
 *
 * Loading: same buildless UMD shape as the other engine parts — `module.exports`
 * under Node, `window.__PSAT_ENGINE_PARTS.adaptive_config` in the browser. It has
 * NO dependencies, so its <script> tag may sit anywhere before scoring.js.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    var parts = root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {};
    parts.adaptive_config = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var SCALING_ASSUMPTIONS = {
    SECTION_FLOOR: 120,
    SECTION_CEILING: 720,
    TOTAL_FLOOR: 240,
    TOTAL_CEILING: 1440,
    MIN_PER_SECTION: 15,
    LOW_SAMPLE_THRESHOLD: 30, // Sample sizes < 30 per section indicate high variance
    HARD_TRACK_EXPONENT: 0.85, // Upper difficulty track power curve (unvalidated)
    EASY_TRACK_EXPONENT: 1.1,  // Lower difficulty track power curve (unvalidated)
    EASY_TRACK_MAX: 580,       // Maximum score cap for lower difficulty track (unvalidated)
    ROUTING_THRESHOLD: 0.58,   // Cutoff proportion to route into upper track (>= 16/27, >= 13/22)
    ALLOWED_TRACKS: ['Standard', 'Hard', 'Easy', 'Baseline'],
    // 90% Confidence Interval z-value for two-tailed normal distribution (alpha = 0.10)
    CONFIDENCE_Z_90: 1.6448536269514722
  };

  /**
   * Official PSAT 8/9 Exam Specifications & Detailed Module Blueprints
   */
  var OFFICIAL_BLUEPRINTS = {
    standard_psat89: {
      version: 'PSAT89_2026_V1',
      sections: {
        'Reading and Writing': {
          moduleCount: 2,
          questionsPerModule: 27,
          timeLimitMinutes: 32,
          domains: {
            'Craft and Structure': { target: 7, min: 6, max: 8 },
            'Information and Ideas': { target: 7, min: 6, max: 8 },
            'Standard English Conventions': { target: 7, min: 6, max: 8 },
            'Expression of Ideas': { target: 6, min: 5, max: 7 }
          }
        },
        'Math': {
          moduleCount: 2,
          questionsPerModule: 22,
          timeLimitMinutes: 35,
          domains: {
            'Algebra': { target: 8, min: 7, max: 9 },
            'Advanced Math': { target: 6, min: 5, max: 7 },
            'Problem Solving and Data Analysis': { target: 5, min: 4, max: 6 },
            'Geometry and Trigonometry': { target: 3, min: 2, max: 4 }
          },
          typeDistribution: {
            multiple_choice: 17,
            free_response: 5
          }
        }
      }
    },
    mini_psat89: {
      version: 'PSAT89_MINI_2026_V1',
      sections: {
        'Reading and Writing': {
          questionsPerModule: 4,
          timeLimitMinutes: 5,
          domains: {
            'Craft and Structure': 1,
            'Information and Ideas': 1,
            'Standard English Conventions': 1,
            'Expression of Ideas': 1
          }
        },
        'Math': {
          questionsPerModule: 4,
          timeLimitMinutes: 5,
          domains: {
            'Algebra': 1,
            'Advanced Math': 1,
            'Problem Solving and Data Analysis': 1,
            'Geometry and Trigonometry': 1
          },
          typeDistribution: {
            multiple_choice: 3,
            free_response: 1
          }
        }
      }
    }
  };

  var PSAT_89_SPECS = {
    totalQuestions: 98,
    totalTimeMinutes: 134, // 2 hours 14 minutes
    breakMinutes: 10,
    sections: {
      readingAndWriting: {
        name: 'Reading and Writing',
        totalQuestions: 54,
        totalMinutes: 64,
        modules: [
          { id: 'rw_m1', name: 'Reading and Writing — Module 1', questionsCount: 27, timeLimitSeconds: 32 * 60 },
          { id: 'rw_m2', name: 'Reading and Writing — Module 2', questionsCount: 27, timeLimitSeconds: 32 * 60 }
        ]
      },
      math: {
        name: 'Math',
        totalQuestions: 44,
        totalMinutes: 70,
        modules: [
          { id: 'math_m1', name: 'Math — Module 1', questionsCount: 22, timeLimitSeconds: 35 * 60 },
          { id: 'math_m2', name: 'Math — Module 2', questionsCount: 22, timeLimitSeconds: 35 * 60 }
        ]
      }
    }
  };

  return {
    SCALING_ASSUMPTIONS: SCALING_ASSUMPTIONS,
    OFFICIAL_BLUEPRINTS: OFFICIAL_BLUEPRINTS,
    PSAT_89_SPECS: PSAT_89_SPECS
  };
});
