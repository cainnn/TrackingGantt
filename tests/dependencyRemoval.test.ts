import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import type { Task, Dependency } from '../types'
import { planDependencyRemoval } from '../lib/dependencyRemoval'
import { addMinutesStr } from '../lib/clientTime'
import { buildSaveDiff } from '../lib/clientSave'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, labelDraftStep, undoDraft, redoDraft } from '../store/draftHistory'
import { setTasks, updateTasks, removeDependency, markDirty } from '../store/slices/tasksSlice'
import { setCurrentProject } from '../store/slices/projectSlice'

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, parent_id: null, project_id: 'p', task_code: id, name: id,
  assignee: null, start_date: '2030-01-01T00:00:00', end_date: '2030-01-02T00:00:00', duration: 1440,
  duration_unit: 'minute', percent_done: 0, auto_schedule: true, constraint_type: 'asap', is_milestone: false,
  note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', ...extra })
const dep = (from: string, to: string, extra: Partial<Dependency> = {}): Dependency => ({ id: `${from}-${to}`,
  project_id: 'p', from_task_id: from, to_task_id: to, type: 2, lag: 0, active: true, ...extra })
function fixture(isMinute = false) {
  const unit = isMinute ? 60 : 1440
  const at = (n: number) => addMinutesStr(isMinute ? '2030-01-01T09:15:00' : '2030-01-01T00:00:00', n * unit)!
  const make = (id: string, s: number, e: number, extra: Partial<Task> = {}) => task(id, { start_date: at(s), end_date: at(e), duration: (e-s)*unit, ...extra })
  const tasks = [make('a',0,1),make('b',0,2),make('c',0,3),make('d',3,4),make('e',4,5)]
  const dependencies = [dep('a','d'),dep('b','d'),dep('c','d'),dep('d','e')]
  const options = { isMinute, removalDate: at(-1) }
  return { tasks, dependencies, unit, at, make, options }
}
for (const minute of [false, true]) {
  test(`link removal collapses parallel join and successors without deleting predecessor (${minute})`, () => {
    const {tasks, dependencies, at, make, options} = fixture(minute)
    const unrelated = make('unrelated',0,1,{constraint_type:'muststarton',constraint_date:at(8)})
    const input = [...tasks, unrelated], copy = JSON.stringify({input,dependencies})
    const plan = planDependencyRemoval(input, dependencies, ['c-d'], options)
    assert.equal(plan.tasks.find(t=>t.id==='d')?.start_date,at(2))
    assert.equal(plan.tasks.find(t=>t.id==='e')?.start_date,at(3))
    assert.deepEqual(plan.updatedTasks.map(t=>t.id),['d','e'])
    assert.strictEqual(plan.tasks.find(t=>t.id==='c'),tasks[2])
    assert.strictEqual(plan.tasks.find(t=>t.id==='unrelated'),unrelated)
    assert.equal(JSON.stringify({input,dependencies}),copy)
    const next = planDependencyRemoval(plan.tasks, plan.dependencies, ['b-d'], options)
    assert.equal(next.tasks.find(t=>t.id==='d')?.start_date,at(1))
    assert.equal(next.tasks.find(t=>t.id==='e')?.start_date,at(2))
  })
  test(`last link collapses to removal time, keeps duration and propagates through summaries (${minute})`, () => {
    const {tasks, dependencies, at, make, options,unit} = fixture(minute)
    const input = [...tasks.map(t=>t.id==='d'?{...t,parent_id:'p'}:t.id==='e'?{...t,parent_id:'q'}:t),make('p',3,4),make('q',4,5),make('f',5,6)]
    const links = [...dependencies.filter(d=>d.id!=='d-e'), dep('p','e'), dep('q','f')].reverse()
    const plan = planDependencyRemoval(input,links,['a-d','b-d','c-d'],options)
    for(const [id,start,end] of [['d',-1,0],['p',-1,0],['e',0,1],['q',0,1],['f',1,2]] as const){
      const actual=plan.tasks.find(t=>t.id===id)!
      assert.equal(actual.start_date,at(start),id);assert.equal(actual.end_date,at(end),id);assert.equal(actual.duration,unit,id)
    }
    assert.deepEqual(plan.updatedTasks.map(t=>t.id).sort(),['d','e','f','p','q'])
  })
  test(`manual tasks stop collapse, including their unconstrained downstream branches (${minute})`, () => {
    const {tasks,dependencies,make,options,at}=fixture(minute)
    const input=tasks.map(t=>t.id==='d'?{...t,auto_schedule:false}:t.id==='e'?{...t,constraint_type:'muststarton',constraint_date:at(9)}:t)
    assert.deepEqual(planDependencyRemoval(input,dependencies,['a-d','b-d','c-d'],options).updatedTasks,[])
    const bridge=[...tasks.map(t=>t.id==='e'?{...t,auto_schedule:false}:t),make('f',5,6,{constraint_type:'muststarton',constraint_date:at(9)})]
    const plan=planDependencyRemoval(bridge,[...dependencies,dep('e','f')],['c-d'],options)
    assert.deepEqual(plan.updatedTasks.map(t=>t.id),['d'])
  })
  test(`last-link removal retains historical starts and advances milestones (${minute})`, () => {
    const {tasks,dependencies,at,options}=fixture(minute)
    const past=planDependencyRemoval(tasks,dependencies,['a-d','b-d','c-d'],{...options,removalDate:at(10)})
    assert.deepEqual(past.updatedTasks,[])
    const input=tasks.map(t=>t.id==='d'?{...t,is_milestone:true,end_date:t.start_date,duration:0}:t)
    const result=planDependencyRemoval(input,dependencies,['a-d','b-d','c-d'],options)
    const d=result.tasks.find(t=>t.id==='d')!
    assert.equal(d.start_date,at(-1));assert.equal(d.end_date,at(-1));assert.equal(d.duration,0)
    assert.equal(result.tasks.find(t=>t.id==='e')?.start_date,at(-1))
  })
  for(const [type,offset] of [[0,1],[1,0],[2,2],[3,1]]) for(const sign of [-1,1]) {
    test(`remaining type ${type} with signed lag ${sign} is respected (${minute})`,()=>{
      const {make,at,unit,options}=fixture(minute)
      const result=planDependencyRemoval([make('a',1,2),make('c',0,6),make('d',6,7)],
        [dep('a','d',{type,lag:sign*unit}),dep('c','d')],['c-d'],options)
      assert.equal(result.tasks.find(t=>t.id==='d')?.start_date,at(offset+sign))
      assert.equal(result.tasks.find(t=>t.id==='d')?.duration,unit)
    })
  }
}

test('hard constraints remain authoritative and downstream joins retain stronger predecessors',()=>{
  const {tasks,dependencies,at,make,options}=fixture()
  const input=tasks.map(t=>t.id==='d'?{...t,constraint_type:'startnoearlierthan',constraint_date:at(1)}:t.id==='e'?{...t,start_date:at(8),end_date:at(9)}:t)
  const result=planDependencyRemoval([...input,make('x',0,8)],[...dependencies,dep('x','e')],['a-d','b-d','c-d'],options)
  assert.equal(result.tasks.find(t=>t.id==='d')?.start_date,at(1))
  assert.equal(result.tasks.find(t=>t.id==='e')?.start_date,at(8))
  const fixed=tasks.map(t=>t.id==='d'?{...t,constraint_type:'muststarton',constraint_date:at(3)}:t)
  assert.deepEqual(planDependencyRemoval(fixed,dependencies,['a-d','b-d','c-d'],options).updatedTasks,[])
})

test('inactive, missing and ancestor links cannot trigger collapse; deleting again is idempotent',()=>{
  const {tasks,dependencies,options}=fixture()
  for(const links of [dependencies.map(d=>({...d,active:false})),dependencies.map(d=>({...d,from_task_id:'missing'}))])
    assert.deepEqual(planDependencyRemoval(tasks,links,links.map(d=>d.id),options).updatedTasks,[])
  const input=tasks.map(t=>t.id==='d'?{...t,parent_id:'c'}:t.id==='c'?{...t,inactive:true}:t)
  assert.deepEqual(planDependencyRemoval(input,dependencies,['c-d','b-d'],options).updatedTasks,[])
  const ancestorTasks=tasks.map(t=>t.id==='d'?{...t,parent_id:'c'}:t)
  assert.deepEqual(planDependencyRemoval(ancestorTasks,[dep('c','d')],['c-d'],options).updatedTasks,[])
  const plan=planDependencyRemoval(tasks,dependencies,['c-d'],options)
  assert.deepEqual(planDependencyRemoval(plan.tasks,plan.dependencies,['c-d'],options).updatedTasks,[])
})

test('link removal, cascades, preview metadata and save diff form one undoable operation',async()=>{
  const {tasks,dependencies,options}=fixture()
  const store=configureStore({reducer:rootReducer,middleware:get=>get().concat(createDraftMiddleware())})
  store.dispatch(setCurrentProject({id:'p',user_id:'u',name:'p',start_date:null,end_date:null,status_date:null,created_at:''}))
  store.dispatch(setTasks({tasks,dependencies}));store.dispatch(initializeDraft({projectId:'p',baseline:snapshotDraft(store.getState())}))
  const before=snapshotDraft(store.getState()), plan=planDependencyRemoval(tasks,dependencies,['c-d'],options)
  store.dispatch(labelDraftStep({label:'移除任务依赖',directTaskIds:['d']}));store.dispatch(removeDependency('c-d'))
  store.dispatch(updateTasks(plan.updatedTasks));store.dispatch(markDirty(plan.updatedTasks.map(t=>t.id)))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length,1)
  const after=snapshotDraft(store.getState())
  const diff=buildSaveDiff(before.tasks,before.dependencies,after.tasks,after.dependencies)
  assert.deepEqual(diff.depsToDelete,['c-d'])
  assert.deepEqual(diff.tasksToUpdate.map(t=>t.id).sort(),['d','e'])
  store.dispatch(undoDraft());assert.deepEqual(snapshotDraft(store.getState()),before)
  store.dispatch(redoDraft());assert.deepEqual(snapshotDraft(store.getState()),after)
})
