// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-live-layout-'));
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
async function refresh() {
  const done = page.waitForResponse(r => r.url().includes('?save_state=1') && r.request().method() === 'GET');
  await button('检查后台更新'); await done; await frame();
  await page.waitForFunction(() => !document.querySelector('[aria-label="检查后台更新"]').disabled);
}
async function main() {
 token=(await api('/auth/login','POST',{login:process.env.SAVE_TEST_ROOT||'root',password:process.env.SAVE_TEST_PASSWORD||'root123'})).token;
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
 async function newPage(){const ctx=await browser.createBrowserContext();const p=await ctx.newPage();await p.setViewport({width:1600,height:950});await p.emulateTimezone('Asia/Shanghai');p.setDefaultTimeout(25000);p.setDefaultNavigationTimeout(90000);p.on('pageerror',e=>errors.push(e.message));p.on('dialog',async d=>{if(d.type()==='alert')errors.push(d.message());await d.accept();});return p;}
 page=await newPage();
 for(const precision of ['day','minute']) {
  const unit=precision==='minute'?60:1440, at=n=>new Date(Date.UTC(2030,0,1,precision==='minute'?9:0)+n*unit*60000).toISOString().slice(0,19);
  const project=await api('/projects','POST',{name:`同步布局验收-${precision}-${randomUUID().slice(0,8)}`,time_granularity:precision,status_date:at(0),planning_status:'draft',use_template:false});projects.push(project.id);
  const a=randomUUID(),b=randomUUID();
  await api(`/tasks/${project.id}`,'POST',[a,b].map((id,i)=>({id,task_code:String(i+1),name:`任务 ${i?'B':'A'}`,order_index:i,start_date:at(0),end_date:at(1),duration:unit,duration_unit:precision,auto_schedule:true,constraint_type:'asap'})));
  const response=await fetch(`${base}/api/tasks/${project.id}?save_state=1`,{headers:{Authorization:`Bearer ${token}`}}),etag=response.headers.get('etag');assert.match(etag,/^"[a-f0-9]{64}"$/);
  const conditional=await fetch(response.url,{headers:{Authorization:`Bearer ${token}`,'If-None-Match':etag}});assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');
  assert.equal((await fetch(response.url,{headers:{'If-None-Match':etag}})).status,401);
  await open(project);
  let planWrites=0;const track=req=>{if(!['GET','HEAD'].includes(req.method())&&/\/api\/(tasks|dependencies|projects|project-lines|versions)\//.test(req.url())&&!req.url().includes('/view-preferences'))planWrites++;};page.on('request',track);
  const viewer=page;page=await newPage();await open(project);await editName(a,'另一个浏览器保存 A');await save();const writer=page;page=viewer;await page.bringToFront();
  await page.waitForFunction((sel)=>document.querySelector(sel)?.textContent.includes('另一个浏览器保存 A'),{},cell(a));
  assert.equal(await page.$eval('[data-action=save-plan]',e=>e.disabled),true);
  // With the viewer left untouched, the interval notices changes from another session.
  await api(`/tasks/${project.id}`,'PUT',[{id:b,name:'定时同步 B'}]);
  await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('定时同步 B'),{timeout:25000},cell(b));
  assert.equal(planWrites,0,'background sync is read-only');
  console.log('PASS',precision,'independent browser save/focus catch-up, periodic sync and authorized 304');
  // The task dialog has uncommitted state outside Redux; do not remount or overwrite it.
  await taskModal(a);await fill(`${modal} input`,'输入框里的草稿');
  await api(`/tasks/${project.id}`,'PUT',[{id:a,name:'编辑期间的后台 A'}]);await refresh();
  assert.equal(await page.$eval(`${modal} input`,e=>e.value),'输入框里的草稿');assert.ok(await page.$('[data-remote-plan-notice]'));
  await modalButton('取消');await refresh();assert.match(await txt(cell(a)),/编辑期间的后台 A/);
  // A held pointer also protects an in-progress drag even before Redux is changed.
  await page.evaluate(()=>document.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));
  await api(`/tasks/${project.id}`,'PUT',[{id:b,name:'拖动期间的后台 B'}]);await refresh();assert.match(await txt(cell(b)),/定时同步 B/);
  await page.evaluate(()=>document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})));await refresh();assert.match(await txt(cell(b)),/拖动期间的后台 B/);
  assert.equal(planWrites,0);
  // Dirty drafts stay visible; review uses the existing merge-and-save flow.
  await editName(b,'我的 B');page=writer;await open(project);await editName(a,'后台新 A');await save();page=viewer;await page.bringToFront();const beforeReview=await readPlan(project.id);await refresh();
  assert.match(await txt(cell(b)),/我的 B/);assert.match(await txt(cell(a)),/编辑期间的后台 A/);assert.ok(await page.$('[data-remote-plan-notice]'));
  assert.deepEqual(await readPlan(project.id),beforeReview);await button('保存');await page.waitForSelector(review);assert.deepEqual(await readPlan(project.id),beforeReview,'second editor cannot write before merge confirmation');await button('返回草稿');await button('核对后台更新');await page.waitForSelector(review);assert.match(await txt(review),/0 项冲突/);
  await button('应用并继续保存');await page.waitForSelector(review,{hidden:true});await page.waitForFunction(()=>document.querySelector('[data-action=save-plan]')?.disabled&&!document.querySelector('[data-action=save-plan]')?.textContent.includes('保存中'));
  const saved=await readPlan(project.id);assert.equal(saved.tasks.find(t=>t.id===a).name,'后台新 A');assert.equal(saved.tasks.find(t=>t.id===b).name,'我的 B');await refresh();assert.equal(await page.$('[data-remote-plan-notice]'),null);
  console.log('PASS',precision,'open editor and drag protection, dirty-draft preservation, second-browser submission prompts before writing, review and merged backend save');
  page.off('request',track);
  // Save from the new content footer, including error recovery. No plan write is needed.
  const settings='[role="dialog"][aria-label="显示设置"]';
  await page.setViewport({width:1500,height:720});await button('显示设置');await button('全不选');
  await page.$eval(`${settings} [role=tabpanel][aria-label="显示内容"]`,el=>[...el.querySelectorAll('label')].find(l=>l.textContent.trim()==='责任人').querySelector('input').click());await frame();
  await page.$eval(`${settings} [role=tabpanel][aria-label="显示内容"]`,el=>[...el.querySelectorAll('label')].find(l=>l.textContent.trim()==='限制日期'&&l.closest('section')?.textContent.includes('甘特图标记')).querySelector('input').click());await frame();
  const footer=await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='保存为常用布局');const r=b.getBoundingClientRect();return {bottom:r.bottom,height:window.innerHeight,visible:r.width>0};});assert.ok(footer.visible&&footer.bottom<=footer.height,'save footer fits short screens');
  await page.screenshot({path:path.join(output,`${precision}-save-footer.png`),fullPage:true});
  await button('保存为常用布局');await page.waitForSelector('input[aria-label="布局名称"]',{visible:true});assert.equal(await page.$eval(`${settings} [role=tab][aria-selected=true]`,e=>e.textContent.trim()),'常用布局');
  await fill('input[aria-label="布局名称"]',`常用-${precision}`);
  let fail=true;await page.setRequestInterception(true);const intercept=req=>{if(fail&&req.method()==='PUT'&&req.url().includes('/view-preferences')){fail=false;return req.abort('internetdisconnected');}return req.continue();};page.on('request',intercept);
  await button('保存布局');await page.waitForSelector(`${settings} [role=alert]`);assert.equal(await page.$eval('input[aria-label="布局名称"]',e=>e.value),`常用-${precision}`);
  assert.equal((await api(`/projects/${project.id}/view-preferences`)).views.length,0);
  const done=page.waitForResponse(r=>r.url().endsWith('/view-preferences')&&r.request().method()==='PUT'&&r.status()===200);await button('保存布局');await done;await page.waitForSelector('input[aria-label="布局名称"]',{hidden:true});
  page.off('request',intercept);await page.setRequestInterception(false);
  const prefs=await api(`/projects/${project.id}/view-preferences`);assert.equal(prefs.views.length,1);assert.equal(prefs.views[0].name,`常用-${precision}`);assert.deepEqual(prefs.views[0].columns,['assignee']);assert.equal(prefs.views[0].indicators.constraintDate,false);assert.equal(prefs.currentView.id,prefs.views[0].id);
  assert.deepEqual(await readPlan(project.id),saved,'layout save never changes the plan');
  await page.screenshot({path:path.join(output,`${precision}-saved-layout.png`),fullPage:true});await button('关闭显示设置');
  page=writer;await open(project);await page.bringToFront();assert.ok(await page.$(cell(a,'assignee')));assert.equal(await page.$(cell(a,'start')),null);
  await button('显示设置');await button('常用布局');assert.equal(await page.$eval('select[aria-label="已保存布局"]',e=>e.selectedOptions[0].textContent),`常用-${precision}`);await button('关闭显示设置');
  console.log('PASS',precision,'content-tab save footer, named layout retry, backend persistence and another browser restoration');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,projects:projects.length}));
}
main().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;})
.finally(async()=>{if(browser)await browser.close();for(const id of projects)await api(`/projects/${id}`,'DELETE').catch(e=>console.error('cleanup',e));console.log(`Cleaned ${projects.length} temporary projects. ${output}`);});
