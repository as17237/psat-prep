const {test,expect,seedAnalyticsProfile}=require('./fixtures');

test('shortage needs explicit acceptance and beta handoff preserves production state',async({page})=>{
  const request={subjects:['Math'],skills:['Right triangles and trigonometry'],sizeMode:'count',requestedCount:100,timingMode:'untimed'};
  await page.goto('/index.html?env=beta&mode=focused_setup&setup='+encodeURIComponent(JSON.stringify(request)));
  await page.evaluate(()=>localStorage.setItem('psat_progress',JSON.stringify({production_sentinel:{answered:true,isCorrect:true,timestamp:100}})));
  await expect(page.locator('#builder-preview')).toContainText('34');await expect(page.locator('#builder-start')).toBeDisabled();
  await page.check('#builder-shortage');await page.click('#builder-start');await expect(page.locator('#exam-active-q-pos')).toHaveText('Question 1 of 34');
  const state=await page.evaluate(()=>({prod:JSON.parse(localStorage.getItem('psat_progress')),exam:JSON.parse(localStorage.getItem('beta_psat_active_exam_state')),prodExam:localStorage.getItem('psat_active_exam_state')}));
  expect(state.prod.production_sentinel.timestamp).toBe(100);expect(state.prodExam).toBeNull();expect(state.exam.activeExamMeta.modules[0].questionIds).toHaveLength(34);
  expect(page.__pageErrors).toEqual([]);
});

test('visible suggested focus cards fit the viewport and cannot replace an unfinished test',async({page},testInfo)=>{
  await page.goto('/parent.html');await seedAnalyticsProfile(page);await page.click('#ptab-builder');
  await page.selectOption('#builder-subject','Reading and Writing');await page.click('#builder-suggest');
  await page.locator('#focused-test-builder').scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('focused-builder.png'),fullPage:true});
  const bounds=await page.locator('#focused-test-builder').boundingBox();expect(bounds.width).toBeLessThanOrEqual(testInfo.project.use.viewport.width);
  const held={activeExamMeta:{id:'held'},examUserAnswers:{q:'A'}};
  await page.evaluate(s=>localStorage.setItem('psat_active_exam_state',JSON.stringify(s)),held);
  await page.click('#builder-start');await expect(page.locator('#builder-message')).toContainText('unfinished test');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('psat_active_exam_state')))).toEqual(held);
  expect(page.__pageErrors).toEqual([]);
});
