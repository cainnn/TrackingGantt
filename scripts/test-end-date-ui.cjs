// Real UI with intercepted API fixtures; never writes real projects.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const puppeteer = require('puppeteer');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-end-date-'));
let browser, page;
const errors = [], writes = [];
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(selector, event = 'click') {
  await page.$eval(selector, (el, event) => el.dispatchEvent(new MouseEvent(event, { bubbles: true, cancelable: true })), event); await frame();
}
async function fill(selector, value) {
  await page.$eval(selector, (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value); await frame();
}
async function key(key) {
  await page.evaluate(key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })), key); await frame();
}
async function button(label) {
  const find = label => [...document.querySelectorAll('button')].find(el => !el.disabled && el.getClientRects().length
    && (el.textContent.trim() === label || el.getAttribute('aria-label') === label || el.title === label || (label === '撤销' && el.title.startsWith('撤销'))));
  await page.waitForFunction(find, {}, label);
  const handle = await page.evaluateHandle(find, label); await handle.evaluate(el => el.click()); await handle.dispose(); await frame();
}
async function expectCell(id, col, value) {
  await page.waitForFunction((selector, value) => document.querySelector(selector)?.textContent.trim() === value, {}, cell(id, col), value);
}
async function openEnd(id, keyboard = false) {
  await click(cell(id, 'end'));
  if (keyboard) { await page.focus('[data-gantt-grid]'); await key('F2'); }
  else await click(cell(id, 'end'), 'dblclick');
}
async function editEnd(id, value, keyboard = false, commit = 'Enter') {
  await openEnd(id, keyboard); const input = `${cell(id, 'end')} input`;
  await page.waitForSelector(input); await fill(input, value);
  if (commit === 'blur') await page.focus('input[placeholder="搜索任务..."]');
  else await key(commit);
  await page.waitForSelector(input, { hidden: true }); await frame();
}
async function fixture(minute) {
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
  const unit = minute ? 60 : 1440;
  const at = n => new Date(Date.UTC(2026, 10, 1, minute ? 9 : 0, minute ? 15 : 0) + n * unit * 60000).toISOString().slice(0, 19);
  const input = n => at(n).slice(0, minute ? 16 : 10).replace('T', ' ');
  const display = n => input(n).slice(2);
  const project = { id: randomUUID(), name: `${minute ? '分钟级' : '天级'}完成日期编辑验收`, planning_status: 'draft', time_granularity: minute ? 'minute' : 'day', start_date: at(-1), end_date: at(6), status_date: at(0) };
  const specs = [['pre', 0, 1], ['parent', 1, 4], ['fs', 1, 3], ['next', 3, 4], ['ss', 0, 2], ['ff', -1, 1], ['sf', -1, 0], ['mixed', 1, 3], ['reverse', 1, 3], ['inactive', 1, 3], ['manual', 1, 3], ['free', 1, 3]];
  const tasks = specs.map(([id, start, end], order_index) => ({ id, project_id: project.id, task_code: String(order_index + 1), name: id,
    parent_id: ['fs', 'next'].includes(id) ? 'parent' : null, order_index, assignee: null, start_date: at(start), end_date: at(end),
    duration: (end - start) * unit, duration_unit: 'minute', auto_schedule: id !== 'manual', constraint_type: 'asap',
    percent_done: 0, is_deleted: false, is_milestone: false, note: null }));
  const dep = (id, from, to, type, active = true) => ({ id, project_id: project.id, from_task_id: from, to_task_id: to, type, lag: 0, active });
  const dependencies = [dep('fs', 'pre', 'fs', 2), dep('next', 'fs', 'next', 2), dep('ss', 'pre', 'ss', 0), dep('ff', 'pre', 'ff', 3),
    dep('sf', 'pre', 'sf', 1), dep('mix-fs', 'pre', 'mixed', 2), dep('mix-ff', 'pre', 'mixed', 3),
    dep('reverse-ff', 'pre', 'reverse', 3), dep('reverse-fs', 'pre', 'reverse', 2),
    dep('inactive-ff', 'pre', 'inactive', 3, false), dep('inactive-fs', 'pre', 'inactive', 2, false), dep('manual-ff', 'pre', 'manual', 3)];
  let role = 'admin';
  const preferences = { revision: 0, views: [], currentView: { id: 'current', name: '验收布局', search: '', columns: ['start', 'end', 'duration', 'taskType'], colW: minute ? 1440 : 28, critical: false,
    indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null, widths: {}, nameWidth: 170, panelWidth: 780,
      panelCollapsed: false, rightCollapsed: false, centerTime: Date.parse(`${at(3)}+08:00`), scrollTop: 0 } } };
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith('/api/')) return request.continue();
    let value = [];
    if (url.pathname === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role }, token: 'fixture-token' };
    else if (request.method() !== 'GET') { writes.push([request.method(), url.pathname]); value = null; }
    else if (url.pathname.endsWith('/view-preferences')) value = preferences;
    else if (url.pathname === '/api/projects') value = [project];
    else if (url.pathname === `/api/projects/${project.id}`) value = project;
    else if (url.pathname === `/api/tasks/${project.id}`) value = { tasks, dependencies, lines: [], statusDate: project.status_date, planningStatus: 'draft', customFields: [], planBaseline: null, revision: 'a'.repeat(64) };
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  const open = async () => {
    await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(key => key.startsWith('__reactProps$')));
    await fill('input[type=text]', 'fixture'); await fill('input[type=password]', 'fixture'); await button('登录');
    await page.waitForSelector(`a[href="/projects/${project.id}"]`); await click(`a[href="/projects/${project.id}"]`);
    await page.waitForSelector(cell('free', 'end')); await page.waitForNetworkIdle({ idleTime: 150 }); await frame();
  };
  await open();
  // Duration and finish form a two-way edit: keep the start and scheduling mode, update the other value and the chain.
  for (const keyboard of [false, true]) {
    await click(cell('fs', 'duration'));
    if (keyboard) { await page.focus('[data-gantt-grid]'); await key('F2'); }
    else await click(cell('fs', 'duration'), 'dblclick');
    await page.waitForSelector(`${cell('fs', 'duration')} input`);
    await fill(`${cell('fs', 'duration')} input`, minute ? '255' : '4');
    await key('Enter'); await page.waitForSelector(`${cell('fs', 'duration')} input`, { hidden: true });
    const end = minute ? 5.25 : 5;
    await expectCell('fs', 'duration', minute ? '255分钟' : '4天');
    await expectCell('fs', 'start', display(1)); await expectCell('fs', 'end', display(end)); await expectCell('fs', 'taskType', '自动');
    await expectCell('next', 'start', display(end)); await expectCell('parent', 'end', display(end + 1));
    await button('撤销'); await expectCell('fs', 'end', display(3)); await expectCell('next', 'start', display(3));
  }
  for (const [keyboard, commit, end] of [[false, 'Enter', 5], [true, 'Tab', 4], [false, 'blur', minute ? 4.25 : 5]]) {
    await editEnd('fs', input(end), keyboard, commit);
    await expectCell('fs', 'start', display(1)); await expectCell('fs', 'end', display(end));
    const minutes = (end - 1) * unit;
    await expectCell('fs', 'duration', minute ? (minutes % 60 === 0 ? `${minutes / 60}小时` : `${minutes}分钟`) : `${minutes / 1440}天`);
    await expectCell('fs', 'taskType', '自动'); await expectCell('next', 'start', display(end)); await expectCell('parent', 'end', display(end + 1));
    await button('撤销'); await expectCell('fs', 'end', display(3)); await expectCell('next', 'start', display(3));
  }
  for (const id of ['ss', 'inactive', 'manual', 'free']) {
    await editEnd(id, input(4)); await expectCell(id, 'end', display(4)); await button('撤销');
  }
  for (const id of ['ff', 'sf', 'mixed', 'reverse', 'parent']) for (const keyboard of [false, true]) {
    await openEnd(id, keyboard); assert.equal(await page.$(`${cell(id, 'end')} input`), null);
    assert.ok(await page.evaluate(summary => [...document.querySelectorAll('[role=status]')].some(el => el.textContent.includes(summary ? '日期由子任务汇总' : '完成日期由前置依赖决定')), id === 'parent'));
  }
  await editEnd('fs', input(0));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[role=alert]')].some(el => el.textContent.includes('结束时间必须晚于开始时间'))));
  await expectCell('fs', 'end', display(3)); await expectCell('fs', 'start', display(1));
  await openEnd('fs'); await fill(`${cell('fs', 'end')} input`, '2026-02-30'); await key('Enter');
  assert.notEqual(await page.$(`${cell('fs', 'end')} input`), null); await key('Escape'); await expectCell('fs', 'end', display(3));
  assert.equal(await page.$eval('[data-action=save-plan]', el => el.disabled), true, 'rejected edits and undo restore the original draft');
  await editEnd('fs', input(5)); await page.screenshot({ path: path.join(output, `${minute ? 'minute' : 'day'}.png`), fullPage: true });
  await button('撤销');
  role = 'view'; await open();
  for (const keyboard of [false, true]) { await openEnd('fs', keyboard); assert.equal(await page.$(`${cell('fs', 'end')} input`), null); }
  console.log(`PASS ${minute ? 'minute' : 'day'}: duration/finish two-way editing, preserved starts, cascade, repeated edits, Enter/Tab/blur, undo, invalid dates, dependency/summary/read-only restrictions`);
  await page.close();
}
(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  await fixture(false); await fixture(true); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ passed: true, output }));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`Artifacts: ${output}`);
}).finally(async () => { if (browser) await browser.close(); });
