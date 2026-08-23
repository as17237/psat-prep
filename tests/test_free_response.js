const assert = require('assert');
const PSAT_ENGINE = require('../srs.js');

console.log('Testing Free-Response Grading...');

// 1. Fractions and decimals equivalence
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('0.2', '.2, 1/5'), true, '0.2 should match .2, 1/5');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('1/5', '.2, 1/5'), true, '1/5 should match .2, 1/5');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('.2', '.2, 1/5'), true, '.2 should match .2, 1/5');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('0.200', '.2, 1/5'), true, '0.200 should match .2, 1/5');

// 2. Fractions like 5/2 vs 2.5
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('2.5', '5/2, 2.5'), true, '2.5 should match 5/2, 2.5');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('5/2', '2.5'), true, '5/2 should match 2.5 numerically');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('2.5', '5/2'), true, '2.5 should match 5/2 numerically');

// 3. Repeating decimals and rounded forms: 14.66, 14.67, 44/3
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('14.6667', '14.66, 14.67, 44/3'), true, '14.6667 should match 44/3');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('44/3', '14.66, 14.67, 44/3'), true, '44/3 should match 14.66, 14.67, 44/3');

// 4. Negative values and fractions: -49/150, -.3266
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('-0.3267', '-.3266, -.3267, -49/150'), true, '-0.3267 should match');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('-49/150', '-.3266, -.3267, -49/150'), true, '-49/150 should match');

// 5. Prose Keys (either X or Y) - Questions 67c08ea4 & 7d0fa86a
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('8', 'either 8 or 9'), true, "8 should match 'either 8 or 9'");
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('9', 'either 8 or 9'), true, "9 should match 'either 8 or 9'");
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('2', 'either 2 or 8'), true, "2 should match 'either 2 or 8'");
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('8', 'either 2 or 8'), true, "8 should match 'either 2 or 8'");
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('7', 'either 8 or 9'), false, "7 should NOT match 'either 8 or 9'");

// 6. False cases
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('0.3', '.2, 1/5'), false, '0.3 should NOT match .2, 1/5');
assert.strictEqual(PSAT_ENGINE.gradeFreeResponse('5/3', '5/2'), false, '5/3 should NOT match 5/2');

// 7. Formatting helper
assert.strictEqual(PSAT_ENGINE.formatAcceptedAnswers('.2, 1/5'), '.2 or 1/5');
assert.strictEqual(PSAT_ENGINE.formatAcceptedAnswers('14.66, 14.67, 44/3'), '14.66, 14.67, or 44/3');
assert.strictEqual(PSAT_ENGINE.formatAcceptedAnswers('either 8 or 9'), '8 or 9');

console.log('✓ All Free-Response Grading tests passed!');
