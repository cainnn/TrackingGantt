// Intercept every API request: this regression never changes real project data.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-dependency-trace-'));
const errors = [], writes = [];
let browser, page;
const panel = '#dependency-trace-panel';
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function clickElement(handle) {
  await handle.evaluate(el => { el.__traceClicked = false; el.addEventListener('click', () => { el.__traceClicked = true; }, { once: true }); });
  await handle.click();
  // Some local headless Chrome runs acknowledge native input without delivering
  // it to the document. Retry only an undelivered event on a visible hit target.
  await handle.evaluate(el => {
    if (el.__traceClicked) return;
    const r = el.getBoundingClientRect();
    const assertVisible = el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    if (!assertVisible) throw new Error(`Obscured element: ${el.textContent}`);
    el.click();
  });
  await frame();
}
async function click(selector) {
  await page.waitForSelector(selector);
  const handle = await page.$(selector); await clickElement(handle); await handle.dispose();
}
async function button(label) {
  const match = label => [...document.querySelectorAll('button')].find(b => !b.disabled && b.getClientRects().length
    && (b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label));
  await page.waitForFunction(match, {}, label);
  const handle = await page.evaluateHandle(match, label);
  await clickElement(handle.asElement()); await handle.dispose();
}
async function fill(selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await frame();
}
async function focus(id) {
  await page.waitForFunction(id => document.querySelector('[data-trace-focus]')?.dataset.traceFocus === id, {}, id);
}
async function enter(input) {
  await page.focus(input);
  await page.$eval(input, el => { window.__traceLookupKey = null; el.addEventListener('keydown', e => { window.__traceLookupKey = { key: e.key, composing: e.isComposing, code: e.code, value: el.value }; }, { once: true }); });
  await page.keyboard.press('Enter');
  if (!await page.evaluate(() => window.__traceLookupKey)) await page.$eval(input, el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
  await frame();
}
async function lookup(query, id, label = '按编号或名称查找任务') {
  const input = `${panel} input[aria-label="${label}"]`;
  await click(input); await fill(input, query); await enter(input);
  if (label === '按编号或名称查找任务') {
    try { await focus(id); } catch (error) { console.error('Lookup key:', await page.evaluate(() => window.__traceLookupKey)); throw error; }
  }
}
async function mode(value) { await page.select(`${panel} select[aria-label="路径模式"]`, value); await frame(); }
async function onlyPath(value) {
  const checkbox = `${panel} input[type=checkbox]`;
  if (await page.$eval(checkbox, e => e.checked) !== value) await click(checkbox);
  await frame();
}
async function expectRows(ids) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-task-row]')].map(e => e.dataset.taskRow)) === JSON.stringify(ids), {}, ids);
}
async function expectPath(ids) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-trace-task]')].map(e => e.dataset.taskRow).sort()) === JSON.stringify(ids.slice().sort()), {}, ids);
}
async function fixture(minute) {
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('America/Los_Angeles');
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', async d => { errors.push(d.message()); await d.accept(); });
  const unit = minute ? 60 : 1440, epoch = Date.UTC(2030, 0, 1, minute ? 9 : 0);
  const date = n => new Date(epoch + n * unit * 60000).toISOString().slice(0, 19);
  const project = { id: randomUUID(), name: minute ? '分钟级只读依赖跟踪' : '天级依赖跟踪验收', planning_status: 'draft', status_date: date(0), start_date: date(0), end_date: date(10), time_granularity: minute ? 'minute' : 'day' };
  const specs = [['p', '实施阶段', 0, 3, null], ['a', '短分支', 0, 1, 'p'], ['b', '次长分支', 0, 2, 'p'], ['c', '驱动分支', 0, 3, 'p'],
    ['d', '汇合任务', 3, 4, null], ['e', '验收里程碑', 4, 4, null], ['off', '停用任务', 0, 3, null], ['manual', '手动后续', 4, 5, null], ['spare', '无关任务', 0, 10, null]];
  const tasks = specs.map(([id, name, from, to, parent_id], order_index) => ({ id, name, parent_id, project_id: project.id, order_index, task_code: `persist-${id}`,
    start_date: date(from), end_date: date(to), duration: (to - from) * unit, duration_unit: 'minute', is_milestone: id === 'e', auto_schedule: id !== 'manual', inactive: id === 'off', percent_done: 0, is_deleted: false, assignee: '测试' }));
  const dependencies = [['a', 'd'], ['b', 'd'], ['c', 'd'], ['d', 'e'], ['off', 'd'], ['e', 'manual']].map(([from, to]) => ({ id: `${from}-${to}`, project_id: project.id, from_task_id: from, to_task_id: to, type: 2, lag: 0 }));
  const version = { id: randomUUID(), project_id: project.id, version_number: 1, name: '历史依赖验收', created_at: date(0), status_date: date(0), is_autosave: false };
  const snapshot = { tasks: tasks.map(t => t.id === 'a' ? { ...t, end_date: date(3), duration: unit * 3 } : t),
    dependencies: dependencies.filter(d => d.from_task_id !== 'c'), lines: [], planning_status: 'draft' };
  const prefs = { revision: 0, views: [], currentView: { id: 'current', name: '跟踪验收布局', search: '', columns: ['start', 'end', 'pred', 'succ'], colW: minute ? 1440 : 28, critical: false,
    indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: { p: false }, filters: {}, sortCol: null, sortDir: null, widths: {}, nameWidth: 180,
      panelWidth: 700, panelCollapsed: false, rightCollapsed: false, centerTime: epoch, scrollTop: 0 } } };
  const baseline = { tasks, dependencies, lines: [], statusDate: project.status_date, planningStatus: 'draft', customFields: [], planBaseline: null, revision: 'a'.repeat(64) };
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith('/api/')) return request.continue();
    let value = [];
    if (url.pathname === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role: minute ? 'view' : 'admin' }, token: 'fixture' };
    else if (request.method() !== 'GET') { writes.push({ path: url.pathname, method: request.method() }); value = null; }
    else if (url.pathname.endsWith('/view-preferences')) value = prefs;
    else if (url.pathname === '/api/projects') value = [project];
    else if (url.pathname === `/api/projects/${project.id}`) value = project;
    else if (url.pathname === `/api/tasks/${project.id}`) value = baseline;
    else if (url.pathname === `/api/versions/${project.id}`) value = url.searchParams.has('id') ? { ...version, snapshot } : [version];
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
  await fill('input[type=text]', 'fixture'); await fill('input[type=password]', 'fixture'); await button('登录');
  await click(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector('[data-gantt-grid]'); await page.waitForNetworkIdle({ idleTime: 150 }); await frame();
  await button('依赖跟踪'); assert.match(await page.$eval(panel, e => e.textContent), /选择一个任务/);
  assert.equal(await page.$eval('button[title^="查看所有层级"]', e => e.disabled), true);
  // Lookup uses grid numbers (D is #5), not the persistent task code.
  await lookup('5', 'd');
  assert.equal(await page.$$eval('[data-trace-dependency]', rows => rows.length), 5);
  assert.equal(await page.$eval('[data-trace-dependency="c-d"]', e => e.dataset.traceStatus), 'driving');
  assert.equal(await page.$eval('[data-trace-dependency="off-d"]', e => e.dataset.traceStatus), 'inactive');
  assert.match(await page.$eval('[data-trace-dependency="a-d"]', e => e.textContent), minute ? /120 分钟/ : /2 天/);
  await click('[data-trace-dependency="c-d"] button'); await focus('c');
  await button('跟踪后退'); await focus('d'); await button('跟踪前进'); await focus('c'); await button('跟踪后退'); await focus('d');
  await click('[data-task-row="e"] input[type=checkbox]'); await frame();
  assert.equal(await page.$('[data-trace-focus]'), null);
  assert.equal(await page.$eval('button[title^="Get Driving Path"]', e => e.disabled), true);
  assert.equal(await page.$eval('button[title^="查看所有层级"]', e => e.disabled), true);
  await click('[data-task-row="e"] input[type=checkbox]'); await focus('d');
  // One click works from a closed panel, includes non-driving branches, and
  // temporarily reveals predecessors hidden by the user's existing search.
  await button('关闭依赖跟踪'); await fill('input[placeholder="搜索任务..."]', '汇合任务');
  await button('所有前置任务'); await expectRows(['p', 'a', 'b', 'c', 'd']);
  assert.deepEqual(await page.$$eval('[data-trace-predecessor]', rows => rows.map(e => e.dataset.tracePredecessor)), ['a', 'b', 'c']);
  await button('清除路径'); await expectRows(['d']);
  await lookup('验收里程碑', 'e'); await button('所有前置任务'); await expectRows(['p', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(await page.$$eval('[data-trace-predecessor]', rows => rows.map(e => e.dataset.tracePredecessor)), ['a', 'b', 'c', 'd']);
  assert.match(await page.$eval('[data-trace-predecessor="a"]', e => e.textContent), /间接前置/);
  assert.match(await page.$eval('[data-trace-predecessor="d"]', e => e.textContent), /直接前置/);
  await page.screenshot({ path: path.join(output, `${minute ? 'minute' : 'day'}-all-predecessors.png`), fullPage: true });
  await lookup('短分支', 'a'); await button('所有前置任务'); await expectRows(['p', 'a']);
  assert.equal(await page.$$eval('[data-trace-predecessor]', rows => rows.length), 0);
  assert.match(await page.$eval(panel, e => e.textContent), /当前任务没有有效前置任务/);
  await lookup('汇合任务', 'd');
  await button('驱动路径'); await onlyPath(true); await expectRows(['p', 'c', 'd']); await expectPath(['c', 'd']);
  await button('适配路径');
  await page.waitForSelector('[data-dependency-id="c-d"][data-trace-edge="true"]');
  // Increasing the cumulative threshold reveals the shorter branch too.
  await fill(`${panel} input[aria-label="驱动时差上限"]`, minute ? '60' : '1'); await expectRows(['p', 'b', 'c', 'd']);
  await fill(`${panel} input[aria-label="驱动时差上限"]`, '0');
  await mode('both'); await expectRows(['p', 'c', 'd', 'e']);
  assert.match(await page.$eval('[data-trace-result]', e => e.textContent), /手动任务/);
  await mode('upstream'); await expectRows(['p', 'a', 'b', 'c', 'd']);
  await mode('downstream'); await expectRows(['d', 'e', 'manual']);
  await lookup('驱动分支', 'c'); await mode('connecting');
  await lookup('验收里程碑', 'e', '查找连接终点'); await expectRows(['p', 'c', 'd', 'e']); await expectPath(['c', 'd', 'e']);
  await lookup('无关任务', 'spare', '查找连接终点'); await expectRows([]);
  assert.match(await page.$eval('[data-trace-result]', e => e.textContent), /没有有效的有向依赖路径/);
  await lookup('验收里程碑', 'e', '查找连接终点'); await button('适配路径');
  await page.screenshot({ path: path.join(output, `${minute ? 'minute' : 'day'}-connecting.png`), fullPage: true });
  // A temporary path view overrides other filters and restores them on clear.
  await fill('input[placeholder="搜索任务..."]', '无关任务'); await expectRows(['p', 'c', 'd', 'e']);
  await button('清除路径'); await expectRows(['spare']);
  await fill('input[placeholder="搜索任务..."]', ''); await lookup('汇合任务', 'd');
  await button('驱动路径'); await onlyPath(true);
  await button('关闭依赖跟踪'); await page.waitForSelector(panel, { hidden: true });
  assert.equal(await page.$$eval('[data-trace-task]', rows => rows.length), 0);
  await button('依赖跟踪'); await expectRows(['p', 'c', 'd']);
  // The existing read-only toolbar has no version switch; the editor scenario
  // verifies that history uses its own dependency snapshot, not today's graph.
  if (!minute) {
  await button('查看历史');
  const v = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('历史依赖验收') && !e.textContent.includes('查看中')));
  assert.ok(v.asElement()); await clickElement(v.asElement()); await v.dispose();
  await page.waitForFunction(() => document.querySelector('#dependency-trace-panel')?.textContent.includes('历史版本：'));
  await lookup('汇合任务', 'd'); await button('驱动路径'); await onlyPath(true); await expectRows(['p', 'a', 'd']);
  assert.equal(await page.$('[data-trace-dependency="c-d"]'), null);
  await button('所有前置任务'); await expectRows(['p', 'a', 'b', 'd']);
  assert.deepEqual(await page.$$eval('[data-trace-predecessor]', rows => rows.map(e => e.dataset.tracePredecessor)), ['a', 'b']);
  await button('退出查看'); await lookup('汇合任务', 'd'); await button('驱动路径'); await onlyPath(true); await expectRows(['p', 'c', 'd']);
  }
  await page.setViewport({ width: 1000, height: 800 }); await frame();
  const bounds = await page.$eval(panel, e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, top: r.top }; });
  assert.ok(bounds.left >= 0 && bounds.right <= 1000 && bounds.bottom <= 800 && bounds.top > 100, JSON.stringify(bounds));
  await page.screenshot({ path: path.join(output, `${minute ? 'minute' : 'day'}-compact.png`), fullPage: true });
  // Current unsaved edits are included without saving; analysis creates no draft operations.
  if (!minute) {
    await button('清除路径'); await page.setViewport({ width: 1680, height: 1080 }); await frame();
    const nameCell = '[data-task-cell="d"][data-col="name"]';
    await page.$eval(nameCell, el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await fill(`${nameCell} input`, '未保存汇合任务'); await enter(`${nameCell} input`);
    await page.waitForFunction(() => document.querySelector('#dependency-trace-panel')?.textContent.includes('含未保存修改'));
    assert.match(await page.$eval('[data-trace-focus]', e => e.textContent), /未保存汇合任务/);
    await button('驱动路径'); await onlyPath(true); await expectRows(['p', 'c', 'd']);
  }
  console.log(`PASS ${minute ? 'minute/read-only' : 'day/editor with snapshots and unsaved edits'}: lookup, selection, traversal history, driving/slack, both directions, connecting paths, highlight, filter restoration and no writes`);
  await page.close();
}
(async () => {
  console.log(`Artifacts: ${output}`);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  await fixture(false); await fixture(true);
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ passed: true, output }));
})().catch(async e => {
  console.error(e); process.exitCode = 1;
  if (page && !page.isClosed()) { console.error(await page.$eval('body', e => e.innerText).catch(() => '')); await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
}).finally(async () => { if (browser) await browser.close(); });
