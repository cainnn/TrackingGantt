// Actual API/database and browser regression. Only this run's temporary projects are modified.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3138';
const login = process.env.DELETE_TEST_USER || 'root', password = process.env.DELETE_TEST_PASSWORD || 'root123';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-delete-relations-'));
const projects = [], errors = [];
let token, browser, page;
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
const current = minute => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${minute ? parts.hour + ':' + parts.minute : '00:00'}:00`;
};
async function api(route, method = 'GET', body, confirmed = true) {
  const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(confirmed ? { 'x-gantt-confirmed-save': '1' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${data.error || response.status}`); return data.value;
}
const addMinutes = (date, minutes) => { const d = new Date(date); d.setMinutes(d.getMinutes() + minutes); const n = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${n(d.getMonth()+1)}-${n(d.getDate())}T${n(d.getHours())}:${n(d.getMinutes())}:00`; };
async function fixture(precision, label) {
  const minute = precision === 'minute', start = minute ? '2030-01-01T09:15:00' : '2030-01-01T00:00:00', duration = minute ? 90 : 1440;
  const project = await api('/projects', 'POST', { name: `删除依赖验收-${label}-${precision}-${randomUUID().slice(0,8)}`, status_date: '2025-01-01', start_date: '2025-01-01', time_granularity: precision, use_template: false });
  projects.push(project);
  const ids = Object.fromEntries(['a','b','c','d','e','f','g','h'].map(key => [key, randomUUID()]));
  await api(`/tasks/${project.id}`, 'POST', Object.entries(ids).map(([key,id], index) => ({ id, task_code: String(index+1), name: `任务${key}`, parent_id: null, order_index: index,
    auto_schedule: !['a','e'].includes(key), constraint_type: 'asap', start_date: addMinutes(start, ({a:0,b:1,c:2,d:3,e:0,f:1,g:2,h:2})[key]*duration),
    end_date: addMinutes(start, (({a:0,b:1,c:2,d:3,e:0,f:1,g:2,h:2})[key]+1)*duration), duration, duration_unit: minute ? 'minute' : 'day' })));
  for (const [from,to,lag] of [['a','b',minute?15:0],['b','c',minute?10:0],['c','d',0],['e','f',0],['f','g',0],['b','h',0]])
    await api(`/dependencies/${project.id}`, 'POST', { from_task_id: ids[from], to_task_id: ids[to], type: 2, lag });
  await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: {
    id: 'current', name: '项目布局', search: '', columns: ['start','end','duration','pred','succ'], colW: minute ? 720 : 28, critical: false,
    indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null,
      widths: {}, nameWidth: 180, panelWidth: 1050, panelCollapsed: false, rightCollapsed: false, centerTime: new Date(start).getTime(), scrollTop: 0 },
  } });
  return { project, ids, minute, duration, start, expectedC: addMinutes(start, duration + (minute ? 25 : 0)) };
}
function verify(data, f, beforeAnchor, afterAnchor) {
  const { ids, duration, expectedC } = f, byId = new Map(data.tasks.map(t => [t.id,t]));
  assert.ok(!byId.has(ids.b) && !byId.has(ids.e));
  for (const [from,to,lag] of [['a','c',f.minute?25:0],['a','h',f.minute?15:0],['c','d',0],['f','g',0]])
    assert.ok(data.dependencies.some(d => d.from_task_id === ids[from] && d.to_task_id === ids[to] && d.type === 2 && d.lag === lag), `${from}->${to}`);
  assert.equal(data.dependencies.length, 4);
  assert.equal(byId.get(ids.c).start_date.slice(0,19), expectedC);
  assert.equal(byId.get(ids.d).start_date.slice(0,19), addMinutes(expectedC, duration));
  const orphan = byId.get(ids.f);
  assert.ok(orphan.start_date >= beforeAnchor && orphan.start_date.slice(0,19) <= afterAnchor, `orphan starts on deletion day: ${orphan.start_date}`);
  assert.equal(orphan.duration, duration); assert.equal(byId.get(ids.g).start_date.slice(0,19), addMinutes(orphan.start_date.slice(0,19), duration));
  assert.equal(new Set(data.dependencies.map(d => `${d.from_task_id}/${d.to_task_id}`)).size, data.dependencies.length);
}
async function clickElement(handle) {
  assert.ok(handle?.asElement());
  await page.evaluate(() => { window.__deleteClickCount = 0; window.__deleteProbe = () => window.__deleteClickCount++; document.addEventListener('click', window.__deleteProbe, true); });
  await handle.asElement().click({ delay: 40 });
  const delivered = await page.evaluate(() => { document.removeEventListener('click', window.__deleteProbe, true); return window.__deleteClickCount; });
  if (!delivered) await handle.evaluate(e => e.click());
  await handle.dispose();
}
async function click(label) {
  await clickElement(await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.getClientRects().length && (b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label)), label));
}
async function waitDate(id, expected, minute) {
  const display = expected.slice(2,10) + (minute ? ' ' + expected.slice(11,16) : '');
  await page.waitForFunction((selector,value) => document.querySelector(selector)?.textContent.trim() === value, {}, cell(id,'start'), display);
}
async function open(project) {
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(key => key.startsWith('__reactProps$')));
  await page.type('input[type=text]', login); await page.type('input[type=password]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await clickElement(await page.$(`a[href="/projects/${project.id}"]`));
  await page.waitForSelector(`[data-gantt-grid][data-project-id="${project.id}"]`);
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  for (const precision of ['day','minute']) {
    const f = await fixture(precision, 'API'), before = current(f.minute);
    const result = await api(`/tasks/${f.project.id}`, 'DELETE', { ids: [f.ids.b, f.ids.e] }, false);
    assert.equal(result.dependencies.length, 2);
    const data = await api(`/tasks/${f.project.id}`); verify(data, f, before, current(f.minute));
    assert.deepEqual((await api(`/tasks/${f.project.id}`, 'DELETE', { ids: [f.ids.b, f.ids.e] }, false)).deleted, []);
    assert.deepEqual(await api(`/tasks/${f.project.id}`), data);
    console.log(`PASS ${precision}: direct batch DELETE bridges chains/fan-out, anchors orphan to actual deletion day, cascades and retries idempotently`);
  }
  const hierarchy = await fixture('day', 'hierarchy'), parent = randomUUID(), middle = randomUUID(), child = randomUUID();
  await api(`/tasks/${hierarchy.project.id}`, 'POST', [{id:parent,name:'保留祖先',parent_id:null},{id:middle,name:'删除中层',parent_id:parent},{id:child,name:'保留子任务',parent_id:middle}]);
  await api(`/tasks/${hierarchy.project.id}`, 'DELETE', { ids: [middle] }, false);
  assert.equal((await api(`/tasks/${hierarchy.project.id}`)).tasks.find(t => t.id === child).parent_id, parent);
  await api(`/tasks/${hierarchy.project.id}`, 'DELETE', { id: parent }, false);
  assert.ok(!(await api(`/tasks/${hierarchy.project.id}`)).tasks.some(t => [parent,child].includes(t.id)));
  console.log('PASS explicit batch preserves children under the nearest ancestor; single-ID deletion includes descendants');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('Asia/Shanghai'); page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(90000);
  await page.evaluateOnNewDocument(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  for (const precision of ['day','minute']) {
    const f = await fixture(precision, 'UI'), baseline = await api(`/tasks/${f.project.id}`), before = current(f.minute);
    await open(f.project);
    await page.click(cell(f.ids.b,'name')); await click('删除选中任务'); await page.waitForSelector(cell(f.ids.b,'name'), {hidden:true});
    await waitDate(f.ids.c, f.expectedC, f.minute);
    assert.match(await page.$eval(cell(f.ids.c,'pred'), el => el.textContent), /1/);
    await page.click('button[title^="撤销"]'); await page.waitForSelector(cell(f.ids.b,'name'));
    await waitDate(f.ids.c, addMinutes(f.start, f.duration*2), f.minute);
    await page.click('button[title^="重做"]'); await page.waitForSelector(cell(f.ids.b,'name'), {hidden:true}); await waitDate(f.ids.c, f.expectedC, f.minute);
    await page.click(cell(f.ids.e,'name'), {button:'right'}); await click('删除任务'); await page.waitForSelector(cell(f.ids.e,'name'), {hidden:true});
    const after = current(f.minute); await waitDate(f.ids.f, after, f.minute);
    assert.deepEqual(await api(`/tasks/${f.project.id}`), baseline, 'Deletion stays in draft until explicit save');
    await page.waitForFunction(() => !document.querySelector('[data-action="save-plan"]').disabled); await page.click('[data-action="save-plan"]');
    await page.waitForFunction(() => { const b=document.querySelector('[data-action="save-plan"]'); return b.disabled && !b.textContent.includes('保存中'); });
    const saved = await api(`/tasks/${f.project.id}`); verify(saved, f, before, after);
    await open(f.project); await waitDate(f.ids.c,f.expectedC,f.minute); await waitDate(f.ids.f,saved.tasks.find(t=>t.id===f.ids.f).start_date,f.minute);
    assert.deepEqual(await api(`/tasks/${f.project.id}`), saved);
    await page.screenshot({path:path.join(output,`${precision}.png`),fullPage:true});
    console.log(`PASS ${precision}: actual toolbar/context deletion, predecessor display, one-step undo/redo, HTTP crypto fallback, draft isolation, confirmed save and reopen`);
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({passed:true,output}));
}
main().catch(async error => { console.error(error.stack); process.exitCode=1; if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{}); console.error({output, errors}); })
  .finally(async () => { if(browser) await browser.close(); for(const p of projects) await api(`/projects/${p.id}`,'DELETE').catch(console.error); });
