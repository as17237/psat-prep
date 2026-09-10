const {test,expect,seedEmpty}=require('./fixtures');
const { intercept, state } = require('./synthetic_sync');
async function queuePractice(page){
 await page.locator('#options-container button').first().click({force:true});
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('psat_sync_outbox')||'[]').length)).toBe(1);
}

for (const target of ['parent','mistakes']) test(target+' uploads pending changes on arrival',async({page,context})=>{
 const s=state();await intercept(page,context,s);await page.goto('/index.html');await seedEmpty(page);await expect.poll(()=>page.evaluate(()=>window.__coordState().status)).toBe('synced');
 const id=await page.evaluate(()=>{const id=QUESTIONS_DATA[0].id;safeSetStorage('psat_progress',{[id]:{answered:true,isCorrect:false,timestamp:Date.now(),isFlagged:true}});return id;});
 const before=s.posts.length;await page.goto('/'+target+'.html');await expect.poll(()=>!!s.cloud.progress[id]).toBe(true);await expect.poll(()=>page.evaluate(()=>localStorage.getItem('psat_pending_sync_count'))).toBe('0');
 const r=await page.evaluate(({id,target})=>({local:JSON.parse(localStorage.getItem('psat_progress'))[id].isFlagged,badge:document.querySelector(target==='parent'?'#cloud-sync-status-text':'#mistakes-sync-status-text')?.textContent ?? null}),{id,target});
 console.log('DOWNLOAD_DIRTY',JSON.stringify({target,...r,serverHasQuestion:!!s.cloud.progress[id],posts:s.posts.length-before}));expect(r.local).toBe(true);expect(s.cloud.progress[id].isFlagged).toBe(true);expect(s.posts.length).toBeGreaterThan(before);
});
for (const source of ['practice', 'exam']) test('an offline '+source+' answer preserves bookmark removal',async({page,context})=>{
 const s=state();await intercept(page,context,s);await page.goto('/index.html');await seedEmpty(page);page.on('dialog',d=>d.accept());await expect.poll(()=>page.evaluate(()=>window.__coordState().status)).toBe('synced');
 await page.click('#btn-flag',{force:true});const id=await page.evaluate(()=>QUESTIONS_DATA[0].id);await expect.poll(()=>s.cloud.progress[id]?.isFlagged).toBe(true);await expect.poll(()=>page.evaluate(()=>window.__coordState().status)).toBe('synced');
 s.connected=false;await page.click('#btn-flag',{force:true});
 if (source === 'practice') await queuePractice(page);
 else await page.evaluate(id => {
  startCustomTestDirect({id:'bookmark-exam',type:'focused_custom_test',title:'Bookmark review',questions:[QUESTIONS_DATA.find(q=>q.id===id)],timeLimitMinutes:2});
  selectExamMcqChoice('A');showModuleReviewScreen();submitCurrentExamModule();
 }, id);
 const before=await page.evaluate(id=>JSON.parse(localStorage.getItem('psat_progress'))[id],id);expect(before.isFlagged).toBe(false);expect(before.flagUpdatedAt).toBeGreaterThan(0);
 s.connected=true;await page.click('#btn-cloud-sync',{force:true});await expect.poll(()=>page.evaluate(()=>window.__coordState().status)).toBe('synced');
 const after=await page.evaluate(id=>JSON.parse(localStorage.getItem('psat_progress'))[id],id);console.log('FLAG_AFTER_ANSWER',JSON.stringify({beforeFlag:before.isFlagged,beforeRevision:before.flagUpdatedAt??null,afterFlag:after.isFlagged,serverFlag:s.cloud.progress[id].isFlagged}));expect(after.isFlagged).toBe(false);expect(s.cloud.progress[id].isFlagged).toBe(false);
});
test('mistakes error tag reaches the server after a rejected upload',async({page,context})=>{
 const s=state();await intercept(page,context,s);await page.goto('/index.html');await seedEmpty(page);await queuePractice(page);await expect.poll(()=>Object.keys(s.cloud.progress).length).toBe(1);await expect.poll(()=>page.evaluate(()=>window.__coordState().status)).toBe('synced');const id=Object.keys(s.cloud.progress)[0];await page.goto('/mistakes.html');await page.waitForTimeout(300);
 s.failPost=true;const initial=s.posts.length;await page.evaluate(id=>setMistakeErrorTag(id,'concept_gap'),id);await expect.poll(()=>s.posts.length).toBeGreaterThan(initial);s.failPost=false;
 await expect.poll(()=>s.cloud.progress[id].errorTag,{timeout:12000}).toBe('concept_gap');
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('psat_pending_sync_count'))).toBe('0');
 expect(s.posts.length).toBeGreaterThan(initial+1);
});
test('paused focused report and next exam metadata',async({page,context})=>{
 const s=state();await intercept(page,context,s);await page.goto('/index.html');await seedEmpty(page);page.on('dialog',d=>d.accept());
 await page.evaluate(()=>{const qs=['Reading and Writing','Math'].flatMap(t=>QUESTIONS_DATA.filter(q=>q.test===t&&q.type==='multiple_choice').slice(0,15));startCustomTestDirect({id:'review30',type:'focused_custom_test',title:'Thirty-question review',questions:qs,timeLimitMinutes:30});});
 await page.click('#btn-pause-exam',{force:true});await page.waitForTimeout(300);await page.click('#exam-paused-overlay button',{force:true});
 await page.evaluate(()=>{const saved=JSON.parse(localStorage.getItem('psat_active_exam_state'));const ids=saved.activeExamMeta.modules[0].questionIds;ids.forEach((id,i)=>{loadExamQuestion(i);selectExamMcqChoice(QUESTIONS_DATA.find(q=>q.id===id).correct_answer);});showModuleReviewScreen();submitCurrentExamModule();});
 await expect(page.locator('#exam-report')).toBeVisible();const student=await page.locator('#report-total-score').innerText();const report=await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_exam_history'))[0]);
 console.log('PAUSED_REPORT',JSON.stringify({student,questions:report.totalQuestions,correct:report.totalCorrect,pauseCount:report.pauseCount??report.examPauseCount??null,totalPausedMs:report.totalPausedMs??null}));expect(report.totalQuestions).toBe(30);expect(report.totalCorrect).toBe(30);expect(report.totalPausedMs).toBeGreaterThan(0);expect(report.pauseCount).toBe(1);expect(report.shortTestEstimate.isScored).toBe(true);await expect(page.locator('#report-pause-note')).toContainText('Paused 1 time');
 await page.evaluate(()=>startMiniExam());const next=await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')));console.log('NEXT_EXAM_PAUSE',JSON.stringify({count:next.examPauseCount,totalPausedMs:next.totalPausedMs}));expect(next.examPauseCount).toBe(0);expect(next.totalPausedMs).toBe(0);
 await page.goto('/parent.html');await page.evaluate(()=>openParentExamReview('review30'));const parent=await page.locator('#pmod-exam-score').innerText();console.log('REPORT_PARITY',JSON.stringify({student,parent}));expect(parent).toContain(student);await expect(page.locator('#pmod-exam-estimate-note')).toContainText('Estimated from this test alone');await expect(page.locator('#pmod-exam-pause-note')).toContainText('Paused 1 time');
});
