// Real browser + database regression. Only disposable projects are written/deleted.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const puppeteer = require('puppeteer');
const base = process.env.FILTER_FILL_TEST_URL || 'http://127.0.0.1:3127';
const projects = [], errors = [];
let token, browser, page;
const settings = '[role="dialog"][aria-label="显示设置"]';
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.ok(response.ok && result.ok, `${method} ${route}: ${result.error}`); return result.value;
}
async function click(label, scope = 'body') {
  const handle = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)].find(button =>
    (button.textContent.trim() === label || button.getAttribute('aria-label') === label || button.title === label) && button.getClientRects().length), { label, scope });
  assert.ok(handle.asElement(), `Button ${label}`); assert.equal(await handle.evaluate(button => button.disabled), false);
  await handle.asElement().click(); await handle.dispose();
}
async function expectText(id, col, value) {
  await page.waitForFunction((selector, value) => document.querySelector(selector)?.textContent.trim() === value, {}, cell(id, col), value);
}
async function selectRange(start, end, drag = false) {
  if (drag) {
    const from = await page.$eval(start, element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
    const to = await page.$eval(end, element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  } else {
    await page.click(start); await page.keyboard.down('Shift'); await page.click(end); await page.keyboard.up('Shift');
  }
  const range = await page.$eval('[data-gantt-grid]', element => element.dataset.gridRange.split(',').map(Number));
  assert.ok(range[1] > range[0], `Multirow range: ${range}`);
}
async function fillDown(key = 'Control') {
  await page.keyboard.down(key); await page.keyboard.press('d'); await page.keyboard.up(key);
}
async function main() {
  const login = process.env.FILTER_FILL_TEST_USER || 'root', password = process.env.FILTER_FILL_TEST_PASSWORD || 'root123';
  token = (await api('/auth/login', 'POST', { login, password })).token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', login); await page.type('input[type="password"]', password); await click('登录');
  await page.waitForSelector('a[href="/dashboard"], h1');
  for (const precision of ['day', 'minute']) {
    const minute = precision === 'minute', ids = Object.fromEntries(['p1', 'a', 'hidden1', 'p2', 'b', 'hidden2', 'p3', 'c'].map(key => [key, randomUUID()]));
    const project = await api('/projects', 'POST', { name: `筛选填充验收-${precision}-${randomUUID().slice(0, 8)}`, time_granularity: precision, use_template: false });
    projects.push(project);
    const start = minute ? '2026-11-05T09:15:00' : '2026-11-05T00:00:00';
    const sourceEnd = minute ? '2026-11-05T10:45:00' : '2026-11-08T00:00:00';
    const targetEnd = minute ? '2026-11-05T09:45:00' : '2026-11-06T00:00:00';
    const tasks = Object.entries(ids).map(([key, id], order) => ({ id, parent_id: ({ a: ids.p1, hidden1: ids.p1, b: ids.p2, hidden2: ids.p2, c: ids.p3 })[key] || null,
      task_code: String(order + 1), name: key, assignee: key === 'a' ? '张三' : ['b', 'c'].includes(key) ? '李四' : '王五', order_index: order,
      auto_schedule: false, start_date: start, end_date: key === 'a' ? sourceEnd : targetEnd, duration: key === 'a' ? (minute ? 90 : 4320) : (minute ? 30 : 1440) }));
    await api(`/tasks/${project.id}`, 'POST', tasks);
    const before = await api(`/tasks/${project.id}`);
    await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: {
      id: 'current', name: '项目布局', search: '', columns: ['assignee', 'duration', 'start', 'end'], colW: minute ? 720 : 28, critical: false,
      indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null,
        widths: {}, nameWidth: 220, panelWidth: 950, panelCollapsed: false, rightCollapsed: false, centerTime: Date.parse(start), scrollTop: 0 },
    } });
    await page.goto(`${base}/projects/${project.id}`, { waitUntil: 'networkidle0' });
    // Full navigation requires login again in the current auth flow.
    if (await page.$('input[type="password"]')) {
      await page.type('input[type="text"]', login); await page.type('input[type="password"]', password); await click('登录');
      await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`);
    }
    await page.waitForSelector(cell(ids.a, 'duration'));
    const filterButton = await page.evaluateHandle(() => [...document.querySelectorAll('[draggable]')]
      .find(element => [...element.querySelectorAll('span')].some(span => span.textContent === '责任人'))?.querySelector('button[title="筛选"]'));
    assert.ok(filterButton.asElement()); await filterButton.asElement().click(); await filterButton.dispose();
    // With no active filter every value starts checked; exclude the hidden owner.
    for (const value of ['王五']) {
      const option = await page.evaluateHandle(value => [...document.querySelectorAll('div')].find(element =>
        element.textContent.trim() === value && element.querySelector(':scope > input[type="checkbox"]')), value);
      assert.ok(option.asElement(), `Filter ${value}`); await option.asElement().click(); await option.dispose();
    }
    await page.click('h1');
    await page.waitForFunction(ids => !document.querySelector(`[data-task-row="${ids.hidden1}"]`) && document.querySelector(`[data-task-row="${ids.p2}"]`), {}, ids);
    assert.deepEqual(await page.$$eval('[data-task-row]', rows => rows.map(row => row.dataset.taskRow)), [ids.p1, ids.a, ids.p2, ids.b, ids.p3, ids.c]);
    await selectRange(cell(ids.a, 'duration'), cell(ids.c, 'duration'));
    await fillDown();
    for (const id of [ids.a, ids.b, ids.c]) await expectText(id, 'duration', minute ? '90分钟' : '3天');
    assert.deepEqual(await api(`/tasks/${project.id}`), before, 'fill stays in draft');
    await page.click('button[title^="撤销"]');
    await expectText(ids.b, 'duration', minute ? '30分钟' : '1天');
    await selectRange(cell(ids.c, 'end'), cell(ids.a, 'start'), true); await fillDown('Meta');
    await expectText(ids.b, 'end', minute ? '26-11-05 10:45' : '26-11-08');
    await page.click('button[title^="撤销"]'); await expectText(ids.b, 'end', minute ? '26-11-05 09:45' : '26-11-06');
    await selectRange(cell(ids.a, 'assignee'), cell(ids.c, 'assignee'), true); await fillDown();
    for (const id of [ids.b, ids.c]) await expectText(id, 'assignee', '张三');
    await page.click('button[title^="撤销"]'); await expectText(ids.b, 'assignee', '李四');
    await page.click('button[title^="重做"]'); await expectText(ids.b, 'assignee', '张三');
    await page.waitForFunction(() => !document.querySelector('[data-action="save-plan"]').disabled); await page.click('[data-action="save-plan"]');
    await page.waitForFunction(() => { const button = document.querySelector('[data-action="save-plan"]'); return button.disabled && !button.textContent.includes('保存中'); });
    const after = await api(`/tasks/${project.id}`);
    for (const key of ['hidden1', 'hidden2', 'p1', 'p2', 'p3']) assert.equal(after.tasks.find(task => task.id === ids[key]).assignee, '王五');
    for (const key of ['a', 'b', 'c']) assert.equal(after.tasks.find(task => task.id === ids[key]).assignee, '张三');
    await click('显示设置'); await click('常用布局', settings);
    const saved = page.waitForResponse(response => response.url().endsWith('/view-preferences') && response.request().method() === 'PUT' && response.ok());
    await click('保存当前布局', settings); await saved;
    assert.deepEqual((await api(`/projects/${project.id}/view-preferences`)).currentView.chart.filters.assignee, ['张三', '李四']);
    await click('关闭显示设置'); await page.click('a[href="/dashboard"]');
    await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`);
    await page.waitForSelector(`[data-gantt-grid][data-project-id="${project.id}"]`);
    await page.waitForFunction(ids => !document.querySelector(`[data-task-row="${ids.hidden1}"]`) && document.querySelector(`[data-task-row="${ids.c}"]`), {}, ids);
    assert.deepEqual(await page.$$eval('[data-task-row]', rows => rows.map(row => row.dataset.taskRow)), [ids.p1, ids.a, ids.p2, ids.b, ids.p3, ids.c]);
    await expectText(ids.b, 'assignee', '张三');
    await page.screenshot({ path: `/private/tmp/gantt-filter-fill-${precision}.png`, fullPage: true });
    console.log(`PASS ${precision}: actual assignee filter, cross-parent Ctrl/Command+D, reverse drag, dates, assignee drag range, undo/redo, draft isolation, saved results and layout restoration`);
  }
  assert.deepEqual(errors, []);
}
main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: '/private/tmp/gantt-filter-fill-failure.png', fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close();
  for (const project of projects) await api(`/projects/${project.id}`, 'DELETE').catch(console.error);
});
