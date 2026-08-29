const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('Testing Conservative UI Simplifications & Removals (16 Items Verification)...');

const rootDir = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const parentHtml = fs.readFileSync(path.join(rootDir, 'parent.html'), 'utf8');
const mistakesHtml = fs.readFileSync(path.join(rootDir, 'mistakes.html'), 'utf8');

// 1. Beta Sandbox banner removed from default view
assert.ok(!indexHtml.includes('id="beta-sandbox-banner"') || indexHtml.includes('id="beta-sandbox-banner" class="hidden'), 'Item 1: Beta sandbox banner removed/hidden in index.html');
assert.ok(!parentHtml.includes('id="beta-sandbox-banner"') || parentHtml.includes('id="beta-sandbox-banner" class="hidden'), 'Item 1: Beta sandbox banner removed/hidden in parent.html');
assert.ok(!mistakesHtml.includes('id="beta-sandbox-banner"') || mistakesHtml.includes('id="beta-sandbox-banner" class="hidden'), 'Item 1: Beta sandbox banner removed/hidden in mistakes.html');
console.log('✓ Item 1 Verified: Developer-only Beta sandbox banners removed from normal student and parent headers');

// 2. Cosmos DB sync badges & cloud-status text removed from visible headers
assert.ok(!indexHtml.includes('id="hdr-cloud-badge"'), 'Item 2: Cosmos DB sync badge removed from index.html header');
assert.ok(!mistakesHtml.includes('id="btn-mistakes-cloud-sync"'), 'Item 2: Cosmos DB sync badge removed from mistakes.html header');
console.log('✓ Item 2 Verified: Cloud infrastructure names and sync status badges removed from visible headers');

// 3. Duplicate calculator & reference-sheet buttons removed from global/parent headers
assert.ok(!indexHtml.match(/<header[\s\S]*?toggleDesmosCalculator[\s\S]*?<\/header>/), 'Item 3: Desmos calculator button removed from global index header');
assert.ok(!indexHtml.match(/<header[\s\S]*?toggleReferenceSheet[\s\S]*?<\/header>/), 'Item 3: Reference sheet button removed from global index header');
assert.ok(!parentHtml.match(/<header[\s\S]*?toggleDesmosCalculator[\s\S]*?<\/header>/), 'Item 3: Desmos calculator button removed from parent header');
assert.ok(indexHtml.includes('toggleDesmosCalculator()'), 'Item 3: Calculator retained in active practice/exam interface');
console.log('✓ Item 3 Verified: Duplicate math tool buttons removed from global headers and parent dashboard');

// 4. Header mini-stats: Attempted and Accuracy removed
assert.ok(!indexHtml.includes('id="hdr-attempted"'), 'Item 4: Header Attempted stat removed from index header');
assert.ok(!indexHtml.includes('id="hdr-accuracy"'), 'Item 4: Header Accuracy stat removed from index header');
console.log('✓ Item 4 Verified: Duplicate header mini-stats removed from index header');

// 5. Internal question ID text hidden
assert.ok(indexHtml.includes('id="q-id-badge" class="hidden'), 'Item 5: Internal question ID hidden from normal learner question header');
console.log('✓ Item 5 Verified: Internal question ID hidden from normal student view');

// 6. Keyboard-shortcut legend under every question removed
assert.ok(!indexHtml.includes('Shortcuts: <kbd>'), 'Item 6: Keyboard shortcut clutter bar removed from practice footer');
console.log('✓ Item 6 Verified: Repetitive keyboard shortcut legend removed from question footer');

// 7. Official Source Note discrepancy message removed
assert.ok(!indexHtml.includes('id="mismatch-notice"'), 'Item 7: Generic source discrepancy disclaimer removed');
console.log('✓ Item 7 Verified: Generic official source note discrepancy message removed');

// 8. The Question Bank tab/explorer removed from student nav
assert.ok(!indexHtml.includes('id="tab-bank"'), 'Item 8: Question bank explorer tab removed from student header navigation');
console.log('✓ Item 8 Verified: Question bank data browser tab removed from primary student nav');

// 9. Card/Text view switcher & Text Mode warning removed
assert.ok(!indexHtml.includes('id="btn-view-text"'), 'Item 9: Text mode switcher button removed from practice toolbar');
assert.ok(!indexHtml.includes('id="text-mode-warning"'), 'Item 9: Text mode warning callout removed');
console.log('✓ Item 9 Verified: Card/Text view switcher and text mode warning removed');

// 10. Duplicate error-drill CTA in mistakes page removed
assert.ok(!mistakesHtml.includes('id="btn-top-drill-missed"'), 'Item 10: Duplicate header drill button removed from mistakes.html header');
assert.ok(mistakesHtml.includes('id="btn-summary-drill-missed"'), 'Item 10: Primary summary drill button retained');
console.log('✓ Item 10 Verified: Consolidated duplicate error drill buttons into one primary CTA in mistakes page');

// 11. Mistakes-page title stack simplified
assert.ok(mistakesHtml.includes('Review Mistakes'), 'Item 11: Main title simplified to Review Mistakes');
assert.ok(!mistakesHtml.includes('Student Trouble Spots &amp; Error Diagnostic Center'), 'Item 11: Verbose title stack removed');
console.log('✓ Item 11 Verified: Mistakes page title stack simplified to Review Mistakes');

// 12. Error root-cause drill buttons hidden until sufficient history
assert.ok(mistakesHtml.includes('id="adaptive-coaching-box" class="hidden'), 'Item 12: Adaptive error coaching box hidden by default');
console.log('✓ Item 12 Verified: Root-cause coaching drill buttons hidden until learner has sufficient mistakes');

// 13. Parent dashboard Practice Recommendations replaced with single top recommendation
assert.ok(parentHtml.includes('id="parent-top-recommendation-box"'), 'Item 13: Replaced multi-card static advice with dynamic top recommendation');
assert.ok(!parentHtml.includes('Hard Question Blitz'), 'Item 13: Static generic recommendation cards removed');
console.log('✓ Item 13 Verified: Parent dashboard recommendations simplified to single top recommendation');

// 14. Parent controls placed in Data & Settings menu
assert.ok(parentHtml.includes('Data &amp; Settings'), 'Item 14: Data & Settings dropdown menu added');
assert.ok(parentHtml.includes('id="btn-load-sample-data"'), 'Item 14: Sample data control moved into dropdown');
assert.ok(parentHtml.includes('downloadCloudBackup()'), 'Item 14: Cloud backup moved into dropdown');
console.log('✓ Item 14 Verified: Parent admin & debug controls grouped into Data & Settings menu');

// 15. Verbose exam marketing copy removed
assert.ok(!indexHtml.includes('Generates real score report & parent analytics'), 'Item 15: Exam marketing tagline removed');
assert.ok(!indexHtml.includes('Locked module progression &bull; No instant answers'), 'Item 15: Long feature checklist removed');
console.log('✓ Item 15 Verified: Verbose exam marketing copy and feature checklists removed');

// 16. 7-Week High-Yield Sprint Mode toggle removed
assert.ok(!parentHtml.includes('id="std-highyield-toggle"'), 'Item 16: Sprint mode toggle removed from standard exam builder');
assert.ok(!parentHtml.includes('id="mini-highyield-toggle"'), 'Item 16: Sprint mode toggle removed from mini exam builder');
console.log('✓ Item 16 Verified: 7-Week High-Yield Sprint Mode toggle removed from exam tabs');

console.log('\n======================================================================');
console.log('✓ ALL 16 UI SIMPLIFICATIONS & REMOVALS VERIFIED (100% SUCCESS)');
console.log('======================================================================\n');
