import {esc} from './html.js';
import {APP_ENV} from './env.js';
import {safeGetStorage} from './storage.js';

export function mountFocusedBuilder(root, onStart, initialRequest = null) {
  const Planner=window.__PSAT_ENGINE_PARTS.test_planner;
  const Gap=window.__PSAT_ENGINE_PARTS.gap_summary;
  const bank=window.QUESTIONS_DATA || [];
  const selected=new Set();let plan=null;
  root.classList.add('focused-builder');
  root.innerHTML=`<h3 class="card-title">Build a focused test</h3>
    <p class="card-subtitle">Choose topics, then set a question count or fit practice to the time you have.</p>
    <div class="builder-controls">
      <label>Subject<select id="builder-subject"><option value="">Both subjects</option><option>Reading and Writing</option><option>Math</option></select></label>
      <label>Evidence period<select id="builder-period"><option value="14">Recent 14 days</option><option value="0">All time</option></select></label>
    </div>
    <h4>Suggested focus areas and all topics</h4>
    <p class="builder-note">Evidence shows the latest recorded answer for each question in this view, not first-attempt accuracy. Older attempt history is limited. Wrong answers alone do not confirm a concept gap.</p>
    <div class="builder-actions"><button type="button" class="btn btn-sm btn-secondary" id="builder-suggest">Select suggested areas</button><button type="button" class="btn btn-sm btn-secondary" id="builder-clear">Clear selection</button></div>
    <div id="builder-topics" class="builder-topics"></div>
    <p id="builder-selection" aria-live="polite"></p>
    <div class="builder-controls">
      <label>Size the test<select id="builder-size"><option value="count">By number of questions</option><option value="time">Fit available time</option></select></label>
      <label id="builder-count-label">Questions (1–100)<input id="builder-count" type="number" min="1" max="100" step="1" value="10"></label>
      <label id="builder-minutes-label" hidden>Available minutes (up to 240)<input id="builder-minutes" type="number" min="1" max="240" value="15"></label>
      <label>Mode<select id="builder-timing"><option value="untimed">Untimed practice</option><option value="timed">Timed test</option></select></label>
      <label>Minutes reserved for review<input id="builder-review" type="number" min="0" max="239" value="0"></label>
      <label id="builder-limit-label">Optional answering timer (minutes)<input id="builder-limit" type="number" min="1" max="240" placeholder="No timer"></label>
    </div>
    <div class="builder-actions"><button type="button" class="btn btn-sm btn-secondary" data-count="10">10 questions</button><button type="button" class="btn btn-sm btn-secondary" data-count="20">20 questions</button><button type="button" class="btn btn-sm btn-secondary" data-minutes="10">10 minutes</button><button type="button" class="btn btn-sm btn-secondary" data-minutes="15">15 minutes</button><button type="button" class="btn btn-sm btn-secondary" data-minutes="20">20 minutes</button><button type="button" class="btn btn-sm btn-secondary" data-minutes="30">30 minutes</button></div>
    <details><summary>Optional filters</summary><div class="builder-controls">
      <label>Difficulty<select id="builder-difficulty"><option value="">All difficulties</option><option>Easy</option><option>Medium</option><option>Hard</option></select></label>
      <label>Format<select id="builder-format"><option value="">All formats</option><option value="mcq">Multiple choice</option><option value="spr">Free response</option></select></label>
      <label>Question preference<select id="builder-preference"><option value="unseen_first">New questions first</option><option value="unseen_only">Unseen only</option><option value="mistakes">Previous mistakes</option><option value="due_reviews">Due reviews only</option><option value="all">All matching questions</option></select></label>
    </div></details>
    <div id="builder-preview" class="builder-preview" aria-live="polite"></div>
    <label id="builder-shortage-label" hidden><input id="builder-shortage" type="checkbox"> I accept the smaller question set shown above.</label>
    <p id="builder-message" role="status"></p>
    <div class="builder-actions"><button type="button" class="btn btn-md btn-primary" id="builder-start">Start in student app</button><button type="button" class="btn btn-sm btn-secondary" id="builder-share">Copy setup link</button></div>
    <p class="builder-note">A setup link previews a new matching set on the student's device. It contains no answers or student history. Custom tests do not predict a PSAT score.</p>`;
  const el=id=>root.querySelector('#builder-'+id), value=id=>el(id).value;
  function request(){
    const time=value('size')==='time';
    return {schemaVersion:1,subjects:value('subject')?[value('subject')]:[],skills:[...selected],domains:[],
      difficulties:value('difficulty')?[value('difficulty')]:[],questionType:value('format')||null,
      selectionPreference:value('preference'),sizeMode:value('size'),timingMode:value('timing'),
      requestedCount:time?null:value('count'),availableMinutes:time?value('minutes'):null,
      reviewMinutes:value('review'),timeLimitMinutes:!time&&value('timing')==='timed'?(value('limit')||null):null};
  }
  function update(){
    const time=value('size')==='time';el('count-label').hidden=time;el('minutes-label').hidden=!time;
    el('limit-label').hidden=time||value('timing')==='untimed';
    el('selection').textContent=selected.size?'Selected skills: '+[...selected].join('; '):'All topics in '+(value('subject')||'both subjects')+'. Select a domain or skill to narrow the test.';
    plan=Planner.planTest(bank,request(),{now:Date.now(),progressMap:safeGetStorage('psat_progress',{}),srsMap:safeGetStorage('psat_srs',{})});
    const desc=Planner.describePlan(plan);
    el('preview').innerHTML='<h4>Test preview</h4>'+desc.lines.map(line=>'<p>'+esc(line)+'</p>').join('');
    el('shortage-label').hidden=!plan.requiresAcceptance;el('shortage').checked=false;
    el('start').disabled=!plan.ok||plan.actualCount<1||plan.requiresAcceptance;
  }
  function evidence(r){
    const stats=r.answered?`${r.wrong} wrong / ${r.answered} answered · ${r.accuracy}% accuracy`:'No recorded answers in this view';
    const date=r.lastAt?' · Last practiced '+new Date(r.lastAt).toLocaleDateString():'';
    return `<span class="builder-status ${r.suggested?'needs-practice':''}">${esc(r.status)}</span><p>${esc(stats+date)}</p>`+
      (r.stale?'<p>Older evidence</p>':'')+
      (r.conceptTags?`<p>Concept gap tagged on ${r.conceptTags} question(s)</p>`:'')+
      (r.recurring?`<p>Same question missed repeatedly: ${r.recurring} question(s)</p>`:'')+
      (r.wrong>=2?`<p>Latest answers wrong on ${r.wrong} different questions</p>`:'')+
      (r.historicalMisses?`<p>Historical misses on ${r.historicalMisses} questions; correct retries do not erase these.</p>`:'');
  }
  let rows=[];
  function renderTopics(){
    rows=Gap.summarize(bank,safeGetStorage('psat_progress',{}),{now:Date.now(),days:Number(value('period'))}).filter(d=>!value('subject')||d.subject===value('subject'));
    el('topics').innerHTML=rows.map((d,i)=>`<article class="builder-topic"><label class="builder-topic-title"><input type="checkbox" data-domain="${i}"> ${esc(d.name)}</label><small>${esc(d.subject)}</small>${evidence(d)}<details><summary>Show skills and evidence</summary>${d.skills.map((s,j)=>`<div class="builder-skill"><label><input type="checkbox" data-skill="${i}:${j}"> ${esc(s.name)}</label>${evidence(s)}</div>`).join('')}</details></article>`).join('');
    syncChecks();
    el('suggest').disabled=!rows.some(d=>d.suggested||d.suggestedSkills.length);
  }
  function syncChecks(){
    el('topics').querySelectorAll('[data-domain]').forEach(box=>{const skills=rows[Number(box.dataset.domain)].skills;const count=skills.filter(s=>selected.has(s.name)).length;box.checked=count===skills.length;box.indeterminate=count>0&&count<skills.length;});
    el('topics').querySelectorAll('[data-skill]').forEach(box=>{const [i,j]=box.dataset.skill.split(':').map(Number);box.checked=selected.has(rows[i].skills[j].name);});
  }
  el('topics').onchange=e=>{
    const box=e.target;
    if(box.dataset.domain!==undefined)rows[Number(box.dataset.domain)].skills.forEach(s=>box.checked?selected.add(s.name):selected.delete(s.name));
    else if(box.dataset.skill){const [i,j]=box.dataset.skill.split(':').map(Number);const name=rows[i].skills[j].name;box.checked?selected.add(name):selected.delete(name);}
    syncChecks();update();
  };
  el('subject').onchange=()=>{selected.clear();renderTopics();update();el('message').textContent='Topic selection cleared for the new subject.';};
  el('period').onchange=()=>renderTopics();
  el('suggest').onclick=()=>{rows.forEach(d=>{(d.suggestedSkills.length?d.suggestedSkills:(d.suggested?d.skills.map(s=>s.name):[])).forEach(s=>selected.add(s));});syncChecks();update();};
  el('clear').onclick=()=>{selected.clear();syncChecks();update();};
  ['size','count','minutes','review','limit','timing','difficulty','format','preference'].forEach(id=>el(id).addEventListener('input',update));
  root.querySelectorAll('[data-count]').forEach(b=>b.onclick=()=>{el('size').value='count';el('count').value=b.dataset.count;update();});
  root.querySelectorAll('[data-minutes]').forEach(b=>b.onclick=()=>{el('size').value='time';el('minutes').value=b.dataset.minutes;update();});
  el('shortage').onchange=()=>el('start').disabled=!plan?.ok||(plan.requiresAcceptance&&!el('shortage').checked);
  el('start').onclick=()=>{
    if(!plan?.ok||el('start').disabled||window.__PSAT_WRITE_BLOCKED__)return;
    if(safeGetStorage('psat_active_exam_state',null)){el('message').textContent='An unfinished test is saved. Resume or archive it in the student Exam tab before starting another.';return;}
    const {questions,...lean}=plan;
    const setup={version:1,id:'focused_'+crypto.randomUUID(),title:'Focused practice',type:'focused_custom_test',questionIds:plan.questionIds,customPlan:lean,timeLimitMinutes:plan.timeLimitMinutes,isUntimed:plan.isUntimed||plan.timeLimitMinutes===null};
    onStart(setup);
  };
  el('share').onclick=async()=>{
    if(!plan?.ok){el('message').textContent='Choose a valid setup before sharing.';return;}
    const url=new URL('index.html',window.location.href);url.searchParams.set('mode','focused_setup');url.searchParams.set('setup',JSON.stringify(plan.request));if(APP_ENV.isBeta)url.searchParams.set('env','beta');
    try{await navigator.clipboard.writeText(url.href);el('message').textContent='Setup link copied. It will preview a new matching set.';}catch(e){el('message').textContent='Copy this setup link: '+url.href;}
  };
  if(initialRequest){
    const checked=Planner.normalizePlanRequest(initialRequest);
    const originalPlan=Planner.planTest(bank,initialRequest,{now:Date.now(),progressMap:safeGetStorage('psat_progress',{}),srsMap:safeGetStorage('psat_srs',{})});
    if(!originalPlan.ok){el('preview').textContent=Planner.describePlan(originalPlan).lines.join(' ' );el('start').disabled=true;el('share').disabled=true;return;}
    if(!checked.ok && checked.errors.length){el('message').textContent=checked.errors.map(e=>e.message).join(' ');el('start').disabled=true;el('share').disabled=true;return;}
    const r=checked.request;
    el('subject').value=r.subjects.length===1?r.subjects[0]:'';
    (r.skills.length?r.skills:bank.filter(q=>(!r.subjects.length||r.subjects.includes(q.test))&&r.domains.includes(q.domain)).map(q=>q.skill)).forEach(s=>selected.add(s));
    for(const [id,v] of Object.entries({size:r.sizeMode,count:r.requestedCount||10,minutes:r.availableMinutes||15,review:r.reviewMinutes,timing:r.timingMode,limit:r.timeLimitMinutes||'',difficulty:r.difficulties[0]||'',format:r.questionType||'',preference:r.selectionPreference}))el(id).value=v;
  }
  renderTopics();update();
}
