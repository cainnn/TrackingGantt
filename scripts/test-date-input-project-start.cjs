// Live database and actual browser typing; all writes are confined to disposable fixtures.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3127';
const projects = [], users = [], errors = [];
const modal = '[role="dialog"][aria-label="编辑任务"]';
const settings = '[role="dialog"][aria-label="显示设置"]';
let token, browser, page;
async function api(route, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}/api${route}`, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.equal(response.status, expected, `${method} ${route}: ${data.error || response.status}`);
  assert.equal(data.ok, expected < 400); return data.value;
}
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
async function click(label, scope = 'body') {
  const h = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)].find(b =>
    (b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.title === label) && b.getClientRects().length), { label, scope });
  assert.ok(h.asElement(), `Visible button ${label}`); assert.equal(await h.evaluate(b => b.disabled), false, `${label} enabled`);
  await h.asElement().click(); await h.dispose();
}
async function fill(selector, value) {
  const input = await page.$(selector); assert.ok(input, selector);
  await input.focus(); await input.evaluate(element => element.select()); await input.dispose();
  await page.keyboard.press('Backspace');
  if (value) await page.type(selector, value, { delay: 15 });
  assert.equal(await page.$eval(selector, element => element.value), value, `Typed ${value}`);
}
async function text(id, col, value) {
  await page.waitForFunction((selector, value) => document.querySelector(selector)?.textContent.trim() === value, {}, cell(id, col), value);
}
async function editDate(id, col, value, key = 'Enter') {
  await page.click(cell(id, col), { count: 2 }); const selector = `${cell(id, col)} input[type="text"]`;
  await page.waitForSelector(selector); await fill(selector, value); await page.keyboard.press(key);
  await page.waitForSelector(selector, { hidden: true });
  assert.ok(await page.$eval('[data-timeline-scroll]', e => e.scrollWidth < 100000), 'calendar stays within a bounded date range');
}
async function save() {
  await page.waitForFunction(() => document.querySelector('[data-action="save-plan"]')?.disabled === false);
  await page.click('[data-action="save-plan"]');
  await page.waitForFunction(() => { const button = document.querySelector('[data-action="save-plan"]'); return button?.disabled === true && !button.textContent.includes('保存中'); });
}
async function columns() {
  await click('显示设置'); await click('全不选', settings);
  for (const label of ['开始时间', '完成时间', '持续时间']) {
    const checkbox = await page.evaluateHandle(({ label, settings }) => [...document.querySelectorAll(`${settings} label`)]
      .find(e => e.textContent.trim() === label)?.querySelector('input'), { label, settings });
    assert.ok(checkbox.asElement()); await checkbox.asElement().click(); await checkbox.dispose();
  }
  await click('关闭显示设置');
}
async function openTask(id) { await page.click(cell(id, 'name')); await click('编辑任务'); await page.waitForSelector(modal); }
function pass(message) { console.log(`PASS ${message}`); }
async function main() {
  token = (await api('/auth/login', 'POST', { login: process.env.DATE_TEST_ROOT || 'root', password: process.env.DATE_TEST_PASSWORD || 'root123' })).token;
  const suffix = randomUUID().slice(0, 8), username = `date-${suffix}`, password = randomUUID();
  const user = await api('/users', 'POST', { username, password, email: `${username}@example.test`, role: 'admin' }, 201); users.push(user);
  for (const precision of ['day', 'minute']) {
    const project = await api('/projects', 'POST', { name: `日期修复验收-${suffix}-${precision}`, time_granularity: precision,
      start_date: '2026-11-06', status_date: null, use_template: false }, 201);
    projects.push(project); assert.equal(project.start_date, null);
    await api('/users/projects', 'POST', { userId: user.id, projectId: project.id });
  }
  const [project, minute] = projects;
  const [first, blocked, next, manual, minuteTask] = Array.from({ length: 5 }, randomUUID);
  const make = (id, name, start, end, order, extra = {}) => ({ id, name, task_code: String(order + 1), order_index: order,
    start_date: start, end_date: end, duration: (Date.parse(end) - Date.parse(start)) / 60000, auto_schedule: true, ...extra });
  await api(`/tasks/${project.id}`, 'POST', [make(first, '项目立项', '2026-08-10', '2026-08-18', 0, { auto_schedule: false }),
    make(blocked, '封网', '2026-08-18', '2026-08-27', 1), make(next, '提交采购', '2026-08-27', '2026-09-01', 2),
    make(manual, '数字日期录入', '2026-08-10', '2026-08-27', 3, { auto_schedule: false })], 201);
  for (const [from, to] of [[first, blocked], [blocked, next]]) await api(`/dependencies/${project.id}`, 'POST', { from_task_id: from, to_task_id: to, type: 2 }, 201);
  await api(`/tasks/${minute.id}`, 'POST', [make(minuteTask, '分钟日期录入', '2026-08-14T09:35:00', '2026-08-14T11:00:00', 0, { auto_schedule: false, duration_unit: 'minute' })], 201);
  assert.equal((await api(`/projects/${project.id}`)).start_date, '2026-08-10T00:00:00');
  assert.equal((await api(`/projects/${minute.id}`)).start_date, '2026-08-14T09:35:00');
  assert.equal((await api(`/projects/${project.id}`, 'PUT', { start_date: '2030-01-01' })).start_date, '2026-08-10T00:00:00');
  pass('project metadata follows task minimum and ignores independent manual start overrides');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1080 }); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', async dialog => {
    if (/开始.*晚于|失败|error/i.test(dialog.message())) errors.push(dialog.message()); await dialog.accept();
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', username); await page.type('input[type="password"]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`);
  assert.equal(await page.$eval(`[data-project-start="${project.id}"]`, e => e.textContent), '2026-08-10');
  await page.click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]'); await columns();
  await openTask(blocked); await click('注释', modal); await fill(`${modal} textarea`, '普通编辑账号验证：封网原有日期不应被项目日期改写');
  await click('保存', modal); await page.waitForSelector(modal, { hidden: true }); await save();
  const saved = (await api(`/tasks/${project.id}`)).tasks.find(t => t.id === blocked);
  assert.equal(saved.start_date, '2026-08-18T00:00:00'); assert.equal(saved.end_date, '2026-08-27T00:00:00');
  assert.match(saved.note, /普通编辑账号验证/);
  pass('ordinary admin edits and saves the reported 封网 case without changing its valid dates');
  let typed = 0;
  for (const [input, key] of [['20260814', 'Enter'], ['260814', 'Tab'], ['0814', 'Enter']]) {
    if (typed++) { await editDate(manual, 'start', '20260810'); await save(); }
    await editDate(manual, 'start', input, key);
    await text(manual, 'start', '26-08-14'); await save();
    assert.equal((await api(`/tasks/${project.id}`)).tasks.find(t => t.id === manual).start_date, '2026-08-14T00:00:00');
  }
  await page.click(cell(manual, 'start'), { count: 2 }); await fill(`${cell(manual, 'start')} input`, '260230'); await page.keyboard.press('Tab');
  assert.ok(await page.$(`${cell(manual, 'start')} input`)); await page.keyboard.press('Escape'); await text(manual, 'start', '26-08-14');
  pass('eight-, six- and four-digit dates survive real typing, Enter/Tab and database save; invalid dates stay editable');
  await openTask(manual);
  await fill(`${modal} input[placeholder="YYYY-MM-DD"]`, '20260809'); await page.keyboard.press('Enter');
  assert.equal(await page.$eval(`${modal} input[placeholder="YYYY-MM-DD"]`, input => input.value), '2026-08-09');
  await click('保存', modal); await page.waitForSelector(modal, { hidden: true }); await text(manual, 'start', '26-08-09'); await save();
  assert.equal((await api(`/projects/${project.id}`)).start_date, '2026-08-09T00:00:00');
  await editDate(manual, 'start', '20260814'); await save();
  pass('task dialog accepts compact dates earlier than the previous project start without clamping');
  const status = '[data-toolbar-row="progress"] input[placeholder="YYYY-MM-DD"]';
  await fill(status, '260814'); await page.keyboard.press('Enter'); await save();
  assert.equal((await api(`/projects/${project.id}`)).status_date, '2026-08-14T00:00:00');
  await editDate(first, 'start', '20260809'); await save();
  assert.equal((await api(`/projects/${project.id}`)).start_date, '2026-08-09T00:00:00');
  await api(`/tasks/${project.id}`, 'DELETE', { ids: [first] });
  assert.equal((await api(`/projects/${project.id}`)).start_date, '2026-08-14T00:00:00');
  pass('status-date text entry also normalizes once, and moving/deleting the earliest task resynchronizes the project');
  await page.click('a[href="/dashboard"]'); await page.waitForSelector(`a[href="/projects/${minute.id}"]`);
  await page.click(`a[href="/projects/${minute.id}"]`); await page.waitForSelector('[data-task-row]'); await columns();
  await editDate(minuteTask, 'start', '260814 10:15'); await save();
  assert.equal((await api(`/projects/${minute.id}`)).start_date, '2026-08-14T10:15:00');
  assert.equal((await api(`/tasks/${minute.id}`)).tasks[0].duration, 45);
  assert.deepEqual(errors, []);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-date-start-'));
  await page.screenshot({ path: path.join(output, 'verified.png'), fullPage: true }); console.log(`Screenshot: ${output}/verified.png`);
  pass('minute precision and project/role isolation remain intact; no browser errors');
}
main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page) { const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-date-failure-')); await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ url: page.url(), errors, output }); }
}).finally(async () => {
  if (browser) await browser.close();
  for (const project of projects) await api(`/projects/${project.id}`, 'DELETE').catch(console.error);
  for (const user of users) await api('/users', 'DELETE', { userId: user.id }).catch(console.error);
});
