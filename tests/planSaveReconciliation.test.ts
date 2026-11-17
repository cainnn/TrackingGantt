import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Dependency } from '../types'
import type { SaveBaseline } from '../lib/clientSave'
import { reconcilePlanSave, reconciliationHierarchyIssues, type SaveChoice } from '../lib/planSaveReconciliation'
import { findPlanSaveConflicts, findPlanSaveMismatches } from '../lib/planSaveVerification'
const task=(id: string, extra: Partial<Task>={}): Task=>({id,project_id:'p',parent_id:null,task_code:id,name:id,
  assignee:null,start_date:'2030-01-01T00:00:00',end_date:'2030-01-02T00:00:00',duration:1440,duration_unit:'day',
  percent_done:0,is_milestone:false,note:null,order_index:0,is_deleted:false,deleted_at:null,created_at:'',updated_at:'',...extra})
const state=(tasks:Task[], dependencies:Dependency[]=[]):SaveBaseline=>({tasks,dependencies,statusDate:null,lines:[],planningStatus:'draft'})
const link=(id:string,from='a',to='b'):Dependency=>({id,project_id:'p',from_task_id:from,to_task_id:to,type:2,lag:0,active:true})
const pickAll=(result:ReturnType<typeof reconcilePlanSave>,side:SaveChoice)=>Object.fromEntries(result.differences.map(row=>[row.key,side]))

test('disjoint field changes preserve the remote name and local schedule without treating either as a competing edit',()=>{
 const before=state([task('a')]);const local=state([task('a',{end_date:'2030-01-03T00:00:00',duration:2880})]);const remote=state([task('a',{name:'后台新名称'})]);
 const copy=JSON.stringify({before,local,remote});const result=reconcilePlanSave(before,remote,local)
 assert.equal(result.unresolved.length,0);assert.equal(result.differences.length,1);assert.equal(result.plan.tasks[0].name,'后台新名称')
 assert.equal(result.plan.tasks[0].duration,2880);assert.equal(result.plan.tasks[0].end_date,'2030-01-03T00:00:00')
 assert.deepEqual(findPlanSaveConflicts(remote,remote,result.plan),[]);assert.equal(JSON.stringify({before,local,remote}),copy)
})

test('competing names require an explicit choice and unrelated local/remote fields are retained',()=>{
 const before=state([task('a')]),local=state([task('a',{name:'我的名称',note:'我的备注'})]),remote=state([task('a',{name:'后台名称',assignee:'后台负责人'})]);
 const result=reconcilePlanSave(before,remote,local);assert.equal(result.unresolved.length,1)
 for(const side of ['local','remote'] as const){const resolved=reconcilePlanSave(before,remote,local,[],{[result.unresolved[0].key]:side});
 assert.equal(resolved.unresolved.length,0);assert.equal(resolved.plan.tasks[0].name,side==='local'?'我的名称':'后台名称');assert.equal(resolved.plan.tasks[0].assignee,'后台负责人');assert.equal(resolved.plan.tasks[0].note,'我的备注')}
})

test('dates, duration and schedule controls are chosen together rather than mixing inconsistent ranges',()=>{
 const before=state([task('a')]),local=state([task('a',{start_date:'2029-12-31T00:00:00',duration:2880})]),remote=state([task('a',{end_date:'2030-01-04T00:00:00',duration:4320,auto_schedule:false})]);
 const review=reconcilePlanSave(before,remote,local);assert.equal(review.unresolved.length,1);assert.ok(review.unresolved[0].fields.includes('auto_schedule'))
 for(const side of ['local','remote'] as const){const result=reconcilePlanSave(before,remote,local,[],pickAll(review,side));assert.deepEqual(findPlanSaveMismatches(side==='local'?local:remote,result.plan),[])}
})

test('independent additions survive and remote-only deletion is reviewed without deleting local additions',()=>{
 const before=state([task('a')]),local=state([task('a'),task('mine')]),remote=state([task('theirs')]);
 const result=reconcilePlanSave(before,remote,local);assert.equal(result.unresolved.length,0);assert.deepEqual(result.plan.tasks.map(t=>t.id).sort(),['mine','theirs']);assert.equal(result.differences.length,2)
 const keep=reconcilePlanSave(before,remote,local,[],{'tasks:a:record':'local'});assert.ok(keep.plan.tasks.some(t=>t.id==='a'))
})

test('delete versus edit requires explicit record choice in both directions',()=>{
 const before=state([task('a')]);for(const [local,remote] of [[state([]),state([task('a',{note:'后台新备注'})])],[state([task('a',{note:'本地新备注'})]),state([])]]){
 const review=reconcilePlanSave(before,remote,local);assert.equal(review.unresolved.length,1)
 for(const side of ['local','remote'] as const){const result=reconcilePlanSave(before,remote,local,[],pickAll(review,side));assert.deepEqual(findPlanSaveMismatches(side==='local'?local:remote,result.plan),[])}
 }
})

test('different records with the same newly created ID are not silently combined',()=>{
 const review=reconcilePlanSave(state([]),state([task('new',{name:'后台'})]),state([task('new',{name:'本地'})]));assert.equal(review.unresolved.length,1)
})

test('known partial save values are accepted while later unrelated changes remain reviewable',()=>{
 const before=state([task('a')]),attempt=state([task('a',{name:'第一次提交'})]),remote=state([task('a',{name:'第一次提交',assignee:'其他人'})]),local=state([task('a',{name:'重试提交'})]);
 const result=reconcilePlanSave(before,remote,local,[attempt]);assert.equal(result.unresolved.length,0);assert.equal(result.plan.tasks[0].name,'重试提交');assert.equal(result.plan.tasks[0].assignee,'其他人');assert.equal(result.differences.length,1)
 const created=state([task('a'),task('new')]);const retry=state([task('a')]);assert.ok(!reconcilePlanSave(before,created,retry,[created]).plan.tasks.some(t=>t.id==='new'))
})

test('dependency edits are atomic and project lines, state and unseen links are preserved',()=>{
 const before={...state([task('a'),task('b')],[link('d')]),lines:[{id:'l',project_id:'p',name:'线',line_date:'2030-01-01',color:'#000',visible:true}]};
 const local={...before,dependencies:[{...link('d'),lag:60}],statusDate:'2030-01-02'};
 const remote={...before,dependencies:[{...link('d'),type:0}],lines:[{...before.lines[0],name:'后台线'}],planningStatus:'stable' as const};
 const review=reconcilePlanSave(before,remote,local);assert.equal(review.unresolved.length,1);assert.equal(review.unresolved[0].title,'依赖「a → b」')
 const result=reconcilePlanSave(before,remote,local,[],{[review.unresolved[0].key]:'local'});assert.equal(result.plan.dependencies[0].type,2);assert.equal(result.plan.dependencies[0].lag,60);assert.equal(result.plan.lines?.[0].name,'后台线');assert.equal(result.plan.statusDate,'2030-01-02');assert.equal(result.plan.planningStatus,'stable')
})

test('conflicting project metadata and custom field definitions/values require choices',()=>{
 const fields=[{id:'cost',name:'金额',type:'number' as const}];const before={...state([task('a',{custom_fields:fields,custom_values:{cost:'1'}})]),statusDate:'2030-01-01'};
 const local={...before,tasks:[{...before.tasks[0],custom_values:{cost:'2'}}],statusDate:'2030-01-02'};
 const remote={...before,tasks:[{...before.tasks[0],custom_fields:[{...fields[0],name:'新名称'}]}],statusDate:'2030-01-03'};
 const review=reconcilePlanSave(before,remote,local);assert.equal(review.unresolved.length,2)
 const result=reconcilePlanSave(before,remote,local,[],pickAll(review,'remote'));assert.deepEqual(findPlanSaveMismatches(remote,result.plan),[])
})

test('a merged hierarchy cannot silently orphan tasks or create parent cycles',()=>{
 assert.match(reconciliationHierarchyIssues(state([task('child',{parent_id:'missing'})]))[0],/父任务已被删除/)
 assert.ok(reconciliationHierarchyIssues(state([task('a',{parent_id:'b'}),task('b',{parent_id:'a'})])).length)
 assert.deepEqual(reconciliationHierarchyIssues(state([task('a'),task('b',{parent_id:'a'})])),[])
})
