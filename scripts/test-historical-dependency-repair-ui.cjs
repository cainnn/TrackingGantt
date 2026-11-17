// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-dependency-priority-'));
const projects = [], errors = []; let token, browser, page;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', 'x-gantt-confirmed-save': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
const cell = (id, col = 'name') => `[data-task-cell="${id}"][data-col="${col}"]`;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(selector, extra = {}) { await page.$eval(selector, (el, extra) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...extra })), extra); await frame(); }
async function button(label) {
  const find = label => [...document.querySelectorAll('button')].find(b => !b.disabled && b.getClientRects().length && (b.textContent.trim() === label || (b.getAttribute('role') === 'menuitem' && b.querySelector('span')?.textContent === label) || b.getAttribute('aria-label') === label || b.title === label || ((label === '撤销' || label === '重做') && b.title.startsWith(label))));
  await page.waitForFunction(find, {}, label); const h = await page.evaluateHandle(find, label); await h.evaluate(el => el.click()); await h.dispose(); await frame();
}
async function fill(selector, value) { await page.$eval(selector, (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value); await frame(); }
async function open(project) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
  await fill('input[type=text]', process.env.SAVE_TEST_ROOT || 'root'); await fill('input[type=password]', process.env.SAVE_TEST_PASSWORD || 'root123'); await button('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
  // Project preferences arrive separately and restore scroll over two frames.
  await page.waitForNetworkIdle({ idleTime: 150 }); await frame();
}
const modal = '[role="dialog"][aria-label="编辑任务"]';
const canonical = plan => ({ ...plan, tasks: [...plan.tasks].sort((a,b)=>a.id.localeCompare(b.id)), dependencies: [...plan.dependencies].sort((a,b)=>a.id.localeCompare(b.id)) });
const readPlan = async id => canonical(await api(`/tasks/${id}`));
const txt = selector => page.$eval(selector, el => el.textContent.trim());
async function taskModal(id) { await click(cell(id)); await button('编辑任务'); await page.waitForSelector(modal); }
async function modalButton(label) { await page.$eval(modal, (el,label) => [...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label).click(),label); await frame(); }
async function save() { await button('保存'); await page.waitForFunction(()=>{const b=document.querySelector('[data-action=save-plan]');return b?.disabled && b.textContent.trim()==='保存';}); }
const review='[role="dialog"][aria-label="核对后台变更"]';
async function editName(id,name){await taskModal(id);await fill(`${modal} input`,name);await modalButton('保存');await page.waitForSelector(modal,{hidden:true});}

const align='[role="dialog"][aria-label="保存前排程提示"]';
async function saved(){await page.waitForFunction(()=>{const b=document.querySelector('[data-action=save-plan]');return b?.disabled&&!b.textContent.includes('保存中')});await frame();}
async function reasonInputs(){await page.$$eval('[role="dialog"][aria-label="变更审核"] textarea',els=>els.forEach(el=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'按任务类型和限制类型对齐无前置任务');el.dispatchEvent(new Event('input',{bubbles:true}))}));await frame();}
async function main() {
 token=(await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT||'root',password:process.env.SAVE_TEST_PASSWORD||'root123'})).token;
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});page=await browser.newPage();await page.setViewport({width:1800,height:1080});await page.emulateTimezone('Asia/Shanghai');page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);
 await page.evaluateOnNewDocument(()=>{const NativeDate=Date;const now=NativeDate.parse('2030-01-15T01:17:00Z');window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{errors.push(d.message());await d.accept()});
 for(const precision of ['day','minute']) {
  const minute=precision==='minute', status=minute?'stable':'draft';
  const at=day=>`2030-01-${String(day).padStart(2,'0')}T${minute?'09:15':'00:00'}:00`;
  const ids=Object.fromEntries(['a','parent','b','lag','next','survey','manual','future','inactive'].map(k=>[k,randomUUID()]));
  const make=(key,start,end,extra={})=>({id:ids[key],task_code:key,name:key==='survey'?'工程勘察':key.toUpperCase(),parent_id:null,order_index:Object.keys(ids).indexOf(key),start_date:at(start),end_date:at(end),duration:(end-start)*1440,duration_unit:precision,auto_schedule:true,constraint_type:'asap',...extra});
  const fixture=[make('a',1,2),make('parent',5,7),make('b',5,7,{parent_id:ids.parent}),make('lag',5,7),make('next',8,10),make('survey',1,3),make('manual',5,7,{auto_schedule:false}),make('future',20,22),make('inactive',5,7,{inactive:true})];
  const project=await api('/projects','POST',{name:`历史依赖优先-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,status_date:at(15),planning_status:status,use_template:false});projects.push(project.id);
  await api(`/tasks/${project.id}`,'POST',fixture.map(task=>({...task,parent_id:null})));
  for(const [from,to,lag] of [['a','b',0],['a','lag',1440],['parent','next',0],['a','manual',0],['a','inactive',0]])await api(`/dependencies/${project.id}`,'POST',{from_task_id:ids[from],to_task_id:ids[to],type:2,lag});
  // Restore the saved inconsistency after dependency creation has scheduled it.
  await api(`/tasks/${project.id}`,'PUT',fixture);
  await api(`/projects/${project.id}/view-preferences`,'PUT',{revision:0,views:[],currentView:{id:'current',name:'历史依赖修复验收',search:'',columns:['start','end','duration','taskType','pred'],colW:minute?480:28,critical:false,indicators:{deadlineDate:true,constraintDate:true},chart:{expanded:{[ids.parent]:true},filters:{},sortCol:null,sortDir:null,widths:{},nameWidth:200,panelWidth:900,panelCollapsed:false,rightCollapsed:false,centerTime:new Date(`${at(5)}+08:00`).getTime(),scrollTop:0}}});
  if(minute)await api(`/projects/${project.id}`,'PUT',{planning_status:'stable'});
  const before=await readPlan(project.id);assert.equal(before.tasks.find(t=>t.id===ids.b).start_date.slice(0,16),at(5).slice(0,16));await open(project);
  assert.equal(await page.$eval('[data-action=save-plan]',b=>b.disabled),true);
  await button('排程检查');await page.waitForSelector('[aria-label="排程检查"]');
  assert.equal(await page.$$eval('[data-schedule-issue="dependency-schedule"]',els=>els.length),3);
  assert.equal(await page.$$eval('[data-schedule-issue="unlinked-start"]',els=>els.length),1);
  await button('预览修复尽早任务');await page.waitForSelector('[aria-label="任务检查与修复"]');
  assert.equal(await page.$$eval('[data-repair-task]',els=>els.length),5);
  assert.match(await txt(`[data-repair-task="${ids.b}"]`),/按前置依赖/);
  assert.match(await txt(`[data-repair-task="${ids.b}"]`),/2030-01-02/);
  assert.match(await txt(`[data-repair-task="${ids.lag}"]`),/2030-01-03/);
  for(const key of ['a','survey','manual','inactive'])assert.equal(await page.$(`[data-repair-task="${ids[key]}"]`),null,key);
  await page.screenshot({path:path.join(output,`${precision}-historical-dependency-preview.png`),fullPage:true});
  await button('取消');assert.deepEqual(await readPlan(project.id),before);
  await button('修复排程');await button('修复 4 个任务');await button('撤销');assert.match(await txt(cell(ids.b,'start')),/30-01-05/);await button('重做');assert.match(await txt(cell(ids.b,'start')),/30-01-02/);
  assert.deepEqual(await readPlan(project.id),before,'preview, apply and undo/redo do not save');
  await button(minute?'确认变更':'保存');
  if(minute){await page.waitForSelector('[role="dialog"][aria-label="变更审核"]');await reasonInputs();await button('确认并保存')}
  await saved();const after=await readPlan(project.id);
  for(const [key,start,end] of [['b',2,4],['parent',2,4],['lag',3,5],['next',4,6]]){
   const t=after.tasks.find(t=>t.id===ids[key]);assert.equal(t.start_date.slice(0,16),at(start).slice(0,16),key);assert.equal(t.end_date.slice(0,16),at(end).slice(0,16),key);assert.equal(t.duration,2880);assert.equal(t.auto_schedule,true);
  }
  for(const key of ['a','survey','manual','inactive']){
   const previous=before.tasks.find(t=>t.id===ids[key]),actual=after.tasks.find(t=>t.id===ids[key]);
   // Stable saves refresh progress and previous-version finish for every task.
   if(minute){assert.ok(Date.parse(actual.updated_at)>=Date.parse(previous.updated_at));assert.deepEqual({...actual,updated_at:previous.updated_at},{...previous,percent_done:100,baseline_end_date:previous.end_date},key)}
   else assert.deepEqual(actual,previous,key);
  }
  assert.equal(after.tasks.find(t=>t.id===ids.future).start_date.slice(0,16),`2030-01-15T${minute?'09:17':'00:00'}`);
  assert.deepEqual(after.dependencies,before.dependencies);
  const versions=await api(`/versions/${project.id}?list=1`);assert.equal(versions.length,minute?1:0);
  if(minute){const version=await api(`/versions/${project.id}?id=${versions[0].id}`);assert.equal(version.snapshot.tasks.find(t=>t.id===ids.b).start_date.slice(0,16),at(2).slice(0,16))}
  await open(project);assert.deepEqual(await readPlan(project.id),after);await button('修复排程');assert.equal(await page.$$eval('[data-repair-task]',els=>els.length),0);await button('取消');
  await button('排程检查');assert.equal(await page.$$eval('[data-schedule-issue]',els=>els.length),0);await button('关闭排程检查');
  console.log('PASS',precision,'saved historical successors use predecessor finish (2nd), one-day lag (3rd), summary cascade, cancel, undo/redo, save/reload; unlinked survey, manual/inactive dates and dependencies preserved');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`)});
