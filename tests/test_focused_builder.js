const assert=require('assert');
const P=require('../js/engine/test_planner');
const G=require('../js/engine/gap_summary');
const W=require('../js/engine/persistence');
const E=require('../srs');
const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'../data/questions_data.js'),'utf8');
const bank=JSON.parse(src.slice(src.indexOf('=')+1,src.lastIndexOf(']')+1));
const base={sizeMode:'count',requestedCount:7,subjects:['Reading and Writing'],domains:['Craft and Structure'],timingMode:'untimed'};
const before=JSON.stringify(bank);
const plan=P.planTest(bank,base,{now:1000,random:()=>0.5});
assert.equal(plan.actualCount,7);assert(plan.questions.every(q=>q.domain==='Craft and Structure'));assert.equal(new Set(plan.questionIds).size,7);assert.equal(JSON.stringify(bank),before);
for(const n of [3,7,13,25])assert.equal(P.planTest(bank,{...base,requestedCount:n},{now:1000}).actualCount,n);
assert.equal(P.planTest(bank,{...base,questionType:'spr'},{now:1000}).status,'no_match');
for(const n of [0,-1,1.2,Infinity,'bad'])assert.equal(P.planTest(bank,{...base,requestedCount:n},{now:1000}).ok,false);
const assumptions={...P.PLANNER_ASSUMPTIONS,DEFAULT_SECONDS_BY_SUBJECT:{'Reading and Writing':120},UNTIMED_PRACTICE_MULTIPLIER:1};
const timed=P.planTest(bank,{...base,requestedCount:null,sizeMode:'time',availableMinutes:15,reviewMinutes:3,timingMode:'timed'},{now:1000,assumptions});
assert.equal(timed.actualCount,6);assert.equal(timed.timeLimitMinutes,12);assert.equal(timed.timing.totalPlannedSeconds,900);
const fake=[{id:'a',test:'Math',domain:'Algebra',skill:'one',difficulty:'Hard',type:'multiple_choice'},{id:'b',test:'Math',domain:'Algebra',skill:'two',difficulty:'Easy',type:'multiple_choice'}];
const estimates={bySkill:{},bySkillDifficulty:{},bySubjectDifficulty:{}};
// A 95s Math question at the front must not falsely hide a 71s RW item that fits.
const mix=[fake[0],{...fake[1],test:'Reading and Writing'}];
const short=P.planTest(mix,{sizeMode:'time',availableMinutes:1.3,timingMode:'timed'},{now:1000,random:()=>0.99});
assert.equal(short.actualCount,1,'skip oversized candidate instead of falsely declaring no fit');
const summary=G.summarize(fake,{a:{answered:true,isCorrect:false,timestamp:900,timesIncorrect:1}},{now:1000,days:14});
assert.equal(summary[0].status,'Limited evidence');assert.equal(summary[0].suggested,false);
const empty=G.summarize(fake,{}, {now:1000,days:14});assert.equal(empty[0].answered,0);assert.equal(empty[0].accuracy,null);
// Recovery resumes the SAME target writes; no increment operation is replayed.
const data={psat_progress:'{"old":1}'};let fail=true;
const store={getItem:k=>data[k]??null,setItem(k,v){if(k==='psat_exam_history'&&fail)throw Error('quota');data[k]=v;},removeItem:k=>delete data[k]};
const saved=W.writeBatch(store,'',{psat_progress:{old:1,new:1},psat_exam_history:[{examId:'e'}],psat_active_exam_state:null});
assert.equal(saved.success,false);assert(data.psat_pending_write);fail=false;assert(W.recover(store,'').success);assert.equal(JSON.parse(data.psat_exam_history).length,1);assert(!data.psat_pending_write);assert(W.recover(store,'').success);
const report=E.scoreStandardExam({id:'custom',type:'focused_custom_test',customPlan:{},modules:[{questions:bank.slice(0,30),section:'Reading and Writing'}]},{});
assert.equal(report.scores.rwScaled,null);assert.equal(report.scores.totalScaled,null);
console.log('Focused builder: strict real-bank counts 3/7/13/25, 15-minute sizing, sparse evidence, score policy and journal replay passed.');

const old={answered:true,timestamp:100,timesSeen:1,timesCorrect:0,timesIncorrect:1,attempts:[{at:100,attemptId:'one',isCorrect:false}],historicalErrorTags:[{tag:'concept_gap',resolvedAt:50}],isFlagged:true};
const newer={answered:true,timestamp:200,timesSeen:1,timesCorrect:1,timesIncorrect:0,attempts:[{at:100,attemptId:'two',isCorrect:true}]};
for(const merge of [(a,b)=>E.mergeProgress(a,b),require('../api/src/lib/merge').mergeProgress]){
 const merged=merge({q:old},{q:newer}).q;
 assert.equal(merged.attempts.length,2,'Distinct attempt IDs survive the same timestamp');
 assert.equal(merged.historicalErrorTags[0].tag,'concept_gap');assert.equal(merged.isFlagged,true);
}
assert.equal(P.buildTimingStats({[bank[0].id]:{answered:true,timingReliable:true,timeSpentMs:30000}},bank).observationCount,0,'Unknown repeat counts cannot be called first-attempt timing');
