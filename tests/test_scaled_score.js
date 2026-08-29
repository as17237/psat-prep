/**
 * test_scaled_score.js
 * Comprehensive unit test suite for PSAT 8/9 scaled score projection, Wilson score intervals,
 * error bounds, track allow-listing, monotonicity, continuity, and engine agreement.
 * Covers all 16 test cases from SCORE_MODEL_FIX_PROMPT.md.
 */

const assert = require("assert");
const PSAT_ENGINE = require("../srs.js");

console.log("Testing PSAT 8/9 Scaled Score & Precision Confidence Model (16 Test Cases)...");

// Helper to generate mock questions array
function generateMockQuestions(rwCount, mathCount) {
  const qs = [];
  for (let i = 1; i <= rwCount; i++) {
    qs.push({ id: `rw_${i}`, test: "Reading and Writing", domain: "Craft and Structure", difficulty: "Medium" });
  }
  for (let i = 1; i <= mathCount; i++) {
    qs.push({ id: `math_${i}`, test: "Math", domain: "Algebra", difficulty: "Medium" });
  }
  return qs;
}

// ----------------------------------------------------------------------------
// Group 1: Boundaries and Gating (Tests 1–5)
// ----------------------------------------------------------------------------

// Test 1: 0 correct in both sections at n>=15 -> exactly 240, never below.
console.log("▶ Test 1: 0 correct in both sections at n>=15 -> exactly 240 floor");
{
  const questions = generateMockQuestions(30, 30);
  const progress = {};
  for (let i = 1; i <= 30; i++) {
    progress[`rw_${i}`] = { answered: true, isCorrect: false };
    progress[`math_${i}`] = { answered: true, isCorrect: false };
  }
  const res = PSAT_ENGINE.calculateScaledScore(questions, progress);
  assert.strictEqual(res.isReady, true);
  assert.strictEqual(res.rwScore, 120, "0 correct in RW must yield section floor 120");
  assert.strictEqual(res.mathScore, 120, "0 correct in Math must yield section floor 120");
  assert.strictEqual(res.totalScore, 240, "0 correct in both must yield composite floor 240");
  assert.ok(Array.isArray(res.totalRange), "totalRange must be an array");
  assert.strictEqual(res.totalRange[0], 240, "Total range lower bound must never drop below 240");
  assert.ok(res.totalRange[1] >= 240, "Total range upper bound must be >= 240");
}

// Test 2: 100% in both at n>=15 -> exactly 1440, never above.
console.log("▶ Test 2: 100% in both at n>=15 -> exactly 1440 ceiling");
{
  const questions = generateMockQuestions(30, 30);
  const progress = {};
  for (let i = 1; i <= 30; i++) {
    progress[`rw_${i}`] = { answered: true, isCorrect: true };
    progress[`math_${i}`] = { answered: true, isCorrect: true };
  }
  const res = PSAT_ENGINE.calculateScaledScore(questions, progress);
  assert.strictEqual(res.isReady, true);
  assert.strictEqual(res.rwScore, 720, "100% in RW must yield section ceiling 720");
  assert.strictEqual(res.mathScore, 720, "100% in Math must yield section ceiling 720");
  assert.strictEqual(res.totalScore, 1440, "100% in both must yield composite ceiling 1440");
  assert.ok(Array.isArray(res.totalRange), "totalRange must be an array");
  assert.strictEqual(res.totalRange[1], 1440, "Total range upper bound must never exceed 1440");
  assert.ok(res.totalRange[0] <= 1440, "Total range lower bound must be <= 1440");
}

// Test 3: 14/15 and 15/14 attempts -> isReady: false, totalScore: null, and section score null on ungated side.
console.log("▶ Test 3: 14/15 and 15/14 attempts gating check");
{
  const questions = generateMockQuestions(30, 30);
  
  // Case A: 14 RW, 15 Math
  const progA = {};
  for (let i = 1; i <= 14; i++) progA[`rw_${i}`] = { answered: true, isCorrect: true };
  for (let i = 1; i <= 15; i++) progA[`math_${i}`] = { answered: true, isCorrect: true };
  const resA = PSAT_ENGINE.calculateScaledScore(questions, progA);
  assert.strictEqual(resA.isReady, false, "14 RW attempts must not be ready");
  assert.strictEqual(resA.rwReady, false);
  assert.strictEqual(resA.rwScore, null, "Ungated RW side with 14 attempts must be null");
  assert.strictEqual(resA.rwRange, null);
  assert.strictEqual(resA.mathReady, true);
  assert.strictEqual(resA.mathScore, 720);
  assert.strictEqual(resA.totalScore, null, "Total score must be null if either section is not ready");
  assert.strictEqual(resA.totalRange, null);

  // Case B: 15 RW, 14 Math
  const progB = {};
  for (let i = 1; i <= 15; i++) progB[`rw_${i}`] = { answered: true, isCorrect: true };
  for (let i = 1; i <= 14; i++) progB[`math_${i}`] = { answered: true, isCorrect: true };
  const resB = PSAT_ENGINE.calculateScaledScore(questions, progB);
  assert.strictEqual(resB.isReady, false, "14 Math attempts must not be ready");
  assert.strictEqual(resB.rwReady, true);
  assert.strictEqual(resB.rwScore, 720);
  assert.strictEqual(resB.mathReady, false);
  assert.strictEqual(resB.mathScore, null, "Ungated Math side with 14 attempts must be null");
  assert.strictEqual(resB.mathRange, null);
  assert.strictEqual(resB.totalScore, null);
  assert.strictEqual(resB.totalRange, null);
}

// Test 4: Empty progress -> all nulls, no zeros rendered as scores.
console.log("▶ Test 4: Empty progress -> all nulls, no zero scores");
{
  const questions = generateMockQuestions(30, 30);
  const res = PSAT_ENGINE.calculateScaledScore(questions, {});
  assert.strictEqual(res.isReady, false);
  assert.strictEqual(res.rwReady, false);
  assert.strictEqual(res.mathReady, false);
  assert.strictEqual(res.rwScore, null, "rwScore must be null");
  assert.strictEqual(res.mathScore, null, "mathScore must be null");
  assert.strictEqual(res.totalScore, null, "totalScore must be null");
  assert.strictEqual(res.rwRange, null);
  assert.strictEqual(res.mathRange, null);
  assert.strictEqual(res.totalRange, null);
  assert.strictEqual(res.rwRangeFormatted, null);
  assert.strictEqual(res.mathRangeFormatted, null);
  assert.strictEqual(res.totalRangeFormatted, null);
  assert.strictEqual(res.confidenceInterval, null);
  assert.strictEqual(res.totalAttempted, 0);
  assert.strictEqual(res.overallAccuracyPercent, 0);
}

// Test 5: 8-question mini exam -> no scaled score.
console.log("▶ Test 5: 8-question mini exam -> no scaled score projection");
{
  const miniExam = {
    id: "test_mini",
    type: "mini_psat89",
    isAdaptive: false,
    modules: [
      {
        id: "m1",
        section: "Reading and Writing",
        questions: [
          { id: "q1", test: "Reading and Writing", correct_answer: "A" },
          { id: "q2", test: "Reading and Writing", correct_answer: "B" },
          { id: "q3", test: "Reading and Writing", correct_answer: "C" },
          { id: "q4", test: "Reading and Writing", correct_answer: "D" }
        ]
      },
      {
        id: "m2",
        section: "Math",
        questions: [
          { id: "q5", test: "Math", correct_answer: "A" },
          { id: "q6", test: "Math", correct_answer: "B" },
          { id: "q7", test: "Math", correct_answer: "C" },
          { id: "q8", test: "Math", correct_answer: "D" }
        ]
      }
    ]
  };
  const answers = { q1: "A", q2: "B", q3: "C", q4: "D", q5: "A", q6: "B", q7: "C", q8: "D" };
  const report = PSAT_ENGINE.scoreStandardExam(miniExam, answers, {});
  assert.strictEqual(report.scores.isScaledReady, false, "8-question mini exam must not be scaled ready");
  assert.strictEqual(report.scores.totalScaled, null, "Mini exam totalScaled must be null");
  assert.strictEqual(report.scores.rwScaled, null, "Mini exam rwScaled must be null");
  assert.strictEqual(report.scores.mathScaled, null, "Mini exam mathScaled must be null");
  assert.strictEqual(report.scores.totalRange, null, "Mini exam totalRange must be null");
}

// ----------------------------------------------------------------------------
// Group 2: Track Handling & Allow-listing (Tests 6–8)
// ----------------------------------------------------------------------------

// Test 6: Allow-listed tracks return numbers; invalid tracks return null + scoreReliable: false.
console.log("▶ Test 6: Track allow-list enforcement");
{
  // Valid tracks
  assert.strictEqual(typeof PSAT_ENGINE.calculateSectionScaledScore(20, 27, "Standard", false), "number");
  assert.strictEqual(typeof PSAT_ENGINE.calculateSectionScaledScore(20, 27, "Hard", true), "number");
  assert.strictEqual(typeof PSAT_ENGINE.calculateSectionScaledScore(20, 27, "Easy", true), "number");
  assert.strictEqual(typeof PSAT_ENGINE.calculateSectionScaledScore(20, 27, "Baseline", false), "number");

  // Invalid tracks
  const invalidTracks = ["Pending Routing", "typo-Hard", "HARD", 0, {}, null, undefined, ""];
  invalidTracks.forEach(invTrack => {
    const resAdaptive = PSAT_ENGINE.calculateSectionScaledScore(20, 27, invTrack, true);
    assert.strictEqual(resAdaptive, null, `Invalid adaptive track '${invTrack}' must return null`);
  });

  // Verify in scoreStandardExam
  const invalidExam = {
    id: "exam_invalid_track",
    type: "standard_psat89",
    isAdaptive: true,
    routingTracks: { rw: "Pending Routing", math: "Hard" },
    modules: [
      { id: "rw1", section: "Reading and Writing", questions: Array.from({ length: 27 }, (_, i) => ({ id: `irw_${i}`, test: "Reading and Writing", correct_answer: "A" })) },
      { id: "math1", section: "Math", questions: Array.from({ length: 22 }, (_, i) => ({ id: `imath_${i}`, test: "Math", correct_answer: "A" })) }
    ]
  };
  const allAns = {};
  for (let i = 0; i < 27; i++) allAns[`irw_${i}`] = "A";
  for (let i = 0; i < 22; i++) allAns[`imath_${i}`] = "A";
  const reportInv = PSAT_ENGINE.scoreStandardExam(invalidExam, allAns, {});
  assert.strictEqual(reportInv.scores.scoreReliable, false, "Invalid track in adaptive exam must set scoreReliable: false");
  assert.strictEqual(reportInv.scores.totalScaled, null, "Invalid track must yield totalScaled: null");
  assert.strictEqual(reportInv.scores.rwScaled, null, "Invalid track must yield rwScaled: null");
}

// Test 7: Missing routingTracks on adaptive exam does NOT silently score as Hard.
console.log("▶ Test 7: Missing routingTracks on adaptive exam does not default to Hard");
{
  const adaptiveExamNoTracks = {
    id: "exam_no_tracks",
    type: "standard_psat89",
    isAdaptive: true,
    // routingTracks omitted
    modules: [
      { id: "rw1", section: "Reading and Writing", questions: Array.from({ length: 27 }, (_, i) => ({ id: `arw_${i}`, test: "Reading and Writing", correct_answer: "A" })) },
      { id: "math1", section: "Math", questions: Array.from({ length: 22 }, (_, i) => ({ id: `amath_${i}`, test: "Math", correct_answer: "A" })) }
    ]
  };
  const allAns = {};
  for (let i = 0; i < 27; i++) allAns[`arw_${i}`] = "A";
  for (let i = 0; i < 22; i++) allAns[`amath_${i}`] = "A";
  const reportNoTracks = PSAT_ENGINE.scoreStandardExam(adaptiveExamNoTracks, allAns, {});
  assert.strictEqual(reportNoTracks.scores.scoreReliable, false, "Adaptive exam missing routingTracks must have scoreReliable: false");
  assert.strictEqual(reportNoTracks.scores.totalScaled, null, "Adaptive exam missing routingTracks must NOT compute a scaled score");
  assert.strictEqual(reportNoTracks.scores.rwScaled, null);
  assert.strictEqual(reportNoTracks.scores.mathScaled, null);
}

// Test 8: Perfect section never scores below a non-perfect one across all tracks.
console.log("▶ Test 8: Perfect section never scores below non-perfect section on any track");
{
  const tracks = ["Standard", "Hard", "Easy", "Baseline"];
  tracks.forEach(track => {
    const isAdap = (track === "Hard" || track === "Easy");
    for (let total of [27, 54, 22, 44]) {
      const perfectScore = PSAT_ENGINE.calculateSectionScaledScore(total, total, track, isAdap);
      for (let c = 0; c < total; c++) {
        const subScore = PSAT_ENGINE.calculateSectionScaledScore(c, total, track, isAdap);
        assert.ok(perfectScore >= subScore, `Perfect section score (${perfectScore}) on ${track} track must be >= subscore (${subScore}) at ${c}/${total}`);
      }
    }
  });
}

// ----------------------------------------------------------------------------
// Group 3: Monotonicity & Continuity (Tests 9–11)
// ----------------------------------------------------------------------------

// Test 9: For each track, score is non-decreasing as correct goes 0..n.
console.log("▶ Test 9: Monotonic non-decreasing curve across all tracks");
{
  const tracks = ["Standard", "Hard", "Easy", "Baseline"];
  tracks.forEach(track => {
    const isAdap = (track === "Hard" || track === "Easy");
    const total = 54;
    let prev = PSAT_ENGINE.calculateSectionScaledScore(0, total, track, isAdap);
    assert.strictEqual(prev, 120, `0 correct on ${track} track must equal 120 baseline floor`);
    for (let c = 1; c <= total; c++) {
      const curr = PSAT_ENGINE.calculateSectionScaledScore(c, total, track, isAdap);
      assert.ok(curr >= prev, `Score at ${c}/${total} (${curr}) must be >= score at ${c - 1}/${total} (${prev}) for track ${track}`);
      prev = curr;
    }
  });
}

// Test 10: Adding one correct answer never lowers the total score in calculateScaledScore.
console.log("▶ Test 10: Adding one correct answer never lowers the total");
{
  const questions = generateMockQuestions(30, 30);
  for (let rw = 0; rw < 30; rw++) {
    for (let math = 0; math < 30; math++) {
      const progBase = {};
      for (let i = 1; i <= 30; i++) {
        progBase[`rw_${i}`] = { answered: true, isCorrect: i <= rw };
        progBase[`math_${i}`] = { answered: true, isCorrect: i <= math };
      }
      const base = PSAT_ENGINE.calculateScaledScore(questions, progBase);

      // Add 1 to RW
      const progRwPlus = {};
      for (let i = 1; i <= 30; i++) {
        progRwPlus[`rw_${i}`] = { answered: true, isCorrect: i <= (rw + 1) };
        progRwPlus[`math_${i}`] = { answered: true, isCorrect: i <= math };
      }
      const rwPlus = PSAT_ENGINE.calculateScaledScore(questions, progRwPlus);
      assert.ok(rwPlus.totalScore >= base.totalScore, `Adding 1 RW correct at rw=${rw}, math=${math} must not lower total score (${rwPlus.totalScore} vs ${base.totalScore})`);

      // Add 1 to Math
      const progMathPlus = {};
      for (let i = 1; i <= 30; i++) {
        progMathPlus[`rw_${i}`] = { answered: true, isCorrect: i <= rw };
        progMathPlus[`math_${i}`] = { answered: true, isCorrect: i <= (math + 1) };
      }
      const mathPlus = PSAT_ENGINE.calculateScaledScore(questions, progMathPlus);
      assert.ok(mathPlus.totalScore >= base.totalScore, `Adding 1 Math correct at rw=${rw}, math=${math} must not lower total score (${mathPlus.totalScore} vs ${base.totalScore})`);
    }
  }
}

// Test 11: Crossing 0.58 routing threshold by one question - pin current discontinuity.
console.log("▶ Test 11: Pinning MST routing threshold discontinuity");
{
  // 54-question Reading & Writing section (27 in M1, 27 in M2)
  // Threshold is 0.58: 15/27 = 55.56% (<0.58, Easy track), 16/27 = 59.26% (>=0.58, Hard track)
  // At 50% accuracy on M2 (total 27/54 = 50% section accuracy):
  // 27/54 on Easy track: Math.round(120 + (0.5^1.1)*460) = Math.round(120 + 0.466516*460) = 120 + 215 = 335
  // 27/54 on Hard track: Math.round(120 + (0.5^0.85)*600) = Math.round(120 + 0.554785*600) = 120 + 333 = 453
  // Discontinuity difference at 50% ratio = 453 - 335 = 118 points.
  const easyScore50 = PSAT_ENGINE.calculateSectionScaledScore(27, 54, "Easy", true);
  const hardScore50 = PSAT_ENGINE.calculateSectionScaledScore(27, 54, "Hard", true);
  assert.strictEqual(easyScore50, 335, "50% accuracy on Easy track must equal 335");
  assert.strictEqual(hardScore50, 453, "50% accuracy on Hard track must equal 453");
  const delta50 = hardScore50 - easyScore50;
  assert.strictEqual(delta50, 118, "Discontinuity at 50% accuracy must be exactly 118 points");

  // At 30/54 accuracy (~55.56%):
  // Easy: Math.round(120 + ((30/54)^1.1)*460) = 361
  // Hard: Math.round(120 + ((30/54)^0.85)*600) = 484
  const easyScore30 = PSAT_ENGINE.calculateSectionScaledScore(30, 54, "Easy", true);
  const hardScore30 = PSAT_ENGINE.calculateSectionScaledScore(30, 54, "Hard", true);
  assert.strictEqual(easyScore30, 361, "30/54 on Easy track must equal 361");
  assert.strictEqual(hardScore30, 484, "30/54 on Hard track must equal 484");
  assert.strictEqual(hardScore30 - easyScore30, 123, "Discontinuity at 30/54 accuracy must be exactly 123 points");

  // Assert bound: discontinuity across reasonable ratio (0.50 to 0.60) is bounded below 150 points
  assert.ok(delta50 <= 150, "Discontinuity must be bounded <= 150 points");
  assert.ok((hardScore30 - easyScore30) <= 150, "Discontinuity at 30/54 must be bounded <= 150 points");
}

// ----------------------------------------------------------------------------
// Group 4: Engine Agreement (Test 12)
// ----------------------------------------------------------------------------

// Test 12: For the same correct/total, practice projection and exam scorer agree exactly on Standard track.
console.log("▶ Test 12: Scaling engine agreement between practice projection and exam scorer");
{
  const questions = generateMockQuestions(30, 30);
  const prog60 = {};
  for (let i = 1; i <= 30; i++) {
    prog60[`rw_${i}`] = { answered: true, isCorrect: i <= 18 }; // 18/30 = 60%
    prog60[`math_${i}`] = { answered: true, isCorrect: i <= 18 }; // 18/30 = 60%
  }
  const practiceRes = PSAT_ENGINE.calculateScaledScore(questions, prog60);

  // Standard non-adaptive exam with same 18/30 per section
  const standardExam = {
    id: "exam_standard_60",
    type: "standard_psat89",
    isAdaptive: false,
    modules: [
      { id: "rw1", section: "Reading and Writing", questions: questions.filter(q => q.test === "Reading and Writing") },
      { id: "math1", section: "Math", questions: questions.filter(q => q.test === "Math") }
    ]
  };
  const examAnswers = {};
  for (let i = 1; i <= 30; i++) {
    examAnswers[`rw_${i}`] = i <= 18 ? "A" : "WRONG";
    examAnswers[`math_${i}`] = i <= 18 ? "A" : "WRONG";
  }
  // Setup correct answers on modules
  standardExam.modules[0].questions.forEach(q => { q.correct_answer = "A"; });
  standardExam.modules[1].questions.forEach(q => { q.correct_answer = "A"; });

  const examReport = PSAT_ENGINE.scoreStandardExam(standardExam, examAnswers, {});

  assert.strictEqual(practiceRes.rwScore, 480, "Practice projection RW score at 60% must be 480");
  assert.strictEqual(practiceRes.mathScore, 480, "Practice projection Math score at 60% must be 480");
  assert.strictEqual(practiceRes.totalScore, 960, "Practice projection total score at 60% must be 960");

  assert.strictEqual(examReport.scores.rwScaled, 480, "Exam scorer RW score at 60% Standard must be 480");
  assert.strictEqual(examReport.scores.mathScaled, 480, "Exam scorer Math score at 60% Standard must be 480");
  assert.strictEqual(examReport.scores.totalScaled, 960, "Exam scorer total score at 60% Standard must be 960");

  // Verify exact 0 point discrepancy
  assert.strictEqual(practiceRes.totalScore, examReport.scores.totalScaled, "Practice projection and Exam scorer must agree with 0 difference");
}

// ----------------------------------------------------------------------------
// Group 5: Interval Honesty & Wilson Score Properties (Tests 13–15)
// ----------------------------------------------------------------------------

// Test 13: Reported range always contains the point estimate and never exceeds 240–1440.
console.log("▶ Test 13: Range contains point estimate and stays within 240–1440");
{
  const questions = generateMockQuestions(100, 100);
  const sampleSizes = [15, 30, 60, 100];
  const accuracies = [0, 0.10, 0.25, 0.50, 0.75, 0.90, 1.0];

  sampleSizes.forEach(n => {
    accuracies.forEach(acc => {
      const prog = {};
      const k = Math.round(n * acc);
      for (let i = 1; i <= n; i++) {
        prog[`rw_${i}`] = { answered: true, isCorrect: i <= k };
        prog[`math_${i}`] = { answered: true, isCorrect: i <= k };
      }
      const res = PSAT_ENGINE.calculateScaledScore(questions, prog);

      assert.strictEqual(res.isReady, true);
      assert.ok(res.totalRange[0] <= res.totalScore, `totalRange lower bound (${res.totalRange[0]}) must be <= totalScore (${res.totalScore}) at n=${n}, acc=${acc}`);
      assert.ok(res.totalRange[1] >= res.totalScore, `totalRange upper bound (${res.totalRange[1]}) must be >= totalScore (${res.totalScore}) at n=${n}, acc=${acc}`);
      assert.ok(res.totalRange[0] >= 240, `totalRange lower bound (${res.totalRange[0]}) must be >= 240`);
      assert.ok(res.totalRange[1] <= 1440, `totalRange upper bound (${res.totalRange[1]}) must be <= 1440`);

      assert.ok(res.rwRange[0] <= res.rwScore, `rwRange lower bound (${res.rwRange[0]}) must be <= rwScore (${res.rwScore})`);
      assert.ok(res.rwRange[1] >= res.rwScore, `rwRange upper bound (${res.rwRange[1]}) must be >= rwScore (${res.rwScore})`);
      assert.ok(res.rwRange[0] >= 120, `rwRange lower bound (${res.rwRange[0]}) must be >= 120`);
      assert.ok(res.rwRange[1] <= 720, `rwRange upper bound (${res.rwRange[1]}) must be <= 720`);

      assert.ok(res.mathRange[0] <= res.mathScore, `mathRange lower bound (${res.mathRange[0]}) must be <= mathScore (${res.mathScore})`);
      assert.ok(res.mathRange[1] >= res.mathScore, `mathRange upper bound (${res.mathRange[1]}) must be >= mathScore (${res.mathScore})`);
      assert.ok(res.mathRange[0] >= 120, `mathRange lower bound (${res.mathRange[0]}) must be >= 120`);
      assert.ok(res.mathRange[1] <= 720, `mathRange upper bound (${res.mathRange[1]}) must be <= 720`);
    });
  });
}

// Test 14: Range width strictly decreases as attempts increase.
console.log("▶ Test 14: Range width strictly decreases as sample size increases");
{
  const questions = generateMockQuestions(150, 150);
  const sampleSizes = [15, 30, 60, 120];
  const widths = sampleSizes.map(n => {
    const prog = {};
    const k = Math.round(n * 0.60); // 60% accuracy
    for (let i = 1; i <= n; i++) {
      prog[`rw_${i}`] = { answered: true, isCorrect: i <= k };
      prog[`math_${i}`] = { answered: true, isCorrect: i <= k };
    }
    const res = PSAT_ENGINE.calculateScaledScore(questions, prog);
    return res.totalRange[1] - res.totalRange[0];
  });

  for (let i = 0; i < widths.length - 1; i++) {
    assert.ok(
      widths[i] > widths[i + 1],
      `Width at n=${sampleSizes[i]} (${widths[i]}) must be strictly greater than width at n=${sampleSizes[i + 1]} (${widths[i + 1]})`
    );
  }
}

// Test 15: Coverage percentage matches z value actually used (90% CI with z = 1.645).
console.log("▶ Test 15: Coverage percentage matches normal quantile z=1.645");
{
  const questions = generateMockQuestions(50, 50);
  const prog = {};
  for (let i = 1; i <= 30; i++) {
    prog[`rw_${i}`] = { answered: true, isCorrect: true };
    prog[`math_${i}`] = { answered: true, isCorrect: true };
  }
  const res = PSAT_ENGINE.calculateScaledScore(questions, prog);
  assert.strictEqual(res.confidenceInterval, "90% Confidence Interval", "Label must honestly state 90% Confidence Interval");

  // Verify normal approximation asymptotic match at large n
  const wilsonLarge = PSAT_ENGINE.calculateWilsonScoreInterval(500, 1000, PSAT_ENGINE.SCALING_ASSUMPTIONS.CONFIDENCE_Z_90);
  const theoreticalNormalMargin = 1.6448536269514722 * Math.sqrt((0.5 * 0.5) / 1000); // ~0.026007
  assert.ok(Math.abs(wilsonLarge.margin - theoreticalNormalMargin) < 0.001, "Wilson margin must match theoretical normal margin for 90% CI");
}

// ----------------------------------------------------------------------------
// Group 6: Difficulty Mix & Transparent Disclosure (Test 16)
// ----------------------------------------------------------------------------

// Test 16: Students with different difficulty mixes receive score + clear disclosure note.
console.log("▶ Test 16: Transparent disclosure of practice bank difficulty skew");
{
  const questionsHard = [];
  const questionsEasy = [];
  for (let i = 1; i <= 30; i++) {
    questionsHard.push({ id: `q_hard_rw_${i}`, test: "Reading and Writing", difficulty: "Hard" });
    questionsHard.push({ id: `q_hard_math_${i}`, test: "Math", difficulty: "Hard" });
    questionsEasy.push({ id: `q_easy_rw_${i}`, test: "Reading and Writing", difficulty: "Easy" });
    questionsEasy.push({ id: `q_easy_math_${i}`, test: "Math", difficulty: "Easy" });
  }

  const progHard = {};
  const progEasy = {};
  for (let i = 1; i <= 30; i++) {
    progHard[`q_hard_rw_${i}`] = { answered: true, isCorrect: i <= 21 }; // 70%
    progHard[`q_hard_math_${i}`] = { answered: true, isCorrect: i <= 21 }; // 70%
    progEasy[`q_easy_rw_${i}`] = { answered: true, isCorrect: i <= 21 }; // 70%
    progEasy[`q_easy_math_${i}`] = { answered: true, isCorrect: i <= 21 }; // 70%
  }

  const resHard = PSAT_ENGINE.calculateScaledScore(questionsHard, progHard);
  const resEasy = PSAT_ENGINE.calculateScaledScore(questionsEasy, progEasy);

  assert.strictEqual(resHard.totalScore, 1080, "70% raw accuracy must yield 1080 (540 RW + 540 Math)");
  assert.strictEqual(resEasy.totalScore, 1080, "70% raw accuracy must yield 1080 (540 RW + 540 Math)");

  assert.ok(typeof resHard.difficultyDisclosure === "string", "difficultyDisclosure must be present");
  assert.ok(resHard.difficultyDisclosure.includes("harder than a real test form"), "Disclosure must note practice bank difficulty skew");
  assert.ok(resHard.dataBasis.includes("60 Attempts"), "Data basis must report exact attempts");
}

console.log("=======================================================================");
console.log("✓ ALL 16 SCALED SCORE & CONFIDENCE MODEL TESTS PASSED (100% SUCCESS)");
console.log("=======================================================================");
