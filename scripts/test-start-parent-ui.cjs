// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-start-parent-'));
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
async function inlineStart(id, value, keyboard = false) {
  await click(cell(id, 'start'));
  if (keyboard) await page.$eval('[data-gantt-grid]', el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
  else await page.$eval(cell(id, 'start'), el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  await page.waitForSelector(`${cell(id,'start')} input`); await fill(`${cell(id,'start')} input`, value);
  await page.$eval(`${cell(id,'start')} input`, el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await frame(); await page.waitForSelector(`${cell(id,'start')} input`, { hidden: true });
}
async function taskModal(id) { await click(cell(id)); await button('编辑任务'); await page.waitForSelector(modal); }
async function modalDate(field, value) {
  const h = await page.evaluateHandle(({modal, field}) => [...document.querySelectorAll(`${modal} label`)].find(l => l.textContent.trim().startsWith(field))?.parentElement.querySelector('input[type=text]'), {modal,field});
  assert.ok(h.asElement(), `${field} editable`);
  await h.evaluate((el,value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})); },value); await frame();
  await h.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))); await h.dispose(); await frame();
}
async function modalButton(label) { await page.$eval(modal, (el,label) => [...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label).click(),label); await frame(); }
async function save() { await button('保存'); await page.waitForFunction(()=>{const b=document.querySelector('[data-action=save-plan]');return b?.disabled && b.textContent.trim()==='保存';}); }
async function main() {
  token = (await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT || 'root',password:process.env.SAVE_TEST_PASSWORD || 'root123'})).token;
  browser = await puppeteer.launch({headless:true,args:['--no-sandbox']}); page = await browser.newPage(); await page.setViewport({width:1800,height:1080}); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  // All fixture roots already started, even though their finish may be in the
  // future. Editing an automatic root must not require a mode change or repair.
  await page.evaluateOnNewDocument(() => {
    const NativeDate = Date;
    const now = NativeDate.parse('2030-01-03T01:17:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  });
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',async d=>{if(/失败|冲突/.test(d.message()))errors.push(d.message());await d.accept();});
  for(const precision of ['day','minute']) {
    const minute=precision==='minute',unit=minute?60:1440;
    const at=n=>new Date(Date.UTC(2030,0,1,minute?9:0)+n*unit*60000).toISOString().slice(0,19);
    const input=n=>at(n).slice(0,minute?16:10).replace('T',' ');
    const project=await api('/projects','POST',{name:`日期与父任务验收-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,planning_status:'draft',status_date:at(0),use_template:false});projects.push(project.id);
    const ids=Object.fromEntries(['before','beforeChild','g','p','c','d','n','x','left','right','after','inactive'].map(k=>[k,randomUUID()]));
    const make=(key,name,parent,order,start=0,end=1)=>({id:ids[key],name,parent_id:parent?ids[parent]:null,order_index:order,task_code:key,auto_schedule:true,constraint_type:'asap',start_date:at(start),end_date:at(end),duration:(end-start)*unit,duration_unit:precision,note:`保留-${key}`});
    await api(`/tasks/${project.id}`,'POST',[
      make('before','前方任务',null,0),make('beforeChild','前方子任务','before',0),make('g','祖父 G',null,1,0,14),make('p','父任务 P','g',1,0,14),make('after','后方任务',null,2),
      make('left','同级 L','g',0),make('right','同级 R','g',2),make('c','立项批复 C','p',0,0,13),make('d','后续 D','p',1,13,14),
      make('n','嵌套 N','p',2),make('x','孙任务 X','n',0),make('inactive','停用依赖任务',null,3)]);
    await api(`/dependencies/${project.id}`,'POST',{from_task_id:ids.c,to_task_id:ids.d,type:2,lag:0});
    await api(`/dependencies/${project.id}`,'POST',{from_task_id:ids.c,to_task_id:ids.inactive,type:2,lag:0,active:false});
    await api(`/projects/${project.id}/view-preferences`,'PUT',{revision:0,views:[],currentView:{id:'current',name:'编辑验收布局',search:'',columns:['start','end','duration','pred'],colW:minute?480:28,critical:false,indicators:{deadlineDate:true,constraintDate:true},chart:{expanded:{[ids.g]:true,[ids.p]:true,[ids.n]:true},filters:{},sortCol:null,sortDir:null,widths:{},nameWidth:200,panelWidth:850,panelCollapsed:false,rightCollapsed:false,centerTime:new Date(`${at(0)}+08:00`).getTime(),scrollTop:0}}});
    const before=await readPlan(project.id);await open(project);
    const toggle = `[data-task-toggle="${ids.p}"]`;
    const box = await page.$eval(toggle, el => { const r=el.getBoundingClientRect(); return {width:r.width,height:r.height}; });
    assert.ok(box.width >= 28 && box.height >= 28);
    // Real mouse events include mousedown: toggling must not start a row drag.
    await page.click(toggle);await page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-expanded')==='false',{},toggle);
    assert.equal(await page.$(cell(ids.c)),null);
    await page.click(toggle);await page.waitForSelector(cell(ids.c));
    await page.click(toggle,{count:2,delay:30});await frame();
    assert.equal(await page.$(`${cell(ids.p)} input`),null,'double clicking the toggle does not rename its task');
    assert.equal(await page.$eval(toggle,el=>el.getAttribute('aria-expanded')),'true');
    await page.focus(toggle);await page.keyboard.press('Space');await frame();
    assert.equal(await page.$(cell(ids.c)),null);
    await page.keyboard.press('Enter');await page.waitForSelector(cell(ids.c));
    assert.equal(await page.$eval('[data-action=save-plan]',b=>b.disabled),true,'expansion never edits the saved plan');
    assert.deepEqual(await readPlan(project.id),before);
    await button('修复排程');assert.equal(await page.$$eval('[data-repair-task]',els=>els.length),0);await button('取消');
    console.log('PASS',precision,'larger parent toggle supports mouse and keyboard without rename, drag or unsaved edits; historical auto roots need no repair');
    await inlineStart(ids.c,input(-1));assert.match(await txt(cell(ids.c,'start')),minute?/08:00/:/29-12-31/);
    await button('撤销');await inlineStart(ids.c,input(-2),true);
    assert.deepEqual(await readPlan(project.id),before,'inline edits remain local');
    await taskModal(ids.c);await modalDate('开始',input(-3));
    assert.equal(await page.$eval(`${modal} input[type=number]`,el=>Number(el.value)),16*unit/(minute?1:1440));
    await modalDate('结束',input(-4));await modalButton('保存');
    assert.match(await txt(modal),/开始日期不能晚于结束日期/);
    await modalDate('结束',input(14));await modalButton('保存');await page.waitForSelector(modal,{hidden:true});
    await button('影响预览');assert.match(await txt(`[data-impact-task="${ids.d}"]`),/自动级联/);
    await save();let saved=await readPlan(project.id);
    const c=saved.tasks.find(t=>t.id===ids.c),d=saved.tasks.find(t=>t.id===ids.d);
    assert.equal(c.start_date.slice(0,16),at(-3).slice(0,16));assert.equal(c.end_date.slice(0,16),at(14).slice(0,16));assert.equal(c.duration,17*unit);assert.equal(c.auto_schedule,true);
    assert.equal(d.start_date.slice(0,16),at(14).slice(0,16));assert.equal(d.duration,unit);
    await button('修复排程');assert.equal(await page.$$eval('[data-repair-task]',els=>els.length),0);await button('取消');
    assert.deepEqual(await readPlan(project.id),saved,'editing a historical auto start does not schedule it to today');
    await inlineStart(ids.c,input(20));assert.match(await txt('body'),/本次日期修改未应用/);
    assert.deepEqual(await readPlan(project.id),saved);
    await click(cell(ids.d,'start'));await page.$eval(cell(ids.d,'start'),el=>el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})));await frame();
    assert.equal(await page.$(`${cell(ids.d,'start')} input`),null);assert.match(await txt('body'),/开始日期由前置依赖决定/);
    await taskModal(ids.d);assert.equal(await page.$$eval(`${modal} label`,labels=>[...labels].find(l=>l.textContent.trim().startsWith('开始')).parentElement.querySelector('input')===null),true);await modalButton('取消');
    await taskModal(ids.inactive);await modalButton('前置');
    assert.equal(await page.$eval(`${modal} input[type=checkbox]`,el=>el.checked),false);
    await page.$eval(`${modal} input[type=checkbox]`,el=>el.click());await frame();await modalButton('通用');
    assert.equal(await page.$$eval(`${modal} label`,labels=>[...labels].find(l=>l.textContent.trim().startsWith('开始')).parentElement.querySelector('input')===null),true,'pending activation locks its controlled start');
    await modalButton('前置');await page.$eval(`${modal} input[type=checkbox]`,el=>el.click());await frame();await modalButton('通用');
    assert.equal(await page.$$eval(`${modal} label`,labels=>!![...labels].find(l=>l.textContent.trim().startsWith('开始')).parentElement.querySelector('input')),true);
    await modalButton('取消');
    await inlineStart(ids.inactive,input(-1));await save();await open(project);
    assert.match(await txt(cell(ids.c,'start')),minute?/06:00/:/29-12-29/);
    await page.screenshot({path:path.join(output,`${precision}-date-edit.png`),fullPage:true});
    console.log('PASS',precision,'unlinked auto start: double click/F2/modal, range guard, cascade, save/reopen; active dependencies remain locked');

    saved=await readPlan(project.id);
    // Filter out the children, then delete only their visible parent via context menu.
    await fill('input[placeholder="搜索任务..."]','父任务 P');
    await page.$eval(cell(ids.p),(el)=>{const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+50,clientY:r.y+20}));});
    await page.waitForSelector('[data-task-context-menu]');await button('仅删除父任务（保留子任务）');
    await fill('input[placeholder="搜索任务..."]','');await page.waitForSelector(cell(ids.c));
    assert.equal(await page.$(cell(ids.p)),null);assert.ok(await page.$(cell(ids.x)));
    assert.deepEqual(await readPlan(project.id),saved,'parent-only deletion remains local');
    await button('影响预览');assert.match(await txt(`[data-impact-task="${ids.c}"]`),/删除父任务后保留.*祖父 G/);
    await button('撤销最近一步');await page.waitForSelector(cell(ids.p));await button('重做');await save();
    let plan=await readPlan(project.id);
    assert.equal(plan.tasks.some(t=>t.id===ids.p),false);
    assert.deepEqual(plan.tasks.filter(t=>t.parent_id===ids.g).sort((a,b)=>a.order_index-b.order_index).map(t=>t.id),['left','c','d','n','right'].map(k=>ids[k]));
    assert.equal(plan.tasks.find(t=>t.id===ids.x).parent_id,ids.n);assert.deepEqual(plan.dependencies,saved.dependencies);
    for(const id of [ids.c,ids.d,ids.n,ids.x]){const old=saved.tasks.find(t=>t.id===id),now=plan.tasks.find(t=>t.id===id);assert.equal(now.start_date,old.start_date);assert.equal(now.end_date,old.end_date);assert.equal(now.note,old.note);}
    // Toolbar offers the same action for a top-level parent.
    await click(cell(ids.g));await button('任务操作');await button('仅删除父任务（保留子任务）');await save();
    plan=await readPlan(project.id);
    const expected=['before','left','c','d','n','right','after','inactive'].map(k=>ids[k]);
    assert.deepEqual(plan.tasks.filter(t=>!t.parent_id).sort((a,b)=>a.order_index-b.order_index).map(t=>t.id),expected);
    assert.equal(plan.tasks.find(t=>t.id===ids.x).parent_id,ids.n);assert.deepEqual(plan.dependencies,saved.dependencies);
    await open(project);assert.equal(await page.$(cell(ids.g)),null);assert.equal(await page.$(cell(ids.p)),null);assert.ok(await page.$(cell(ids.x)));
    assert.deepEqual(await readPlan(project.id),plan);
    await page.screenshot({path:path.join(output,`${precision}-parent-only.png`),fullPage:true});
    console.log('PASS',precision,'context/toolbar parent-only deletion: hidden children, nested hierarchy, sibling order, dependency retention, undo/redo and saved reopen');

    // Direct API callers also retain child order, with and without confirmed-save headers.
    for(const confirmed of [false,true]) {
      const response=await fetch(`${base}/api/tasks/${project.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(confirmed?{'x-gantt-confirmed-save':'1'}:{})},body:JSON.stringify({ids:[confirmed?ids.before:ids.n]}),signal:AbortSignal.timeout(30000)});
      const result=await response.json();assert.ok(response.ok&&result.ok,JSON.stringify(result));
      const actual=await readPlan(project.id);
      if(!confirmed)assert.deepEqual(actual.tasks.filter(t=>!t.parent_id).sort((a,b)=>a.order_index-b.order_index).map(t=>t.id),['before','left','c','d','x','right','after','inactive'].map(k=>ids[k]));
      else assert.deepEqual(actual.tasks.filter(t=>!t.parent_id).sort((a,b)=>a.order_index-b.order_index).map(t=>t.id),['beforeChild','left','c','d','x','right','after','inactive'].map(k=>ids[k]));
      assert.equal(actual.tasks.find(t=>t.id===ids.x).parent_id,null);assert.deepEqual(actual.dependencies,saved.dependencies);
    }
    console.log('PASS',precision,'API parent deletion retains promoted ordering and dependencies');
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`);});
