(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.__PSAT_ENGINE_PARTS = root.__PSAT_ENGINE_PARTS || {}).gap_summary = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  // Legacy progress is the authority here; exam history is deliberately not
  // added a second time. These are latest recorded answers, not first attempts.
  function summarize(questions, progress, options) {
    var now = options.now, since = options.days ? now-options.days*86400000 : null;
    var domains = new Map();
    function row(name) { return {name:name,answered:0,wrong:0,conceptTags:0,recurring:0,historicalMisses:0,lastAt:null,skills:[],ids:[]}; }
    questions.forEach(function(q) {
      var key=q.test+'|'+q.domain;
      if (!domains.has(key)) domains.set(key,Object.assign(row(q.domain),{subject:q.test}));
      var d=domains.get(key), s=d.skills.find(function(s){return s.name===q.skill;});
      if (!s) {s=row(q.skill);d.skills.push(s);}
      s.ids.push(q.id);d.ids.push(q.id);
      var p=progress[q.id];
      if (!p || !p.answered) return;
      if (since!==null && (!Number.isFinite(p.timestamp) || p.timestamp<since || p.timestamp>now)) return;
      [d,s].forEach(function(r) {
        r.answered++;if (!p.isCorrect) r.wrong++;
        if(p.errorTag==='concept_gap')r.conceptTags++;
        if(since===null) {
          if(p.timesIncorrect>=2)r.recurring++;
          if(p.timesIncorrect>0 || !p.isCorrect)r.historicalMisses++;
        } else {
          var misses=(p.attempts||[]).filter(function(a){return a.isCorrect===false && Number.isFinite(a.at) && a.at>=since && a.at<=now;}).length;
          if(misses>=2)r.recurring++;
          if(misses>0 || !p.isCorrect)r.historicalMisses++;
        }
        if(Number.isFinite(p.timestamp)&&p.timestamp<=now)r.lastAt=Math.max(r.lastAt||0,p.timestamp);
      });
    });
    function finish(r) {
      r.accuracy=r.answered?Math.round(100*(r.answered-r.wrong)/r.answered):null;
      r.suggested=r.answered>=3 && (r.wrong/r.answered>=0.25 || r.recurring>0 || r.conceptTags>0);
      r.status=!r.answered?'Not practiced in this view':r.answered<3?'Limited evidence':r.conceptTags?'Concept gaps tagged':r.recurring?'Repeated mistakes':r.suggested?'Needs practice':'Keep practicing';
      r.stale=r.lastAt!==null && r.lastAt<now-14*86400000;
      r.rank=r.suggested?100+(r.wrong/r.answered)*50+r.conceptTags:0;
      return r;
    }
    return Array.from(domains.values()).map(function(d) {
      d.skills=d.skills.map(finish).sort(function(a,b){return b.rank-a.rank||a.name.localeCompare(b.name);});
      finish(d);d.suggestedSkills=d.skills.filter(function(s){return s.suggested;}).map(function(s){return s.name;});
      if(d.suggestedSkills.length)d.rank=Math.max(d.rank,Math.max.apply(null,d.skills.map(function(s){return s.rank;})));
      return d;
    }).sort(function(a,b){return b.rank-a.rank||a.name.localeCompare(b.name);});
  }
  return {summarize:summarize};
});
