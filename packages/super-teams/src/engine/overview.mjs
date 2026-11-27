import { compactResult } from './context.mjs';
import { taskAttention } from './task-status.mjs';
import { recoveryGuidance, recoveryDiagnostics } from './recovery-guidance.mjs';
const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const abandonmentScope='business-only; no stop/capacity release/acceptance/dependency completion/delivery resolution';
const text=(input,maxBytes)=>{
  const original=typeof input==='string'?input:JSON.stringify(input??'');let limit=maxBytes,result=compactResult({text:original,maxBytes:limit}).text;
  while(size(result)>maxBytes&&limit>0){limit=Math.floor(limit/2);result=compactResult({text:original,maxBytes:limit}).text;}
  return result;
};
const attention=task=>taskAttention(task).needsDecision;
const nextStep=task=>({preflight:'resolve_preflight','dependency-abandoned':'replan_dependencies','abandoned-unresolved-execution':'inspect_execution','unresolved-execution':'inspect_execution','execution-failed':'review_failure','acceptance-required':'review_artifacts'})[taskAttention(task).reason]??null;
export function buildSystemHealthBanner({tasks=[],bindings=[],disk={},now=Date.now(),observationError}={}) {
  const blocked=bindings.filter(binding=>['unknown','needs-attention'].includes(binding.blockingDelivery?.status));
  const dates=blocked.map(binding=>binding.blockingDelivery.blockedSince).map(value=>typeof value==='number'?value:Date.parse(value)).filter(Number.isFinite);
  const unresolvedSlotsUsed=tasks.filter(task=>task.executionUnresolved===true).length;
  return {unresolvedSlotsUsed,blockedBindingsCount:blocked.length,oldestBlockedAgeMs:dates.length?Math.max(0,now-Math.min(...dates)):null,
    snapshotDiskUsageBytes:disk.bytes??null,snapshotDiskMeasuredAt:disk.measuredAt??null,actionRequired:unresolvedSlotsUsed>0||blocked.length>0||!!observationError||!!disk.error,
    ...(unresolvedSlotsUsed||blocked.length?{diagnostics:recoveryDiagnostics(tasks,bindings)}:{}),
    ...(observationError?{observationError:text(observationError,200)}:{}),...(disk.error?{snapshotDiskError:text(disk.error,200)}:{})};
}
export function buildOverview(tasks,{cursor=0,limit=20,budgetBytes=16384,health,team,attentionOnly=false}={}) {
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(budgetBytes)||budgetBytes<1024||budgetBytes>65536)throw new Error('Invalid overview window');
  if(typeof attentionOnly!=='boolean')throw new Error('attentionOnly must be boolean');
  const decisions=tasks.filter(attention);
  const byCreated=(a,b)=>String(a.createdAt).localeCompare(String(b.createdAt));
  const sorted=attentionOnly?decisions.sort(byCreated):[...tasks].sort((a,b)=>Number(attention(b))-Number(attention(a))||byCreated(a,b));
  const counts={};for(const task of tasks)counts[task.state]=(counts[task.state]||0)+1;
  const result={total:tasks.length,attention:decisions.length,counts,cursor,nextCursor:null,items:[],budgetBytes,bytes:0};
  if(attentionOnly)Object.assign(result,{attentionOnly:true,matchedTotal:sorted.length});
  if(team)result.team={id:team.id,name:compactResult({text:team.name,maxBytes:256}).text,goal:compactResult({text:team.goal,maxBytes:1024}).text,control:team.control,
    members:team.members.map(m=>({id:m.id,name:compactResult({text:m.name,maxBytes:128}).text,role:compactResult({text:m.role,maxBytes:256}).text,taskCount:m.taskIds?.length??0}))};
  if(health){
    if(health.systemHealthBanner)result.systemHealthBanner=health.systemHealthBanner;
    const a=health.adapter??{},s=health.scheduler??{},error=s.lastRecoveryError||s.connectionError||a.error;
    const excerpt=error?compactResult({text:String(error),maxBytes:256}):null;
    result.health={adapter:a.state??'unknown',pendingReconciliations:s.pendingReconciliations??0,uninspectableReconciliations:s.uninspectableReconciliations??0,recovering:s.recovering??0,nextRecoveryAt:s.nextRecoveryAt??null,error:excerpt?{text:excerpt.text,truncated:excerpt.truncated}:null};
  }
  let index=cursor;
  for(;index<sorted.length&&result.items.length<limit;index++){
    const t=sorted[index];
    const summary=compactResult({text:typeof t.summary==='string'?t.summary:t.summary?.text||'',maxBytes:1024});
    if(t.summary?.truncated){summary.truncated=true;summary.originalBytes=t.summary.originalBytes??t.summary.bytes??null;}
    const errorText=typeof t.error==='string'?t.error:JSON.stringify(t.error);
    const item={id:t.id,title:compactResult({text:t.title||'',maxBytes:256}).text,state:t.state,control:t.control,revision:t.revision,model:t.model,effort:t.effort,
      ...(t.teamId?{teamId:t.teamId,memberId:t.memberId}:{}),summary,error:t.error?compactResult({text:errorText,maxBytes:512}):null,evidence:`/api/tasks/${t.id}`,blockReason:t.blockReason??null,needsDecision:attention(t),attentionReason:taskAttention(t).reason,nextStep:nextStep(t),
      ...(t.state==='abandoned'?{executionUnresolved:t.executionUnresolved??'unknown',abandonment:{reason:text(t.abandonment?.reason??'unknown',256),actorAssurance:t.abandonment?.actorAssurance??'unknown',scope:abandonmentScope}}:{})};
    result.items.push(item);result.nextCursor=index+1<sorted.length?index+1:null;
    if(size(result)+32>budgetBytes){result.items.pop();break;}
  }
  result.nextCursor=index<sorted.length?index:null;
  if(index===cursor&&index<sorted.length)throw new Error('Overview budget too small for one task; increase budgetBytes');
  // bytes includes itself, converging after the digit count stabilizes.
  while(result.bytes!==size(result))result.bytes=size(result);
  if(result.bytes>budgetBytes)throw new Error('Overview budget too small for required metadata; increase budgetBytes');
  return result;
}

export function buildTeamList(teams,{cursor=0,limit=20,budgetBytes=16384}={}){
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(budgetBytes)||budgetBytes<1024||budgetBytes>65536)throw new Error('Invalid team list window');
  const result={total:teams.length,teams:[],cursor,nextCursor:null,budgetBytes,bytes:0};let index=cursor;
  for(;index<teams.length&&result.teams.length<limit;index++){
    const t=teams[index];result.teams.push({id:t.id,name:compactResult({text:t.name,maxBytes:256}).text,control:t.control,memberCount:t.memberCount,counts:t.counts});
    if(size(result)+32>budgetBytes){result.teams.pop();break;}
  }
  result.nextCursor=index<teams.length?index:null;
  if(index===cursor&&index<teams.length)throw new Error('Team list budget too small for one team; increase budgetBytes');
  while(result.bytes!==size(result))result.bytes=size(result);
  if(result.bytes>budgetBytes)throw new Error('Team list budget too small; increase budgetBytes');
  return result;
}

export function buildInspection(task,{budgetBytes=16384}={}) {
  if(!Number.isSafeInteger(budgetBytes)||budgetBytes<1024||budgetBytes>65536)throw new Error('Invalid inspection budget');
  const value=Object.fromEntries(['id','teamId','memberId','revision','state','control','dependsOn','attemptId','threadId','turnId','executionUnresolved','verification','acceptance','checks','resultFile','updatedAt','abandonment'].map(key=>[key,structuredClone(task[key]??null)]));
  value.snapshotId=task.snapshotId??task.acceptance?.snapshotId??'unknown';
  const guidance=recoveryGuidance(task);
  if(guidance)value.recovery=guidance;
  if(task.budgetDetails)value.budgetDetails=structuredClone(task.budgetDetails);
  if(task.unresolvedResolution)value.unresolvedResolution=structuredClone(task.unresolvedResolution);
  if(value.acceptance){value.acceptance.versionPinned??='unknown';value.acceptance.snapshotId??='unknown';}
  if(value.abandonment)value.abandonment.scope=abandonmentScope;
  value.verification??={status:'unknown',passed:null};
  value.omittedFields=[];
  // Keep host outcome separate from artifact checks and explicit acceptance.
  const runtimeError=task.runtimeError??(task.completionStatus==='failed'?task.error:null);
  value.execution={completionStatus:task.completionStatus??'unknown',error:runtimeError?text(runtimeError,256):null,unresolved:task.executionUnresolved??'unknown',stopAssurance:task.stopCertified===true?'certified':task.stopCertified===false?'not-certified':'unknown'};
  if(task.usage!==undefined)value.execution.usage=structuredClone(task.usage);
  if(runtimeError&&value.execution.error!==runtimeError)value.omittedFields.push('runtimeError.details');
  for(const key of ['title','goal','summary','error']){
    const original=typeof task[key]==='string'?task[key]:task[key]?.text??(task[key]?JSON.stringify(task[key]):'');
    const excerpt=compactResult({text:original,maxBytes:key==='title'?256:1024});
    value[key]=excerpt.text;if(excerpt.truncated)value.omittedFields.push(key);
  }
  value.budgetBytes=budgetBytes;value.bytes=0;
  const shrinkAcceptance=()=>{
    const a=value.acceptance;if(!a)return;
    const reason=a.reason??a.exception?.reason??(typeof a.exception==='string'?a.exception:null);
    value.acceptance={source:text(a.source??a.kind??'unknown',64),versionPinned:a.versionPinned,snapshotId:a.snapshotId,...(a.actor!==undefined?{actor:text(a.actor,64)}:{}),...(a.actorAssurance!==undefined?{actorAssurance:text(a.actorAssurance,32)}:{}),hostCompletionStatus:a.hostCompletionStatus??'unknown',acknowledgeHostFailure:a.acknowledgeHostFailure??a.exception?.acknowledgeHostFailure??'unknown',reason:reason===null?null:text(reason,128)};
    value.omittedFields.push('acceptance.details');
  };
  const shrinkAbandonment=()=>{
    const a=value.abandonment;if(!a)return;
    value.abandonment={reason:text(a.reason??'unknown',128),actorAssurance:a.actorAssurance??'unknown',observedRevision:a.observedRevision??'unknown',versionPinned:a.versionPinned??'unknown',scope:abandonmentScope};
    value.omittedFields.push('abandonment.details');
  };
  if(value.acceptance&&size(value.acceptance)>Math.min(2048,budgetBytes/4))shrinkAcceptance();
  if(value.abandonment&&size(value.abandonment)>Math.min(2048,budgetBytes/4))shrinkAbandonment();
  if(size(value)+32>budgetBytes&&value.verification){
    const v=value.verification;
    const failure=v.error??v.checks?.find(check=>check.passed===false)?.error??(v.status==='failed'||v.passed===false?task.error:null);
    value.verification={status:v.status??(v.files?.length?(v.passed?'passed':'failed'):'not_verified'),passed:v.files?.length?v.passed:(v.passed===false?false:null),fileCount:v.files?.length??0,checkCount:v.checks?.length??0};
    if(failure)value.verification.error=text(failure,256);
    value.omittedFields.push('verification.details');
  }
  if(size(value)+32>budgetBytes&&value.acceptance&&!value.omittedFields.includes('acceptance.details'))shrinkAcceptance();
  if(size(value)+32>budgetBytes&&value.abandonment&&!value.omittedFields.includes('abandonment.details'))shrinkAbandonment();
  if(size(value)+32>budgetBytes&&value.execution.usage!==undefined){delete value.execution.usage;value.omittedFields.push('usage');}
  if(size(value)+32>budgetBytes&&value.recovery){value.recovery={kind:value.recovery.kind};value.omittedFields.push('recovery.details');}
  if(size(value)+32>budgetBytes&&value.budgetDetails){delete value.budgetDetails.budgetBreakdown;value.omittedFields.push('budgetDetails.budgetBreakdown');value.budgetDetails.evidence='/api/tasks/'+task.id;}
  for(const key of ['unresolvedResolution','checks','goal','summary','error','resultFile','dependsOn','title','updatedAt','teamId','memberId','threadId','turnId','attemptId']){
    if(size(value)+32<=budgetBytes)break;
    delete value[key];value.omittedFields.push(key);
  }
  if(size(value)+32>budgetBytes&&value.execution.error){value.execution.error=text(value.execution.error,64);value.omittedFields.push('runtimeError.details');}
  if(size(value)+32>budgetBytes&&value.verification.error){value.verification.error=text(value.verification.error,64);value.omittedFields.push('verification.error.details');}
  if(size(value)+32>budgetBytes){
    // At the smallest budget retain outcome, check failure, snapshot/pinning and
    // abandonment scope before optional identities or narrative metadata.
    delete value.control;delete value.executionUnresolved;
    delete value.recovery;
    value.omittedFields=[...new Set(value.omittedFields.filter(key=>['checks','acceptance.details','abandonment.details','verification.details'].includes(key)).concat('task.metadata'))];
    if(value.acceptance){delete value.acceptance.actor;delete value.acceptance.actorAssurance;value.acceptance.reason=value.acceptance.reason?text(value.acceptance.reason,40):null;}
    delete value.verification.fileCount;delete value.verification.checkCount;
    if(value.abandonment)value.abandonment.reason=text(value.abandonment.reason,40);
    if(value.execution.error)value.execution.error=text(value.execution.error,40);
    if(value.verification.error)value.verification.error=text(value.verification.error,64);
  }
  value.detailTruncated=value.omittedFields.length>0;
  while(value.bytes!==size(value))value.bytes=size(value);
  if(value.bytes>budgetBytes)throw new Error('Inspection budget too small for task identity; increase budgetBytes');
  return value;
}
