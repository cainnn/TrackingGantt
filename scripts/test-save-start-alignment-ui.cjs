// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-save-alignment-'));
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
async function main(){
 token=(await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT||'root',password:process.env.SAVE_TEST_PASSWORD||'root123'})).token;
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});page=await browser.newPage();await page.setViewport({width:1700,height:1050});await page.emulateTimezone('Asia/Shanghai');page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(90000);
 await page.evaluateOnNewDocument(()=>{const NativeDate=Date;window.__alignmentTestNow=NativeDate.parse('2030-01-01T01:17:00Z');window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.__alignmentTestNow]))}static now(){return window.__alignmentTestNow}}});
 page.on('pageerror',e=>errors.push(e.message));let allowSaveError=false;const expectedAlerts=[];page.on('dialog',async d=>{if(d.type()==='alert'){if(allowSaveError&&d.message().startsWith('保存失败'))expectedAlerts.push(d.message());else errors.push(d.message())}await d.accept()});
 for(const precision of ['day','minute']){
  const minute=precision==='minute',unit=minute?60:1440,anchor=minute?'2030-01-01T09:17:00':'2030-01-01T00:00:00';
  const at=n=>new Date(Date.parse(`${anchor}Z`)+n*unit*60000).toISOString().slice(0,19);
  const ids=Object.fromEntries(['a','b','p','c','q','d','manual','limited','past','inactive'].map(k=>[k,randomUUID()]));
  const make=(key,start,duration,parent=null,extra={})=>({id:ids[key],task_code:key,name:key.toUpperCase(),parent_id:parent?ids[parent]:null,order_index:Object.keys(ids).indexOf(key),start_date:at(start),end_date:at(start+duration),duration:duration*unit,duration_unit:precision,auto_schedule:true,constraint_type:'asap',...extra});
  const fixture=[make('a',3,2,'p'),make('b',5,5,'p'),make('p',3,7),make('c',10,1,'q'),make('q',10,1),make('d',11,1),make('manual',8,1,null,{auto_schedule:false}),make('limited',6,1,null,{constraint_type:'startnoearlierthan',constraint_date:at(6)}),make('past',-2,1),make('inactive',5,1,null,{inactive:true})];
  const project=await api('/projects','POST',{name:`保存排程提示-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,status_date:at(0),planning_status:'draft',use_template:false});projects.push(project.id);
  await api(`/tasks/${project.id}`,'POST',fixture.map(t=>({...t,parent_id:null})));
  for(const [from,to] of [['p','c'],['q','d']])await api(`/dependencies/${project.id}`,'POST',{from_task_id:ids[from],to_task_id:ids[to],type:2,lag:0});
  await api(`/tasks/${project.id}`,'PUT',fixture);
  await api(`/projects/${project.id}/view-preferences`,'PUT',{revision:0,views:[],currentView:{id:'current',name:'排程提示验收',search:'',columns:['assignee','start','end','duration','taskType','ctype'],colW:minute?480:28,critical:false,indicators:{deadlineDate:true,constraintDate:true},chart:{expanded:{[ids.p]:true,[ids.q]:true},filters:{},sortCol:null,sortDir:null,widths:{},nameWidth:170,panelWidth:900,panelCollapsed:false,rightCollapsed:false,centerTime:new Date(`${at(2)}+08:00`).getTime(),scrollTop:0}}});
  let before=await readPlan(project.id);await open(project);await editName(ids.a,'A 我的草稿');await button('保存');await page.waitForSelector(align);
  assert.match(await txt(align),/任务类型为“自动”、限制类型为“尽早”或“无”/);assert.match(await txt(align),/自动 \/ 尽早/);assert.equal(await page.$$eval('[data-save-start-task]',els=>els.length),6);
  for(const key of ['manual','limited','past','inactive'])assert.equal(await page.$(`[data-save-start-task="${ids[key]}"]`),null,key);
  assert.match(await txt(`[data-save-start-task="${ids.a}"]`),/2030-01-01/);assert.deepEqual(await readPlan(project.id),before,'preview must not write');
  await page.screenshot({path:path.join(output,`${precision}-alignment-preview.png`),fullPage:true});await button('返回编辑');assert.ok((await txt(cell(ids.a,'start'))).includes(minute?'12:17':'30-01-04'));assert.deepEqual(await readPlan(project.id),before);
  await button('保存');await page.waitForSelector(align);await page.keyboard.press('Escape');await page.waitForSelector(align,{hidden:true});assert.deepEqual(await readPlan(project.id),before,'Escape returns without saving');await button('保存');await page.waitForSelector(align);
  // A different writer commits while the schedule proposal is open. Keep the merge gate.
  await api(`/tasks/${project.id}`,'PUT',[{id:ids.b,assignee:'先提交的负责人'}]);const remote=await readPlan(project.id);await button('确认调整并继续保存');await page.waitForSelector(review);assert.match(await txt(review),/0 项冲突/);assert.deepEqual(await readPlan(project.id),remote,'alignment does not bypass concurrent-change confirmation');
  await button('应用并继续保存');await page.waitForSelector(review,{hidden:true});await saved();
  let result=await readPlan(project.id);
  for(const [key,start,duration] of [['a',0,2],['b',0,5],['p',0,5],['c',5,1],['q',5,1],['d',6,1],['manual',8,1],['limited',6,1],['past',-2,1],['inactive',5,1]]){const t=result.tasks.find(t=>t.id===ids[key]);assert.equal(t.start_date.slice(0,16),at(start).slice(0,16),key);assert.equal(t.end_date.slice(0,16),at(start+duration).slice(0,16),key);assert.equal(t.duration,duration*unit,key)}
  assert.equal(result.tasks.find(t=>t.id===ids.a).name,'A 我的草稿');assert.equal(result.tasks.find(t=>t.id===ids.b).assignee,'先提交的负责人');assert.deepEqual(result.dependencies,before.dependencies);assert.equal((await api(`/versions/${project.id}?list=1`)).length,0);
  await open(project);assert.ok((await txt(cell(ids.a,'start'))).includes(minute?'09:17':'30-01-01'));assert.deepEqual(await readPlan(project.id),result);
  console.log('PASS',precision,'explicit task/constraint reason, preview/cancel no writes, confirmed cascade, protected tasks, remote merge and persistence');
  // Before-write failure leaves a single undoable alignment step and permits retry.
  await api(`/tasks/${project.id}`,'PUT',fixture);await open(project);await editName(ids.a,'A 重试');before=await readPlan(project.id);await button('保存');await page.waitForSelector(align);
  let fail=true;allowSaveError=true;await page.setRequestInterception(true);const intercept=r=>{if(fail&&r.method()==='GET'&&r.url().includes('?save_state=1')){fail=false;return r.abort('internetdisconnected')}r.continue()};page.on('request',intercept);
  const previousAlerts=expectedAlerts.length;await button('确认调整并继续保存');await page.waitForSelector(align,{hidden:true});await page.waitForFunction(()=>!document.querySelector('[data-action=save-plan]')?.textContent.includes('保存中'));
  assert.equal(expectedAlerts.length,previousAlerts+1);assert.deepEqual(await readPlan(project.id),before);await button('撤销');assert.ok((await txt(cell(ids.a,'start'))).includes(minute?'12:17':'30-01-04'));assert.match(await txt(cell(ids.a)),/A 重试/);await button('重做');assert.ok((await txt(cell(ids.a,'start'))).includes(minute?'09:17':'30-01-01'));
  page.off('request',intercept);await page.setRequestInterception(false);allowSaveError=false;await button('保存');await saved();assert.equal(await page.$(align),null);assert.equal((await readPlan(project.id)).tasks.find(t=>t.id===ids.a).start_date.slice(0,16),at(0).slice(0,16));
  console.log('PASS',precision,'save failure preserves draft, alignment undo/redo and retry without repeated prompt');
  // Stable plans retain the existing reason review and snapshot after alignment.
  await api(`/tasks/${project.id}`,'PUT',fixture);await api(`/projects/${project.id}`,'PUT',{planning_status:'stable'});await open(project);await editName(ids.a,'A 稳定态');before=await readPlan(project.id);await button('确认变更');await page.waitForSelector(align);await button('确认调整并继续保存');await page.waitForSelector('[role="dialog"][aria-label="变更审核"]');assert.deepEqual(await readPlan(project.id),before);await reasonInputs();await button('确认并保存');await saved();
  const versions=await api(`/versions/${project.id}?list=1`);assert.equal(versions.length,1);const version=await api(`/versions/${project.id}?id=${versions[0].id}`);assert.equal(version.snapshot.tasks.find(t=>t.id===ids.a).start_date.slice(0,16),at(0).slice(0,16));assert.equal(version.snapshot.tasks.find(t=>t.id===ids.manual).start_date.slice(0,16),at(8).slice(0,16));
  console.log('PASS',precision,'stable review shows aligned draft before writes and snapshot matches persisted schedule');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`)});
