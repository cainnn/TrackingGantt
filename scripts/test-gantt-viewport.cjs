// Large-plan browser regression. All API requests are intercepted; no real project is changed.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-viewport-'));
let browser, page;
const errors = [], writes = [], results = [];
const cell = (id, col = 'name') => `[data-task-cell="${id}"][data-col="${col}"]`;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(selector, modifiers = {}) {
  await page.$eval(selector, (el, modifiers) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })), modifiers);
  await frame();
}
async function button(label) {
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => (b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label || (label === '撤销' && b.title.startsWith('撤销'))) && !b.disabled), {}, label);
  await page.evaluate(label => { const buttons = [...document.querySelectorAll('button')].filter(b => !b.disabled); const b = buttons.find(b => b.textContent.trim() === label) ?? buttons.find(b => b.getAttribute('aria-label') === label || b.title === label || (label === '撤销' && b.title.startsWith('撤销'))); b.click(); }, label);
  await frame();
}
async function fill(selector, value) {
  await page.$eval(selector, (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await frame();
}
async function key(key, extra = {}) {
  await page.$eval('[data-gantt-grid]', (el, args) => el.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, code: args.key, bubbles: true, cancelable: true, ...args.extra })), { key, extra });
  await frame();
}
async function scroll(index, side = '[data-gantt-grid]') {
  await page.$eval(side, (el, top) => { el.scrollTop = top; el.dispatchEvent(new Event('scroll')); }, index * 40);
  await page.waitForFunction(index => Math.abs(document.querySelector('[data-gantt-grid]').scrollTop - document.querySelector('[data-timeline-scroll]').scrollTop) < 2
    && [...document.querySelectorAll('[data-task-row]')].some(r => Number.parseFloat(r.style.top) >= index * 40 - 240), {}, index);
  await frame();
}
async function counts() { return page.evaluate(() => ({ rows: document.querySelectorAll('[data-task-row]').length,
  bars: document.querySelectorAll('[data-task-bar]').length, deps: document.querySelectorAll('[data-dependency-id]').length,
  svgNodes: document.querySelectorAll('[data-timeline-scroll] svg *').length,
  headerNodes: document.querySelector('[data-timeline-scroll]').previousElementSibling.querySelectorAll('svg *').length,
  count: Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) })); }
async function fixture(count, minute) {
  page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', d => d.accept());
  const start = minute ? '2030-01-01T09:00:00' : '2030-01-01T00:00:00';
  const end = minute ? '2030-01-01T10:00:00' : '2030-01-02T00:00:00';
  const project = { id: `viewport-${count}-${minute}`, name: '大计划可视区域验收', planning_status: 'draft', status_date: start, start_date: start,
    end_date: minute ? '2035-01-01T00:00:00' : '2030-02-01T00:00:00', time_granularity: minute ? 'minute' : 'day' };
  const tasks = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, project_id: project.id, task_code: String(i + 1), parent_id: i === 1 || i === 2 ? 't0' : null,
    name: `任务 ${String(i).padStart(5, '0')}`, assignee: `责任人${i}`, start_date: start, end_date: end, duration: minute ? 60 : 1440, duration_unit: 'minute',
    order_index: i, auto_schedule: false, is_deleted: false, percent_done: 0, is_milestone: false }));
  const dependencies = tasks.slice(3).filter((_, i) => i % 10 !== 0).map(t => ({ id: `d${t.id}`, project_id: project.id, from_task_id: `t${Number(t.id.slice(1)) - 1}`, to_task_id: t.id, type: 0, lag: 0 }));
  dependencies.push({ id: 'cross-screen', project_id: project.id, from_task_id: 't1', to_task_id: `t${count - 1}`, type: 0, lag: 0 });
  let preferences = { revision: 0, views: [], currentView: { id: 'current', name: '验收布局', search: '', columns: ['assignee', 'duration', 'start', 'end', 'pred'],
    colW: minute ? 1440 : 28, critical: false, indicators: { deadlineDate: true, constraintDate: true },
    chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null, widths: {}, nameWidth: 180, panelWidth: 900, panelCollapsed: false, rightCollapsed: false,
      centerTime: new Date(minute ? '2030-01-01T10:00:00+08:00' : '2030-01-02T00:00:00+08:00').getTime(), scrollTop: 0 } } };
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith('/api/')) return request.continue();
    let value = [];
    if (url.pathname === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role: 'admin' }, token: 'fixture-token' };
    else if (url.pathname.endsWith('/view-preferences')) {
      if (request.method() === 'PUT') preferences = { ...JSON.parse(request.postData()), revision: preferences.revision + 1 };
      value = preferences;
    } else if (request.method() !== 'GET') { writes.push({ path: url.pathname, method: request.method() }); value = null; }
    else if (url.pathname === '/api/projects') value = [project];
    else if (url.pathname === `/api/projects/${project.id}`) value = project;
    else if (url.pathname === `/api/tasks/${project.id}`) value = { tasks, dependencies };
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  const open = async () => {
    await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
    await fill('input[type=text]', 'fixture'); await fill('input[type=password]', 'fixture'); await button('登录');
    await page.waitForSelector(`a[href="/projects/${project.id}"]`);
    const before = Date.now(); await click(`a[href="/projects/${project.id}"]`);
    await page.waitForSelector('[data-task-row]'); await frame(); return Date.now() - before;
  };
  const loadMs = await open(), initial = await counts();
  console.log('LOADED', count, JSON.stringify(initial), loadMs);
  assert.equal(initial.count, count); assert.ok(initial.rows < 60 && initial.bars < 60, JSON.stringify(initial));
  assert.ok(initial.headerNodes < 1000, JSON.stringify(initial));
  // Copy all rows, including rows that have never been mounted.
  await click(cell('t0', 'assignee')); await key('ArrowDown', { ctrlKey: true, shiftKey: true });
  await page.waitForSelector(cell(`t${count - 1}`, 'assignee'));
  const copied = await page.$eval('[data-gantt-grid]', el => { const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })); return data.getData('text/plain').split('\n'); });
  assert.equal(copied.length, count); assert.equal(copied[0].trim(), '责任人0'); assert.equal(copied[Math.floor(count / 2)].trim(), `责任人${Math.floor(count / 2)}`); assert.equal(copied.at(-1).trim(), `责任人${count - 1}`);
  await key('Escape');
  console.log('PASS full-plan copy', count);
  // Right-hand wheel/scroll updates the left row window; crossing line survives.
  const middle = Math.floor(count / 2); await scroll(middle, '[data-timeline-scroll]');
  await page.waitForSelector(cell(`t${middle}`));
  await page.waitForSelector('[data-dependency-id="cross-screen"]');
  assert.equal(await page.$(cell('t1')), null); assert.equal(await page.$(cell(`t${count - 1}`)), null);
  const middleCounts = await counts(); assert.ok(middleCounts.rows < 60 && middleCounts.deps < 100, JSON.stringify(middleCounts));
  const alignment = await page.evaluate(id => ({ row: document.querySelector(`[data-task-row="${id}"]`).getBoundingClientRect().top,
    bar: document.querySelector(`[data-task-bar="${id}"] rect[fill=transparent]`).getBoundingClientRect().top }), `t${middle}`);
  assert.ok(Math.abs(alignment.bar - alignment.row - 10) <= 1, JSON.stringify(alignment));
  // A live editor remains mounted and its unsaved value survives scrolling.
  await page.$eval(cell(`t${middle}`), el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await fill(`${cell(`t${middle}`)} input`, '编辑中未提交');
  await scroll(0);
  assert.equal(await page.$eval(`${cell(`t${middle}`)} input`, el => el.value), '编辑中未提交');
  assert.ok((await counts()).rows < 61);
  await page.$eval(`${cell(`t${middle}`)} input`, el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await scroll(middle); assert.ok((await page.$eval(cell(`t${middle}`), el => el.textContent)).includes(`任务 ${String(middle).padStart(5, '0')}`));
  // Keyboard navigation moves beyond the mounted buffer without losing focus.
  await click(cell(`t${middle}`, 'assignee'));
  for (let i = 0; i < 45; i++) await key('ArrowDown');
  await page.waitForSelector(cell(`t${middle + 45}`, 'assignee'));
  await key('Enter'); await fill(`${cell(`t${middle + 45}`, 'assignee')} input`, '跨屏编辑'); await key('Enter');
  await scroll(middle + 45); assert.equal(await page.$eval(cell(`t${middle + 45}`, 'assignee'), el => el.textContent.trim()), '跨屏编辑');
  await button('撤销'); assert.equal(await page.$eval(cell(`t${middle + 45}`, 'assignee'), el => el.textContent.trim()), `责任人${middle + 45}`);
  console.log('PASS scrolling/editor/keyboard', count);
  // Filtering a long scrolled plan must not leave an empty viewport.
  await fill('input[placeholder^="搜索任务"]', '任务 00001'); await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.rowCount === '2');
  await page.waitForSelector(cell('t1')); await fill('input[placeholder^="搜索任务"]', '');
  await scroll(0); await click(`${cell('t0')} button`);
  await page.waitForFunction(n => Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) === n - 2, {}, count);
  await click(`${cell('t0')} button`); await page.waitForFunction(n => Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) === n, {}, count);
  // Horizontal minute ticks and lines remain bounded far into a multi-year plan.
  if (minute) {
    await page.$eval('[data-timeline-scroll]', el => { el.scrollLeft = 1000000; el.dispatchEvent(new Event('scroll')); }); await frame();
    assert.ok((await counts()).headerNodes < 1000);
    assert.equal(await page.$('[data-dependency-id="cross-screen"]'), null);
    await button('回到状态日期'); await frame();
  }
  await scroll(middle);
  await button('显示设置'); await button('常用布局'); await button('保存当前布局'); await button('关闭显示设置');
  assert.ok(preferences.currentView.chart.scrollTop >= middle * 40 - 1);
  await open(); await page.waitForSelector(cell(`t${middle}`));
  assert.ok(Math.abs(await page.$eval('[data-gantt-grid]', e => e.scrollTop) - preferences.currentView.chart.scrollTop) < 2);
  await page.setViewport({ width: 1440, height: 720 }); await frame(); assert.ok((await counts()).rows < 45);
  await page.screenshot({ path: path.join(output, `${minute ? 'minute' : 'day'}-${count}.png`), fullPage: true });
  results.push({ count, minute, loadMs, initial, middle: middleCounts });
  console.log('PASS', JSON.stringify(results.at(-1))); await page.close();
}
(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  await fixture(1000, false); await fixture(10000, true);
  assert.deepEqual(writes, [], 'view operations and local edits never write the plan'); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, output, results }, null, 2));
})().catch(async error => { console.error(error); if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; })
.finally(async () => { if (browser) await browser.close(); });
