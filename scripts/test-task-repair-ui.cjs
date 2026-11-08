// Real clicks and database checks in disposable projects; never edit user plans.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3117';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-repair-ui-'));
const report = { base, output, steps: [], writes: [], pageErrors: [], fixturesCleaned: [], passed: false };
const fixtures = [];
const dialog = '[role="dialog"][aria-label="任务检查与修复"]';
const review = '[role="dialog"][aria-label="变更审核"]';
const login = process.env.ATTR_UI_USER || 'admin', password = process.env.ATTR_UI_PASSWORD || 'admin123';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const day = offset => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const date = (offset, time = '00:00') => `${day(offset)}T${time}:00`;
const normalized = value => String(value).replace(' ', 'T').slice(0, 16);
let token, project, page, browser, clicks = 0;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
const state = () => api(`/tasks/${project.id}`);
const versions = () => api(`/versions/${project.id}?list=1`);
function pass(message) { report.steps.push(message); console.log(`PASS ${message}`); }
async function click(label, scope = 'body') {
  const handle = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(button => (button.textContent.trim() === label || button.getAttribute('aria-label') === label) && button.getClientRects().length), { label, scope });
  assert.ok(handle.asElement(), `Missing button: ${label}`);
  assert.equal(await handle.evaluate(button => button.disabled), false);
  const before = await page.evaluate(() => window.__trustedClicks);
  await handle.asElement().click({ delay: 50 }); await handle.dispose();
  await page.waitForFunction(count => window.__trustedClicks > count, {}, before);
}
async function openCheck() { await click('任务操作'); await click('检查与修复'); await page.waitForSelector(dialog); }
async function previewIds(expected) {
  assert.deepEqual((await page.$$eval('[data-repair-task]', rows => rows.map(row => row.dataset.repairTask))).sort(), [...expected].sort());
}
async function saved() {
  await page.waitForFunction(() => { const button = document.querySelector('[data-action="save-plan"]'); return button?.disabled && !button.textContent.includes('保存中'); });
  assert.deepEqual(report.pageErrors, []);
}
async function loginAndOpen() {
  await page.waitForFunction(() => { const form = document.querySelector('form'); return form && Object.keys(form).some(key => key.startsWith('__reactProps$')); });
  await page.type('input[type=text]', login); await page.type('input[type=password]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
}
async function waitForProject() {
  await page.waitForFunction(() => location.pathname === '/login' || document.querySelector('[data-task-row]'));
  if (new URL(page.url()).pathname === '/login') await loginAndOpen();
  else await page.waitForSelector('[data-task-row]');
}
async function reload() {
  clicks += await page.evaluate(() => window.__trustedClicks);
  await page.reload({ waitUntil: 'networkidle2' }); await waitForProject();
}
async function makeProject(granularity, statusDate) {
  project = await api('/projects', 'POST', { name: `任务修复验收-${granularity}-${randomUUID().slice(0, 8)}`, start_date: day(12),
    status_date: statusDate, planning_status: 'draft', time_granularity: granularity, use_template: false });
  fixtures.push(project);
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  await makeProject('day', date(0));
  const ids = Array.from({ length: 12 }, randomUUID);
  const [summary, child, childManual, root, successor, manual, none, alap, inactive, started, disabledDep, past] = ids;
  const make = (id, name, patch = {}) => ({ id, name, task_code: String(ids.indexOf(id) + 1), parent_id: null, order_index: ids.indexOf(id),
    start_date: date(12), end_date: date(14), duration: 2880, duration_unit: 'day', auto_schedule: true, constraint_type: 'asap', ...patch });
  const tasks = [make(summary, '摘要'), make(child, '待修复子任务', { parent_id: summary }),
    make(childManual, '手动子任务', { parent_id: summary, auto_schedule: false, start_date: date(14), end_date: date(15), duration: 1440 }),
    make(root, '待修复独立任务'), make(successor, '自动后续任务', { start_date: date(14), end_date: date(16) }),
    make(manual, '手动任务', { auto_schedule: false }), make(none, '无限制任务', { constraint_type: 'none' }),
    make(alap, '尽晚任务', { constraint_type: 'alap' }), make(inactive, '无效任务', { inactive: true }),
    make(started, '今天已开始', { start_date: date(0), end_date: date(2) }), make(disabledDep, '已配置停用前置'),
    make(past, '已开始任务', { start_date: date(-4), end_date: date(-2) })];
  await api(`/tasks/${project.id}`, 'POST', tasks);
  await api(`/dependencies/${project.id}`, 'POST', { from_task_id: root, to_task_id: successor, type: 2 });
  await api(`/dependencies/${project.id}`, 'POST', { from_task_id: manual, to_task_id: disabledDep, type: 2, active: false });
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
  await page.evaluateOnNewDocument(() => { window.__trustedClicks = 0; document.addEventListener('click', event => { if (event.isTrusted) window.__trustedClicks++; }, true); });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', async popup => { report.pageErrors.push(popup.message()); await popup.accept(); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/login') {
      if (!fixtures.some(fixture => pathname.includes(fixture.id))) { report.pageErrors.push(`Blocked non-fixture mutation: ${pathname}`); return request.abort(); }
      report.writes.push({ pathname, method: request.method() });
    }
    return request.continue();
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await loginAndOpen();
  const initial = await state(), line = await page.$eval('[data-status-date-handle="body"]', element => element.getAttribute('aria-valuetext'));
  assert.equal(await page.$eval('[data-action="save-plan"]', button => button.disabled), true);
  await openCheck(); await previewIds([summary, child, root, successor]);
  assert.ok(await page.$eval(dialog, (element, today) => element.textContent.includes(today) && element.textContent.includes('发现 2 个待修复任务'), today));
  await page.screenshot({ path: path.join(output, 'day-preview.png'), fullPage: true });
  await click('取消', dialog); assert.deepEqual(await state(), initial); assert.equal(report.writes.length, 0);
  pass('全项目检查只命中自动、尽早、无前置且未来开始的任务，预览含摘要/后续联动；取消不修改后台');

  await openCheck(); await click('修复 2 个任务', dialog); await page.waitForSelector(dialog, { hidden: true });
  await openCheck(); await previewIds([]); assert.ok(await page.$eval(dialog, element => element.textContent.includes('没有需要修复的任务'))); await click('取消', dialog);
  await page.click('button[title^="撤销"]'); await openCheck(); await previewIds([summary, child, root, successor]); await click('取消', dialog);
  await page.click('button[title^="重做"]'); assert.equal(report.writes.length, 0); assert.deepEqual(await state(), initial);
  assert.equal(await page.$eval('[data-status-date-handle="body"]', element => element.getAttribute('aria-valuetext')), line);
  pass('修复含全部联动可一步撤销/重做，修复前后未写库，状态日期线不变，重复检查无待修复项');

  await click('保存', '[data-toolbar-row="progress"]'); await saved(); assert.equal(await page.$(review), null);
  const persisted = await state();
  for (const id of [root, child]) {
    const task = persisted.tasks.find(task => task.id === id);
    assert.equal(normalized(task.start_date), `${today}T00:00`); assert.equal(normalized(task.end_date), `${day(2)}T00:00`);
    assert.equal(task.duration, 2880); assert.equal(task.auto_schedule, true);
  }
  assert.equal(normalized(persisted.tasks.find(task => task.id === successor).start_date), `${day(2)}T00:00`);
  const changedIds = new Set([summary, child, root, successor]);
  for (const before of initial.tasks.filter(task => !changedIds.has(task.id))) assert.deepEqual(persisted.tasks.find(task => task.id === before.id), before);
  assert.equal((await versions()).length, 0);
  await reload(); await saved(); await openCheck(); await previewIds([]); await click('取消', dialog);
  assert.deepEqual(await state(), persisted);
  pass('草稿直接保存，无审核/原因/版本；工期与自动属性保留，其他任务不变，重进项目不回退');

  // Restore only the fixture dates to exercise the stable review path.
  await api(`/tasks/${project.id}`, 'PUT', tasks);
  await reload(); await page.select('select[aria-label="计划状态"]', 'stable');
  await openCheck(); await click('修复 2 个任务', dialog); await click('确认变更'); await page.waitForSelector(review);
  assert.equal(await page.$eval(review, element => [...element.querySelectorAll('button')].find(button => button.textContent.trim() === '确认并保存').disabled), true);
  const reasons = await page.$$(`${review} textarea[aria-required=true]`); assert.ok(reasons.length >= 2);
  for (const reason of reasons) await reason.type('检查发现无前置任务，按今天启动计划');
  await page.screenshot({ path: path.join(output, 'stable-review.png'), fullPage: true });
  await click('确认并保存', review); await saved();
  const snapshots = await versions(); assert.equal(snapshots.length, 1);
  const snapshot = await api(`/versions/${project.id}?id=${snapshots[0].id}`);
  assert.equal(normalized(snapshot.snapshot.tasks.find(task => task.id === root).start_date), `${today}T00:00`);
  assert.equal(normalized((await api(`/projects/${project.id}`)).status_date), `${today}T00:00`);
  await reload(); await saved();
  pass('稳定态修复仍要求原因，保存后版本、数据库与状态日期一致');

  await makeProject('minute', null);
  const minuteId = randomUUID();
  await api(`/tasks/${project.id}`, 'POST', [{ id: minuteId, name: '分钟任务', task_code: '1', parent_id: null, order_index: 0,
    start_date: date(12, '23:30'), end_date: date(13, '01:05'), duration: 95, duration_unit: 'minute', auto_schedule: true, constraint_type: 'asap' }]);
  clicks += await page.evaluate(() => window.__trustedClicks);
  await page.goto(`${base}/projects/${project.id}`, { waitUntil: 'networkidle2' }); await waitForProject(); await saved();
  await openCheck(); await previewIds([minuteId]);
  assert.ok(await page.$eval(dialog, (element, today) => element.textContent.includes(`${today} 23:30`) && element.textContent.includes('保留原来的时分'), today));
  await page.screenshot({ path: path.join(output, 'minute-preview.png'), fullPage: true });
  await click('修复 1 个任务', dialog); await click('保存', '[data-toolbar-row="progress"]'); await saved();
  const minute = (await state()).tasks[0];
  assert.equal(normalized(minute.start_date), `${today}T23:30`); assert.equal(normalized(minute.end_date), `${day(1)}T01:05`); assert.equal(minute.duration, 95);
  await reload(); await saved(); await openCheck(); await previewIds([]); await click('取消', dialog);
  assert.equal(normalized((await state()).tasks[0].start_date), `${today}T23:30`); assert.equal((await versions()).length, 0);
  pass('分钟级保留时分和 95 分钟工期；无状态日期、项目开始在未来时，修复保存后刷新仍保持当天');
  assert.deepEqual(report.pageErrors, []); report.trustedClicks = clicks + await page.evaluate(() => window.__trustedClicks); report.passed = true;
}
main().catch(async error => {
  report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  for (const fixture of fixtures) {
    try { assert.equal((await api(`/projects/${fixture.id}`)).name, fixture.name); await api(`/projects/${fixture.id}`, 'DELETE'); report.fixturesCleaned.push(fixture.id); }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, steps: report.steps.length, cleaned: report.fixturesCleaned.length, report: path.join(output, 'report.json') }));
});
