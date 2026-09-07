import {esc} from './html.js';
import {APP_ENV} from './env.js';
import {safeGetStorage,offerSaveRecovery} from './storage.js';

export async function importStudentFile(file) {
  if (!file || window.__PSAT_WRITE_BLOCKED__) return;
  const E=window.PSAT_ENGINE, V=window.__PSAT_ENGINE_PARTS.importValidate;
  try {
    const checked=V.validateImportFile(JSON.parse(await file.text()),Date.now());
    if (!checked.ok || checked.normalized?.totals.skipped) {
      alert('Import canceled. No records changed.\n'+[...checked.errors,...checked.warnings].join('\n'));return;
    }
    const data=checked.normalized;
    if (data.isSampleData || data.sampleFlaggedEntries) {alert('Sample records cannot be imported into real student progress. Use the isolated demo tools.');return;}
    const current={progress:safeGetStorage('psat_progress',{}),srsState:safeGetStorage('psat_srs',{}),sessionsState:safeGetStorage('psat_sessions',{}),examHistory:safeGetStorage('psat_exam_history',[])};
    const dialog=document.createElement('dialog');dialog.className='card';dialog.style.cssText='box-sizing:border-box;width:min(650px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:90dvh;overflow:auto;margin:0;position:fixed;left:50vw;top:50dvh;transform:translate(-50%,-50%);overflow-wrap:anywhere';
    dialog.innerHTML='<h2 class="card-title">Review student data import</h2><p>Merge retains existing records. Replace erases the local profile values before loading this file. A recovery snapshot is required. Cloud records are retained and may merge back on sync.</p><label>Import strategy <select id="import-strategy"><option value="merge">Merge</option><option value="replace">Replace local profile</option></select></label><div id="import-preview"></div><p id="import-error" role="alert"></p><button class="btn btn-md btn-primary" id="import-apply">Apply import</button> <button class="btn btn-md btn-secondary" id="import-cancel">Cancel</button>';
    document.body.append(dialog);
    const strategy=dialog.querySelector('select');
    const render=()=>{const p=V.buildImportPreview(data,current,strategy.value,Date.now());dialog.querySelector('#import-preview').innerHTML='<p>'+esc(file.name)+'</p><p>'+data.totals.kept+' validated records.</p><p>Existing entries removed: '+p.totals.erased+'. Overlapping entries: '+p.totals.overwritten+'.</p>';};render();strategy.onchange=render;
    dialog.querySelector('#import-cancel').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>dialog.remove());
    dialog.querySelector('#import-apply').onclick=()=>{
      if (safeGetStorage('psat_active_exam_state',null)) {dialog.querySelector('#import-error').textContent='Finish or archive the saved test before importing.';return;}
      if (strategy.value==='replace'&&!confirm('Replace the local profile? Current local progress, SRS, sessions and exam history will be erased and replaced by this file. A recoverable snapshot will be kept. Cloud records are not deleted.'))return;
      const snapshot=E.createClientSnapshot(localStorage,'pre_'+strategy.value+'_import',window.location);
      if (!snapshot.success) {dialog.querySelector('#import-error').textContent='Cannot create recovery snapshot. Import canceled.';return;}
      // Re-read at the point of mutation so a newer sync is not overwritten by
      // the stale preview. Show another preview if the profile changed.
      const latest={progress:safeGetStorage('psat_progress',{}),srsState:safeGetStorage('psat_srs',{}),sessionsState:safeGetStorage('psat_sessions',{}),examHistory:safeGetStorage('psat_exam_history',[])};
      if(JSON.stringify(latest)!==JSON.stringify(current)){dialog.querySelector('#import-error').textContent='Progress changed while previewing. Cancel and reopen the file for an updated preview.';return;}
      const merge=strategy.value==='merge';
      const history=merge?E.mergeExamHistory(data.examHistory,current.examHistory,Infinity):data.examHistory;
      if(merge)current.examHistory.filter(h=>!h.examId&&!h.completedAt).forEach(h=>history.push(h));
      const values={psat_progress:merge?E.mergeProgress(data.progress,current.progress):data.progress,
        psat_srs:merge?E.mergeSrsState(data.srsState,current.srsState):data.srsState,
        psat_sessions:merge?E.mergeSessionsState(data.sessionsState,current.sessionsState):data.sessionsState,
        psat_exam_history:history,psat_sync_cursor:null};
      const result=window.__PSAT_ENGINE_PARTS.persistence.writeBatch(localStorage,APP_ENV.storagePrefix,values);
      if(!result.success){dialog.close();offerSaveRecovery(values);return;}
      dialog.close();location.reload();
    };
    dialog.showModal();
  } catch(e) {alert('Import canceled: '+e.message);}
}
