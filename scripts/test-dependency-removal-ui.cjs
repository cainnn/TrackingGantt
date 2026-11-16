// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-dependency-removal-'));
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
async function scroll(index, id) { await page.$eval('[data-gantt-grid]', (el, index) => { el.scrollTop = index * 40; el.dispatchEvent(new Event('scroll')); }, index); await page.waitForSelector(cell(id)); await frame(); }
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
async function removeInModal(id, direction, name) {
  await taskModal(id); await modalButton(direction);
  await page.$eval(modal,(el,name)=>[...el.querySelectorAll('span.truncate')].find(s=>s.textContent===name).click(),name);await frame();
  await modalButton(`删除选中的${direction==='前置'?'前置':'后续'}关系`);
}
async function directDelete(project,id,revision) {
  return fetch(`${base}/api/dependencies/${project}`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(revision?{'x-gantt-plan-revision':revision}:{})},body:JSON.stringify({id}),signal:AbortSignal.timeout(30000)});
}
async function main() {
  token=(await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT||'root',password:process.env.SAVE_TEST_PASSWORD||'root123'})).token;
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});page=await browser.newPage();await page.setViewport({width:1900,height:1100});await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(90000);
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{if(/失败|冲突/.test(d.message()))errors.push(d.message());await d.accept();});
  for(const precision of ['day','minute']) {
    const minute=precision==='minute',unit=minute?60:1440;
    const at=n=>new Date(Date.UTC(2030,0,1,minute?9:0)+n*unit*60000).toISOString().slice(0,19);
    const display=n=>minute?at(n).slice(11,16):at(n).slice(2,10);
    const project=await api('/projects','POST',{name:`删除关系验收-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,planning_status:'draft',status_date:at(0),use_template:false});projects.push(project.id);
    const ids=Object.fromEntries(['a','b','c','p','d','q','e','f','m','n'].map(k=>[k,randomUUID()]));
    const make=(key,s,e,parent=null,order=0)=>({id:ids[key],name:key.toUpperCase(),parent_id:parent?ids[parent]:null,order_index:order,task_code:key,auto_schedule:key!=='m',constraint_type:'asap',start_date:at(s),end_date:at(e),duration:(e-s)*unit,duration_unit:precision});
    const fixture=[make('a',0,1,null,0),make('b',0,2,null,1),make('c',0,3,null,2),make('p',3,4,null,3),make('d',3,4,'p'),make('q',4,5,null,4),make('e',4,5,'q'),make('f',5,6,null,5),make('m',3,4,null,6),make('n',4,5,null,7)];
    await api(`/tasks/${project.id}`,'POST',fixture.map(t=>({...t,parent_id:null})));
    const links={};for(const [a,b] of [['a','d'],['b','d'],['c','d'],['p','e'],['q','f'],['c','m'],['m','n']]) links[`${a}-${b}`]=(await api(`/dependencies/${project.id}`,'POST',{from_task_id:ids[a],to_task_id:ids[b],type:2,lag:0})).dependency;
    // Imported/legacy plans can retain links on summaries. Establish links before hierarchy.
    await api(`/tasks/${project.id}`,'PUT',fixture);
    await api(`/projects/${project.id}/view-preferences`,'PUT',{revision:0,views:[],currentView:{id:'current',name:'删除依赖验收',search:'',columns:['start','end','duration','pred'],colW:minute?480:28,critical:false,indicators:{deadlineDate:true,constraintDate:true},chart:{expanded:{[ids.p]:true,[ids.q]:true},filters:{},sortCol:null,sortDir:null,widths:{},nameWidth:160,panelWidth:800,panelCollapsed:false,rightCollapsed:false,centerTime:new Date(`${at(2)}+08:00`).getTime(),scrollTop:0}}});
    const before=await readPlan(project.id);await open(project);
    async function collapsed(offset=2){for(const [key,n] of [['d',offset],['p',offset],['e',offset+1],['q',offset+1],['f',offset+2],['m',3],['n',4]]) assert.ok((await txt(cell(ids[key],'start'))).includes(display(n)),`${key}: ${await txt(cell(ids[key],'start'))} expected ${display(n)}`);}
    async function undo(){await button('撤销');assert.ok((await txt(cell(ids.d,'start'))).includes(display(3)));assert.deepEqual(await readPlan(project.id),before);}
    await removeInModal(ids.d,'前置','C');await modalButton('通用');assert.ok((await txt(modal)).includes(at(2).slice(0,minute?16:10).replace('T',' ')) || (await txt(modal)).includes(at(2).slice(0,10)));await modalButton('取消');await collapsed();await undo();
    await removeInModal(ids.c,'后续','D');await modalButton('取消');await collapsed();await undo();
    await page.$eval(cell(ids.d,'pred'),el=>el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})));await page.waitForSelector('[data-dependency-picker]');
    await page.$eval('[data-dependency-picker]',el=>[...el.querySelectorAll('[role=option]')].find(b=>b.querySelector('[title="C"]')).click());await button('关闭前置任务选择');await collapsed();await undo();
    await page.$eval(cell(ids.d),el=>{const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+30,clientY:r.y+20}));});await button('删除依赖关系');
    await page.$eval('[data-task-context-menu]',el=>[...el.querySelectorAll('button')].find(b=>b.textContent.includes('C → D')).click());await frame();await collapsed();await undo();
    const depSelector=`[data-dependency-id="${links['c-d'].id}"]`;
    await click(`${depSelector} path`);await page.evaluate(()=>{document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));});await frame();await collapsed();await undo();
    await click(`${depSelector} path`);await click(`${depSelector} circle`);await collapsed();await button('影响预览');assert.match(await txt(`[data-impact-task="${ids.d}"]`),/移除任务依赖/);assert.match(await txt(`[data-impact-task="${ids.f}"]`),/自动级联/);
    assert.deepEqual(await readPlan(project.id),before,'all removals remain draft-only');await page.screenshot({path:path.join(output,`${precision}-collapse.png`),fullPage:true});await save();
    let saved=await readPlan(project.id);assert.equal(saved.dependencies.some(d=>d.id===links['c-d'].id),false);assert.equal(saved.tasks.length,before.tasks.length);
    for(const [key,n] of [['d',2],['p',2],['e',3],['q',3],['f',4],['m',3],['n',4]]){const task=saved.tasks.find(t=>t.id===ids[key]);assert.equal(task.start_date.slice(0,16),at(n).slice(0,16));assert.equal(task.duration,unit);}
    await open(project);await collapsed();assert.deepEqual(await readPlan(project.id),saved);
    console.log('PASS',precision,'modal predecessor/successor, picker, context, Delete key and SVG remove: cascade through summaries, draft-only, undo, preview, save/reopen');
    // Removing the last predecessor releases D to the removal day/minute even with a future status date and summary start.
    await removeInModal(ids.d,'前置','B');await modalButton('取消');await collapsed(1);await save();
    const removalStart=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(' ','T').slice(0,minute?16:10);
    await removeInModal(ids.d,'前置','A');await modalButton('通用');
    const value=await page.$$eval(`${modal} label`,labels=>[...labels].find(l=>l.textContent.trim().startsWith('开始')).parentElement.querySelector('input').value);
    assert.equal(value.slice(0,10),removalStart.slice(0,10));await modalButton('保存');await page.waitForSelector(modal,{hidden:true});await save();saved=await readPlan(project.id);
    const d=saved.tasks.find(t=>t.id===ids.d);assert.equal(d.start_date.slice(0,10),removalStart.slice(0,10));assert.equal(d.duration,unit);
    if(minute)assert.ok(Math.abs(Date.parse(d.start_date.slice(0,16)+'Z')-Date.parse(removalStart+'Z'))<=60000);
    for(const [key,offset] of [['p',0],['e',1],['q',1],['f',2]])assert.equal(saved.tasks.find(t=>t.id===ids[key]).start_date.slice(0,16),new Date(Date.parse(d.start_date.slice(0,19)+'Z')+offset*unit*60000).toISOString().slice(0,16));
    await open(project);assert.deepEqual(await readPlan(project.id),saved);assert.ok((await txt(cell(ids.d,'start'))).includes(d.start_date.slice(2,10)));
    console.log('PASS',precision,'last-link anchor, form synchronization, unchanged duration and persisted summary cascade');
    // Direct API uses the same plan and revision lock, returns affected tasks, and is retry-safe.
    const {revision}=await api(`/tasks/${project.id}?save_state=1`);assert.match(revision,/^[a-f0-9]{64}$/);
    const response=await directDelete(project.id,links['p-e'].id,revision),result=await response.json();assert.ok(response.ok&&result.ok,JSON.stringify(result));
    assert.deepEqual(result.value.updatedTasks.map(t=>t.id).sort(),[ids.e,ids.q,ids.f].sort());const after=await readPlan(project.id);
    assert.equal(after.tasks.find(t=>t.id===ids.e).start_date.slice(0,10),removalStart.slice(0,10));assert.equal((await directDelete(project.id,links['q-f'].id,revision)).status,409);assert.deepEqual(await readPlan(project.id),after);
    const retry=await directDelete(project.id,links['p-e'].id,response.headers.get('x-gantt-plan-revision'));assert.equal(retry.status,200);assert.deepEqual(await readPlan(project.id),after);
    const manual=await directDelete(project.id,links['c-m'].id);assert.equal(manual.status,200);const final=await readPlan(project.id);
    for(const key of ['m','n'])assert.deepEqual(final.tasks.find(t=>t.id===ids[key]),after.tasks.find(t=>t.id===ids[key]));
    console.log('PASS',precision,'direct API collapse, stale DELETE conflict, idempotent retry and manual boundary');
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`);});
