// Browser regression with intercepted APIs. No real projects or task records are changed.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-date-filter-'));
console.log(`Artifacts: ${output}`);
const errors = [], writes = [];
let browser, page;
const dialog = '[role="dialog"][aria-label="自定义日期筛选"]';
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(selector) {
  await page.$eval(selector, el => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click(); });
  await frame();
}
async function button(label) {
  const find = label => [...document.querySelectorAll('button')].find(b => !b.disabled && b.getClientRects().length
    && (b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label));
  await page.waitForFunction(find, {}, label);
  const handle = await page.evaluateHandle(find, label);
  await handle.evaluate(el => {
    const rect = el.getBoundingClientRect();
    if (!el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) throw new Error(`Obscured button: ${el.textContent}`);
    el.click();
  });
  await handle.dispose(); await frame();
}
async function fill(selector, value) {
  await page.$eval(selector, (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await frame();
}
async function expectRows(expected) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-task-row]')].map(row => row.dataset.taskRow)) === JSON.stringify(ids), {}, expected);
  assert.deepEqual(await page.$$eval('[data-task-row]', rows => rows.map(row => row.dataset.taskRow)), expected);
  assert.equal(await page.$eval('[data-gantt-grid]', grid => Number(grid.dataset.rowCount)), expected.length);
}
async function custom(field, from, to) {
  await button('自定义日期'); await page.waitForSelector(dialog);
  await page.select(`${dialog} select`, field);
  await fill(`${dialog} input[aria-label="筛选起始日期"]`, from);
  await fill(`${dialog} input[aria-label="筛选截止日期"]`, to);
  await button('应用筛选'); await page.waitForSelector(dialog, { hidden: true });
}
async function saveLayout() {
  await button('显示设置'); await button('常用布局');
  const saved = page.waitForResponse(response => response.url().endsWith('/view-preferences') && response.request().method() === 'PUT');
  await button('保存当前布局'); await saved;
  await button('关闭显示设置');
}
async function fixture(minute) {
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 });
  // App calendar policy is Asia/Shanghai; a different browser timezone must not shift task dates.
  await page.emulateTimezone('America/Los_Angeles');
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async d => { errors.push(d.message()); await d.accept(); });
  await page.evaluateOnNewDocument(() => {
    const NativeDate = Date;
    window.__dateFilterNow = NativeDate.parse('2026-11-18T00:30:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.__dateFilterNow])); }
      static now() { return window.__dateFilterNow; }
    };
  });
  const project = { id: randomUUID(), name: minute ? '分钟级只读日期筛选验收' : '天级日期筛选验收',
    planning_status: 'draft', status_date: '2026-11-18T00:00:00', start_date: '2026-11-01T00:00:00',
    end_date: '2026-11-30T00:00:00', time_granularity: minute ? 'minute' : 'day' };
  const dates = [
    ['parent', '父任务', '2026-11-01', '2026-11-30', null],
    ['today', '今日完成', '2026-11-16', '2026-11-18', 'parent'],
    ['last', '第七日完成', '2026-11-20', '2026-11-24', 'parent'],
    ['outside', '范围外完成', '2026-11-16', '2026-11-25', 'parent'],
    ['weekAgo', '一周前完成', '2026-11-09', '2026-11-11', 'parent'],
    ['before', '八天前完成', '2026-11-09', '2026-11-10', 'parent'],
    ['past', '昨日完成', '2026-11-16', '2026-11-17', null],
    ['start', '区间内开始', '2026-11-18', '2026-11-26', null],
    ['span', '跨越整个区间', '2026-11-01', '2026-11-30', null],
    ['missing', '未排期', null, null, null],
  ];
  const tasks = dates.map(([id, name, start, end, parent_id], order_index) => {
    const start_date = start ? `${start}T00:00:00` : null, end_date = end ? `${end}T${minute ? '23:59:00' : '00:00:00'}` : null;
    return { id, name, project_id: project.id, task_code: String(order_index + 1), parent_id, order_index,
      start_date, end_date, duration: start ? (Date.parse(`${end_date}Z`) - Date.parse(`${start_date}Z`)) / 60000 : 0,
      duration_unit: 'minute', auto_schedule: false, is_deleted: false, percent_done: 0, is_milestone: false,
      assignee: id === 'today' ? '张三' : '李四' };
  });
  let preferences = { revision: 0, views: [], currentView: { id: 'current', name: '旧布局兼容', search: '',
    columns: ['assignee', 'start', 'end'], colW: minute ? 1440 : 28, critical: false,
    indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: { parent: false }, filters: {}, sortCol: null, sortDir: null,
      widths: {}, nameWidth: 180, panelWidth: 900, panelCollapsed: false, rightCollapsed: false,
      centerTime: Date.parse('2026-11-18T00:00:00-08:00'), scrollTop: 0 } } };
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return request.continue();
    let value = [];
    if (url.pathname === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role: minute ? 'view' : 'admin' }, token: 'fixture' };
    else if (url.pathname.endsWith('/view-preferences')) {
      if (request.method() === 'PUT') preferences = { ...JSON.parse(request.postData()), revision: preferences.revision + 1 };
      value = preferences;
    } else if (request.method() !== 'GET') { writes.push({ path: url.pathname, method: request.method() }); value = null; }
    else if (url.pathname === '/api/projects') value = [project];
    else if (url.pathname === `/api/projects/${project.id}`) value = project;
    else if (url.pathname === `/api/tasks/${project.id}`) value = { tasks, dependencies: [], lines: [], statusDate: project.status_date,
      planningStatus: 'draft', customFields: [], planBaseline: null, revision: 'a'.repeat(64) };
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  const open = async () => {
    await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
    await fill('input[type=text]', 'fixture'); await fill('input[type=password]', 'fixture'); await button('登录');
    await page.waitForSelector(`a[href="/projects/${project.id}"]`); await click(`a[href="/projects/${project.id}"]`);
    await page.waitForSelector('[data-gantt-grid]'); await page.waitForNetworkIdle({ idleTime: 150 }); await frame();
  };
  await open();
  await expectRows(['parent', 'past', 'start', 'span', 'missing']);
  await button('自定义日期'); await page.waitForSelector(dialog);
  assert.equal(await page.$eval(`${dialog} select`, el => el.value), 'end');
  assert.equal(await page.$eval(`${dialog} input[aria-label="筛选起始日期"]`, el => el.value), '2026-11-11');
  assert.equal(await page.$eval(`${dialog} input[aria-label="筛选截止日期"]`, el => el.value), '2026-11-18');
  await button('取消');
  await button('近一周'); await expectRows(['parent', 'today', 'weekAgo', 'past']);
  assert.match(await page.$eval('[data-date-filter-summary]', el => el.textContent), /结束日期：2026-11-11 至 2026-11-18/);
  assert.equal(await page.$eval('[data-task-toggle=parent]', el => el.getAttribute('aria-expanded')), 'true');
  // Both predicates must be satisfied by the same child; an otherwise matching ancestor is not enough.
  await fill('input[placeholder="搜索任务..."]', '范围外'); await expectRows([]);
  assert.match(await page.$eval('[data-gantt-grid]', el => el.textContent), /没有符合当前筛选条件的任务/);
  await fill('input[placeholder="搜索任务..."]', '今日'); await expectRows(['parent', 'today']);
  await button('清除日期筛选'); await expectRows(['parent', 'today']);
  assert.equal(await page.$eval('input[placeholder="搜索任务..."]', el => el.value), '今日');
  await fill('input[placeholder="搜索任务..."]', '');
  await button('近一周');
  const filter = await page.evaluateHandle(() => [...document.querySelectorAll('[draggable]')]
    .find(el => [...el.querySelectorAll('span')].some(span => span.textContent === '责任人'))?.querySelector('button[title="筛选"]'));
  assert.ok(filter.asElement()); await filter.evaluate(el => el.click()); await filter.dispose();
  const option = await page.evaluateHandle(() => [...document.querySelectorAll('div')].find(el => el.textContent.trim() === '李四' && el.querySelector(':scope > input[type="checkbox"]')));
  assert.ok(option.asElement()); await option.evaluate(el => el.click()); await option.dispose(); await click('h1');
  await expectRows(['parent', 'today']);
  await button('清除日期筛选'); await expectRows(['parent', 'today']);
  // Clear only the assignee condition through its existing menu.
  const clearFilter = await page.evaluateHandle(() => [...document.querySelectorAll('[draggable]')]
    .find(el => [...el.querySelectorAll('span')].some(span => span.textContent === '责任人'))?.querySelector('button[title="筛选"]'));
  await clearFilter.evaluate(el => el.click()); await clearFilter.dispose(); await button('清除'); await click('h1');
  await expectRows(dates.map(row => row[0]));
  await custom('start', '2026-11-18', '2026-11-24'); await expectRows(['parent', 'last', 'start']);
  await custom('end', '2026-11-18', '2026-11-24'); await expectRows(['parent', 'today', 'last']);
  await custom('either', '2026-11-18', '2026-11-24'); await expectRows(['parent', 'today', 'last', 'start']);
  await custom('end', '2026-11-24', '2026-11-24'); await expectRows(['parent', 'last']);
  await button('自定义日期'); await fill(`${dialog} input[aria-label="筛选起始日期"]`, '2026-11-25');
  assert.equal(await page.$eval(`${dialog} button[type=submit]`, el => el.disabled), true);
  assert.match(await page.$eval(`${dialog} [role=alert]`, el => el.textContent), /起始日期不能晚于截止日期/);
  await expectRows(['parent', 'last']);
  await fill(`${dialog} input[aria-label="筛选起始日期"]`, '');
  assert.equal(await page.$eval(`${dialog} button[type=submit]`, el => el.disabled), true);
  await button('取消'); await expectRows(['parent', 'last']);
  await custom('either', '2026-12-01', '2026-12-01'); await expectRows([]);
  await custom('either', '2026-11-18', '2026-11-24');
  await saveLayout();
  assert.deepEqual(preferences.currentView.dateFilter, { kind: 'custom', field: 'either', from: '2026-11-18', to: '2026-11-24' });
  await open(); await expectRows(['parent', 'today', 'last', 'start']);
  await button('近一周'); await saveLayout(); assert.deepEqual(preferences.currentView.dateFilter, { kind: 'week' });
  await open(); await expectRows(['parent', 'today', 'weekAgo', 'past']);
  // Relative presets refresh when the app regains focus on the next calendar day.
  await page.evaluate(() => { window.__dateFilterNow = Date.parse('2026-11-19T00:30:00Z'); window.dispatchEvent(new Event('focus')); });
  await expectRows(['parent', 'today', 'past']);
  assert.match(await page.$eval('[data-date-filter-summary]', el => el.textContent), /2026-11-12 至 2026-11-19/);
  await button('近一周'); await expectRows(dates.map(row => row[0]));
  await button('自定义日期');
  assert.equal(await page.$eval(`${dialog} input[aria-label="筛选起始日期"]`, el => el.value), '2026-11-12');
  assert.equal(await page.$eval(`${dialog} input[aria-label="筛选截止日期"]`, el => el.value), '2026-11-19');
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await page.waitForSelector(dialog, { hidden: true });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '自定义日期');
  await button('自定义日期'); await click('h1'); await page.waitForSelector(dialog, { hidden: true });
  await custom('either', '2026-11-18', '2026-11-24'); await button('自定义日期');
  await page.screenshot({ path: path.join(output, `${minute ? 'minute-readonly' : 'day'}-desktop.png`), fullPage: true });
  await page.setViewport({ width: 1000, height: 800 }); await frame();
  const bounds = await page.$eval(dialog, el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; });
  assert.ok(bounds.left >= 0 && bounds.right <= 1000 && bounds.bottom <= 800, JSON.stringify(bounds));
  await page.screenshot({ path: path.join(output, `${minute ? 'minute-readonly' : 'day'}-compact.png`), fullPage: true });
  await button('取消');
  console.log(`PASS ${minute ? 'minute/read-only' : 'day/editor'}: boundaries, hierarchy, combined filters, validation, cancel, empty results, layouts, relative rollover, compact panel and no plan writes`);
  await page.close();
}
(async () => {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  await fixture(false); await fixture(true);
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ passed: true, output }));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => { if (browser) await browser.close(); });
