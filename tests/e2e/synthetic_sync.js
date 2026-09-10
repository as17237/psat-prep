// Synthetic state only; use with the mandatory fixtures.js browser quarantine.
const M=require('../../api/src/lib/merge');
async function intercept(page,context,state){
 await page.unroute('**/*');
 await context.route('https://**/*',route=>route.abort());
 await page.route('https://**/*',route=>route.abort());
 await page.route('**/api/sync**',async route=>{
  const req=route.request();
  if(!state.connected)return route.abort('internetdisconnected');
  if(req.method()==='POST'){
   const b=req.postDataJSON();state.posts.push(b);
   if(state.failPost)return route.fulfill({status:503,body:'temporary failure'});
   state.cloud.progress=M.mergeProgress(state.cloud.progress,b.progress);state.cloud.srsState=M.mergeSrsState(state.cloud.srsState,b.srsState);state.cloud.sessionsState=M.mergeSessions(state.cloud.sessionsState,b.sessionsState);state.cloud.examHistory=M.mergeExamHistory(state.cloud.examHistory,b.examHistory,Infinity);
   if(state.loseAck){state.loseAck=false;return route.abort('failed');}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,updatedAt:Date.now(),ackOpIds:b.outboxOps.map(o=>o.id)})});
  }
  if(state.failGet)return route.fulfill({status:503,body:'temporary failure'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,exists:Object.keys(state.cloud.progress||{}).length>0,data:state.cloud})});
 });
}
function state(){return {connected:true,cloud:{progress:{},srsState:{},sessionsState:{},examHistory:[]},posts:[]};}

module.exports = { intercept, state };
