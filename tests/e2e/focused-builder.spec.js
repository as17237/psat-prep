const {test,expect,seedEmpty,seedAnalyticsProfile}=require('./fixtures');

test('parent selects Craft and Structure and launches exactly 7 untimed questions',async({page})=>{
  await page.goto('/parent.html');await seedEmpty(page);await page.click('#ptab-builder');
  await page.selectOption('#builder-subject','Reading and Writing');
  await page.getByLabel('Craft and Structure',{exact:true}).check();await page.fill('#builder-count','7');
  await expect(page.locator('#builder-preview')).toContainText('7 questions');
  await page.click('#builder-start');await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 7');
  const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')));
  expect(state.activeExamMeta.isUntimed).toBe(true);
  expect(state.activeExamMeta.modules[0].questionIds).toHaveLength(7);
  const domains=await page.evaluate(ids=>window.QUESTIONS_DATA.filter(q=>ids.includes(q.id)).map(q=>q.domain),state.activeExamMeta.modules[0].questionIds);
  expect([...new Set(domains)]).toEqual(['Craft and Structure']);
  page.on('dialog',d=>d.accept());await page.evaluate(()=>{showModuleReviewScreen();submitCurrentExamModule();});
  await expect(page.locator('#exam-report')).toBeVisible();
  const history=await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history')));
  expect(history).toHaveLength(1);expect(history[0].customPlan.actualCount).toBe(7);expect(history[0].scores.totalScaled).toBeNull();
  expect(page.__pageErrors).toEqual([]);
});

test('time sizing, honest empty filters and suggested gaps preserve progress',async({page})=>{
  await page.goto('/parent.html');await seedAnalyticsProfile(page);await page.click('#ptab-builder');
  const before=await page.evaluate(()=>localStorage.getItem('psat_progress'));
  await page.click('#builder-suggest');await expect(page.locator('#builder-selection')).toContainText('Words in Context');
  await page.locator('[data-minutes="15"]').click();await page.fill('#builder-review','3');await page.selectOption('#builder-timing','timed');
  await expect(page.locator('#builder-preview')).toContainText('12');
  await page.selectOption('#builder-subject','Reading and Writing');
  await page.locator('#focused-test-builder > details').locator('summary').click();
  await page.selectOption('#builder-format','spr');await expect(page.locator('#builder-start')).toBeDisabled();
  expect(await page.evaluate(()=>localStorage.getItem('psat_progress'))).toBe(before);
  expect(page.__pageErrors).toEqual([]);
});

test('an unknown domain in a setup link cannot silently widen to every topic',async({page})=>{
  const request={subjects:['Reading and Writing'],domains:['does not exist'],sizeMode:'count',requestedCount:7,timingMode:'untimed'};
  await page.goto('/index.html?mode=focused_setup&setup='+encodeURIComponent(JSON.stringify(request)));
  await expect(page.locator('#builder-start')).toBeDisabled();
  expect(await page.evaluate(()=>localStorage.getItem('psat_active_exam_state'))).toBeNull();
});

test('expired module is retained and locked on resume',async({page})=>{
  await page.goto('/index.html');await seedEmpty(page);page.on('dialog',d=>d.accept());
  await page.click('#tab-exam');await page.locator('button:has-text("Start Mini Exam")').click();
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('psat_active_exam_state'));s.examModuleDeadline=Date.now()-1000;localStorage.setItem('psat_active_exam_state',JSON.stringify(s));});
  // Navigate without beforeunload saving the currently live deadline over this fixture.
  await page.evaluate(()=>{document.getElementById('exam-active').classList.add('hidden');});
  await page.reload();await page.click('#tab-exam');await expect(page.locator('#resume-exam-details')).toContainText('Time expired');
  await page.locator('#exam-resume-banner button:has-text("Resume Test")').click();await expect(page.locator('#exam-module-review')).toBeVisible();
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')).examUserAnswers);
  await page.evaluate(()=>selectExamMcqChoice('A'));
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')).examUserAnswers)).toEqual(before);
});

test('reload during break preserves submitted lock and resumes next module',async({page})=>{
  await page.goto('/index.html');await seedEmpty(page);page.on('dialog',d=>d.accept());
  await page.click('#tab-exam');await page.locator('button:has-text("Start Mini Exam")').click();
  await page.evaluate(()=>{showModuleReviewScreen();submitCurrentExamModule();});await expect(page.locator('#exam-break')).toBeVisible();
  await page.reload();await page.click('#tab-exam');await page.locator('#exam-resume-banner button:has-text("Resume Test")').click();await expect(page.locator('#exam-break')).toBeVisible();
  await page.locator('#exam-break button:has-text("Resume Exam Early")').click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')).currentModuleIndex)).toBe(1);
  expect(page.__pageErrors).toEqual([]);
});

test('failed report write is recoverable and retry never regrades',async({page})=>{
  await page.goto('/parent.html');await seedEmpty(page);await page.click('#ptab-builder');await page.selectOption('#builder-subject','Reading and Writing');await page.fill('#builder-count','1');await page.click('#builder-start');
  await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 1');page.on('dialog',d=>d.accept());
  await page.locator('#exam-mcq-options button').first().click({force:true});
  await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k==='psat_exam_history')throw new DOMException('Injected full storage','QuotaExceededError');return original.call(this,k,v);};showModuleReviewScreen();submitCurrentExamModule();});
  await expect(page.locator('#save-recovery-panel')).toBeVisible();
  expect(await page.evaluate(()=>!!localStorage.getItem('psat_pending_write'))).toBe(true);
  await page.evaluate(()=>window.restoreStorage());await page.click('#retry-pending-save');await page.waitForLoadState('domcontentloaded');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history')||'[]').length)).toBe(1);
  const values=await page.evaluate(()=>({p:JSON.parse(localStorage.getItem('psat_progress')),journal:localStorage.getItem('psat_pending_write')}));
  expect(Object.values(values.p)[0].timesSeen).toBe(1);expect(values.journal).toBeNull();
  await page.reload();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history')).length)).toBe(1);
  expect(page.__pageErrors).toEqual([]);
});

test('import has a true Cancel and merge preserves more than 15 existing reports',async({page})=>{
  await page.goto('/parent.html');await seedEmpty(page);await page.evaluate(()=>localStorage.setItem('psat_exam_history',JSON.stringify(Array.from({length:21},(_,i)=>({examId:'old_'+i,completedAt:1700000000000+i,moduleReports:[],totalQuestions:0,totalCorrect:0})))));
  await page.reload();await page.click('#ptab-data');
  const before=await page.evaluate(()=>localStorage.getItem('psat_exam_history'));
  const file={name:'profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({progress:{},srsState:{},sessionsState:{},examHistory:[{examId:'imported',completedAt:1700000000100,moduleReports:[],totalQuestions:0,totalCorrect:0}]}))};
  await page.locator('input[type=file]').setInputFiles(file);await expect(page.locator('dialog')).toBeVisible();await page.click('#import-cancel');
  expect(await page.evaluate(()=>localStorage.getItem('psat_exam_history'))).toBe(before);
  await page.locator('input[type=file]').setInputFiles(file);await page.click('#import-apply');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history')).length)).toBe(22);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history')).some(h=>h.examId==='old_0'))).toBe(true);
  expect(page.__pageErrors).toEqual([]);
});

test('a failed initial journal write offers a recovery download and retries the same answer',async({page})=>{
  await page.goto('/index.html');await seedEmpty(page);
  await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k==='psat_pending_write')throw new DOMException('Injected full storage','QuotaExceededError');return original.call(this,k,v);};});
  await page.locator('#options-container button').first().click({force:true});await expect(page.locator('#save-recovery-panel')).toBeVisible();
  const download=page.waitForEvent('download');await page.click('#download-pending-save');expect((await download).suggestedFilename()).toContain('psat-save-recovery');
  expect(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('psat_progress')||'{}')).length)).toBe(0);
  await page.evaluate(()=>window.restoreStorage());await page.click('#retry-pending-save');
  await expect.poll(()=>page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('psat_progress')||'{}'))[0]?.timesSeen)).toBe(1);
  expect(page.__pageErrors).toEqual([]);
});
