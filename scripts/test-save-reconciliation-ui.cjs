// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-save-reconciliation-'));
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
const review='[role="dialog"][aria-label="核对后台变更"]';
async function editName(id,name){await taskModal(id);await fill(`${modal} input`,name);await modalButton('保存');await page.waitForSelector(modal,{hidden:true});}
async function editEnd(id,value){await taskModal(id);const input=await page.evaluateHandle(modal=>[...document.querySelectorAll(`${modal} label`)].find(l=>l.textContent.trim().startsWith('结束')).parentElement.querySelector('input'),modal);assert.ok(input.asElement());await input.evaluate((el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));},value);await frame();await input.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await frame();await modalButton('保存');await page.waitForSelector(modal,{hidden:true});}
async function choice(key,side){await click(`[data-save-difference="${key}"] input[value="${side}"]`);}
async function main(){
 token=(await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT||'root',password:process.env.SAVE_TEST_PASSWORD||'root123'})).token;
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});page=await browser.newPage();await page.setViewport({width:1700,height:1050});await page.emulateTimezone('Asia/Shanghai');page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(90000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{if(d.type()==='alert')errors.push(d.message());await d.accept();});
 for(const precision of ['day','minute']){
  const minute=precision==='minute',unit=minute?60:1440,at=n=>new Date(Date.UTC(2030,0,1,minute?9:0)+n*unit*60000).toISOString().slice(0,19);
  const project=await api('/projects','POST',{name:`冲突核对验收-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,status_date:at(0),planning_status:'draft',use_template:false});projects.push(project.id);
  const ids={a:randomUUID(),b:randomUUID(),x:randomUUID()};
  const make=(key,name,order)=>({id:ids[key],task_code:String(order+1),name,parent_id:null,order_index:order,start_date:at(0),end_date:at(1),duration:unit,duration_unit:precision,auto_schedule:true,constraint_type:'asap'});
  await api(`/tasks/${project.id}`,'POST',[make('a','任务 A',0),make('b','任务 B',1)]);
  await api(`/projects/${project.id}/view-preferences`,'PUT',{revision:0,views:[],currentView:{id:'current',name:'冲突验收',search:'',columns:['assignee','start','end','duration'],colW:minute?480:28,critical:false,indicators:{deadlineDate:true,constraintDate:true},chart:{expanded:{},filters:{},sortCol:null,sortDir:null,widths:{},nameWidth:180,panelWidth:900,panelCollapsed:false,rightCollapsed:false,centerTime:new Date(`${at(0)}+08:00`).getTime(),scrollTop:0}}});
  await open(project);await editName(ids.a,'我的 A');await api(`/tasks/${project.id}`,'PUT',[{id:ids.a,assignee:'后台责任人'},{id:ids.b,name:'后台 B'}]);await api(`/tasks/${project.id}`,'POST',[make('x','后台新增 X',2)]);
  const beforeMerge=await readPlan(project.id);await button('保存');await page.waitForSelector(review);assert.match(await txt(review),/0 项冲突/);assert.match(await txt(review),/后台新增 X/);assert.deepEqual(await readPlan(project.id),beforeMerge,'no write before explicit merge confirmation');
  await button('应用并继续保存');await page.waitForSelector(review,{hidden:true});await page.waitForFunction(()=>document.querySelector('[data-action=save-plan]')?.disabled&&!document.querySelector('[data-action=save-plan]')?.textContent.includes('保存中'));
  let saved=await readPlan(project.id),remote;assert.equal(saved.tasks.find(t=>t.id===ids.a).name,'我的 A');assert.equal(saved.tasks.find(t=>t.id===ids.a).assignee,'后台责任人');assert.equal(saved.tasks.find(t=>t.id===ids.b).name,'后台 B');assert.equal(saved.tasks.length,3);await open(project);assert.deepEqual(await readPlan(project.id),saved);
  console.log('PASS',precision,'disjoint changes and unseen additions require visible merge confirmation before any write');
  await editName(ids.a,'我最终的 A');await editEnd(ids.a,at(2).slice(0,minute?16:10).replace('T',' '));
  await api(`/tasks/${project.id}`,'PUT',[{id:ids.a,name:'他人的 A',start_date:at(3),end_date:at(4),duration:unit}]);remote=await readPlan(project.id);
  await button('保存');await page.waitForSelector(review);assert.match(await txt(review),/2 项冲突，2 项待选择/);
  assert.equal(await page.$eval(review,el=>[...el.querySelectorAll('button')].find(b=>b.textContent==='应用到草稿').disabled),true);
  await button('返回草稿');assert.equal(await page.$eval('button[title^="撤销"]',el=>el.disabled),false);await button('撤销');await button('重做');await button('保存');await page.waitForSelector(review);
  await choice(`tasks:${ids.a}:name`,'local');await choice(`tasks:${ids.a}:start_date`,'remote');
  // Race while the review is open: choices must be revalidated before accepting a new baseline.
  await api(`/tasks/${project.id}`,'PUT',[{id:ids.b,note:'核对时的另一笔修改'}]);remote=await readPlan(project.id);await button('应用到草稿');await page.waitForFunction(review=>document.querySelector(review)?.textContent.includes('后台再次更新'),{},review);
  assert.match(await txt(review),/2 项待选择/);assert.deepEqual(await readPlan(project.id),remote);
  await choice(`tasks:${ids.a}:name`,'local');await choice(`tasks:${ids.a}:start_date`,'remote');await page.screenshot({path:path.join(output,`${precision}-competing.png`),fullPage:true});await button('应用到草稿');await page.waitForSelector(review,{hidden:true});
  assert.match(await txt(cell(ids.a)),/我最终的 A/);assert.ok((await txt(cell(ids.a,'start'))).includes(minute?'12:00':'30-01-04'));assert.deepEqual(await readPlan(project.id),remote);
  await button('撤销');assert.match(await txt(cell(ids.a)),/他人的 A/);await button('重做');assert.match(await txt(cell(ids.a)),/我最终的 A/);await save();saved=await readPlan(project.id);
  const a=saved.tasks.find(t=>t.id===ids.a);assert.equal(a.name,'我最终的 A');assert.equal(a.start_date.slice(0,16),at(3).slice(0,16));assert.equal(a.end_date.slice(0,16),at(4).slice(0,16));assert.equal(a.duration,unit);assert.equal(saved.tasks.find(t=>t.id===ids.b).note,'核对时的另一笔修改');await open(project);assert.deepEqual(await readPlan(project.id),saved);
  console.log('PASS',precision,'competing name/schedule choices, changed remote revision resets review, undo boundary and persisted merged values');
  await editName(ids.x,'保留本地 X');await api(`/tasks/${project.id}`,'DELETE',{ids:[ids.x]});remote=await readPlan(project.id);
  await button('保存');await page.waitForSelector(review);assert.match(await txt(review),/1 项冲突，1 项待选择/);await button('冲突项全部保留我的修改');await button('应用并继续保存');await page.waitForSelector(review,{hidden:true});await page.waitForFunction(()=>document.querySelector('[data-action=save-plan]')?.disabled&&!document.querySelector('[data-action=save-plan]')?.textContent.includes('保存中'));saved=await readPlan(project.id);assert.equal(saved.tasks.find(t=>t.id===ids.x).name,'保留本地 X');assert.equal(saved.tasks.length,3);await open(project);assert.deepEqual(await readPlan(project.id),saved);
  console.log('PASS',precision,'remote deletion versus local edit: explicit retain choice restores the intended task only when saved');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`);});
