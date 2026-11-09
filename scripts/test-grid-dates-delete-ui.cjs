// Real browser controls + real disposable project. TSV paste events are supplied
// directly to the grid so this test never replaces the user's system clipboard.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3117';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-grid-dates-delete-'));
const report = { base, output, steps: [], writes: [], pageErrors: [], confirmations: [], clipboardMode: 'DOM paste events; system clipboard untouched', passed: false };
let token, project, browser, page, cancelDelete = false;
const fixtures = [];
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
const state = () => api(`/tasks/${project.id}`);
function pass(text) { report.steps.push(text); console.log(`PASS ${text}`); }
async function click(label, scope = 'body') {
  const handle = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(button => (button.textContent.trim() === label || button.getAttribute('aria-label') === label) && button.getClientRects().length), { label, scope });
  assert.ok(handle.asElement(), `Visible button ${label}`); assert.equal(await handle.evaluate(button => button.disabled), false);
  await handle.asElement().click({ delay: 45 }); await handle.dispose();
}
async function text(id, col, value) { await page.waitForFunction((selector, expected) => document.querySelector(selector)?.textContent.trim() === expected, {}, cell(id, col), value); }
async function fill(selector, value) { await page.click(selector, { count: 3 }); await page.keyboard.press('Backspace'); await page.type(selector, value); }
async function paste(value) {
  await page.evaluate(value => { const data = new DataTransfer(); data.setData('text/plain', value); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, value);
}
async function copy() {
  return page.evaluate(() => { const data = new DataTransfer(); document.activeElement.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })); return data.getData('text/plain'); });
}
async function fillDown(modifier = 'Control') {
  await page.keyboard.down(modifier); await page.keyboard.press('d'); await page.keyboard.up(modifier);
}
async function saved() { await page.waitForFunction(() => { const button = document.querySelector('[data-action="save-plan"]'); return button?.disabled && !button.textContent.includes('保存中'); }); }
async function aligned() {
  const delta = await page.evaluate(() => Math.abs(document.querySelector('[data-task-row]').getBoundingClientRect().top - document.querySelector('[data-timeline-scroll]').getBoundingClientRect().top));
  assert.ok(delta <= 5, `Grid/timeline row alignment: ${delta}px`);
}
async function dateColumns() {
  await click('显示设置'); const settings = '[role="dialog"][aria-label="显示设置"]'; await click('全不选', settings);
  for (const label of ['持续时间', '开始时间', '完成时间', '截止日期']) {
    const checkbox = await page.evaluateHandle(({ settings, label }) => [...document.querySelectorAll(`${settings} label`)].find(element => element.textContent.trim() === label)?.querySelector('input'), { settings, label });
    assert.ok(checkbox.asElement()); await checkbox.asElement().click(); await checkbox.dispose();
  }
  await click('关闭显示设置');
}
async function range(from, to, shift = false) {
  const center = async selector => {
    const element = await page.$(selector); assert.ok(element, selector);
    const box = await element.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  if (shift) {
    await page.click(from); await page.keyboard.down('Shift'); await page.click(to); await page.keyboard.up('Shift');
  } else {
    const start = await center(from), end = await center(to);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 }); await page.mouse.up();
  }
}
async function login() {
  await page.waitForFunction(() => { const form = document.querySelector('form'); return form && Object.keys(form).some(key => key.startsWith('__reactProps$')); });
  await page.type('input[type=text]', 'admin'); await page.type('input[type=password]', 'admin123'); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
}
async function main() {
  token = (await api('/auth/login', 'POST', { login: 'admin', password: 'admin123' })).token;
  project = await api('/projects', 'POST', { name: `日期与删除验收-${randomUUID().slice(0, 8)}`, start_date: '2026-01-01', status_date: '2026-11-01', planning_status: 'draft', time_granularity: 'day', use_template: false });
  fixtures.push(project);
  const [a, b, p, c, g, h, moved, other] = Array.from({ length: 8 }, randomUUID);
  const make = (id, name, parent_id, order_index, patch = {}) => ({ id, name, parent_id, order_index, start_date: '2026-11-01', end_date: '2026-11-02', duration: 1440, auto_schedule: false, constraint_type: 'asap', ...patch });
  await api(`/tasks/${project.id}`, 'POST', [make(a, '日期任务 A', null, 0), make(b, '日期任务 B', null, 1, { auto_schedule: true, start_date: '2026-11-02', end_date: '2026-11-03' }),
    make(p, '删除父任务', null, 2), make(c, '子任务', p, 0), make(g, '孙任务', c, 0), make(h, '另一个子任务', p, 1), make(moved, '移出后保留', p, 2), make(other, '外部任务', null, 3)]);
  await api(`/dependencies/${project.id}`, 'POST', { from_task_id: a, to_task_id: b, type: 2 });
  await api(`/dependencies/${project.id}`, 'POST', { from_task_id: g, to_task_id: other, type: 2 });
  const baseline = await state(), projectBefore = await api(`/projects/${project.id}`);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080, deviceScaleFactor: 2 });
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', async dialog => {
    report.confirmations.push(dialog.message());
    if (cancelDelete && dialog.type() === 'confirm') { cancelDelete = false; await dialog.dismiss(); }
    else { if (/保存失败|error/i.test(dialog.message())) report.pageErrors.push(dialog.message()); await dialog.accept(); }
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/login') {
      if (!pathname.includes(project.id)) { report.pageErrors.push(`Blocked mutation outside fixture ${pathname}`); return request.abort(); }
      report.writes.push({ pathname, method: request.method() });
    }
    return request.continue();
  });
  await page.goto(base + '/login', { waitUntil: 'networkidle2' }); await login(); await saved();
  for (const label of ['新建任务', '编辑任务', '删除选中任务']) {
    const button = await page.$(`[data-toolbar-row="tasks"] button[aria-label="${label}"]`); assert.ok(button);
    assert.equal(await button.evaluate(element => element.textContent.trim()), ''); assert.equal((await button.$$('svg')).length, 1);
    if (label !== '新建任务') assert.equal(await button.evaluate(element => element.disabled), true);
  }
  await click('新建任务'); assert.equal((await page.$$('[data-task-row]')).length, 9); await page.click('button[title^="撤销"]');
  assert.equal((await page.$$('[data-task-row]')).length, 8); await saved();
  await dateColumns(); await text(a, 'start', '26-11-01'); await text(a, 'end', '26-11-02');
  await page.click(cell(a, 'start'), { count: 2 });
  const startInput = `${cell(a, 'start')} input[type=text]`;
  await page.waitForSelector(startInput); assert.equal(await page.$eval(startInput, input => input.value), '26-11-01');
  await fill(startInput, '2026/10/31'); await page.keyboard.press('Enter'); await text(a, 'start', '26-10-31');
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-01'); await saved();
  await page.click(cell(a, 'start'), { count: 2 }); await fill(startInput, '20260808'); await page.keyboard.press('Enter'); await text(a, 'start', '26-08-08');
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-01'); await saved();
  await page.click(cell(a, 'start'), { count: 2 }); await fill(startInput, '26-10-29'); await page.keyboard.press('Escape'); await text(a, 'start', '26-11-01'); await saved();
  await page.click(cell(a, 'start'), { count: 2 });
  assert.equal(await page.$(`${cell(a, 'start')} input[type=date]`), null);
  assert.equal(await page.$(`${cell(a, 'start')} button`), null);
  await page.keyboard.press('Tab'); await page.waitForSelector(startInput, { hidden: true }); await saved();
  await page.screenshot({ path: path.join(output, 'year-month-day-editing.png'), fullPage: true });
  pass('英文浏览器下表格与编辑框显示两位年-月-日，支持20260808和完整年份直接输入、Enter/Tab/Esc，无日历选择');

  await page.click(cell(a, 'start')); await paste('2026/11/4\t26-11-08\r\n2026年11月5日\t46337\r\n');
  await text(a, 'start', '26-11-04'); await text(a, 'end', '26-11-08'); await text(b, 'start', '26-11-05'); await text(b, 'end', '26-11-11');
  assert.ok(await page.$eval('body', body => body.textContent.includes('1 个自动排程任务已转为手动排程')));
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-01'); await text(b, 'start', '26-11-02'); await saved();
  await page.click('button[title^="重做"]'); await text(a, 'start', '26-11-04'); await text(b, 'start', '26-11-05');
  await page.click(cell(a, 'start')); await paste('20260808\t20260810\n20260809\t20260812');
  await text(a, 'start', '26-08-08'); await text(b, 'end', '26-08-12');
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-04'); await text(b, 'start', '26-11-05');
  await page.click(cell(a, 'start')); await paste('26/11/9\t26/11/12\n26/2/30\t26/3/1');
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(element => element.textContent.includes('第 2 行、第 1 列')));
  await text(a, 'start', '26-11-04'); await text(b, 'start', '26-11-05');
  await page.click(cell(a, 'start'), { count: 2 }); await page.waitForSelector(startInput);
  await paste('26-11-06\t26-11-09\n2026/11/7\t2026/11/12');
  await text(a, 'start', '26-11-06'); await text(b, 'start', '26-11-07');
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-04'); await text(b, 'start', '26-11-05');
  assert.deepEqual(await state(), baseline); assert.equal(report.writes.length, 0);
  await page.screenshot({ path: path.join(output, 'excel-date-region.png'), fullPage: true });
  pass('Excel 两行两列日期、中文日期和序列号原子粘贴，自动日期转手动并提示；编辑中粘贴也支持，整步撤销，错误行不覆盖任何内容');

  await range(cell(b, 'end'), cell(a, 'start'));
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,1,2,3');
  await paste('20260808\t20260810\n20260809\t20260812');
  await text(a, 'start', '26-08-08'); await text(b, 'end', '26-08-12');
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-04'); await text(b, 'start', '26-11-05');
  await range(cell(a, 'duration'), cell(b, 'duration'), true); await paste('5天');
  await text(a, 'duration', '5天'); await text(b, 'duration', '5天'); await text(a, 'end', '26-11-09'); await text(b, 'end', '26-11-10');
  await page.click('button[title^="撤销"]'); await text(a, 'duration', '4天'); await text(b, 'duration', '6天');
  await page.click(cell(a, 'duration')); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,1,1,3');
  await paste('3天\t20260808\t20260811\n4天\t20260809\t20260813');
  await text(a, 'duration', '3天'); await text(a, 'start', '26-08-08'); await text(b, 'duration', '4天'); await text(b, 'end', '26-08-13');
  assert.equal(await copy(), '3天\t26-08-08\t26-08-11\r\n4天\t26-08-09\t26-08-13');
  await page.screenshot({ path: path.join(output, 'selected-date-duration-region.png'), fullPage: true });
  await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-04'); await text(b, 'duration', '6天');
  await range(cell(a, 'duration'), cell(b, 'end')); await paste('2天\t20261104');
  await text(a, 'duration', '2天'); await text(a, 'end', '26-11-06'); await text(b, 'duration', '6天');
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,0,1,2');
  await aligned(); await page.click('button[title^="撤销"]'); await text(a, 'duration', '4天');
  await range(cell(a, 'start'), cell(a, 'end')); await paste('20260808\t20260810\n20260809\t20260812');
  await text(a, 'start', '26-08-08'); await text(b, 'end', '26-08-12');
  await aligned(); await page.click('button[title^="撤销"]'); await text(a, 'start', '26-11-04');
  await page.click(cell(a, 'duration')); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,7,1,1');
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,7,1,4');
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), baseline); assert.equal(report.writes.length, 0);
  pass('按 AG Grid 习惯鼠标反向拖选、Shift 连选、Ctrl/⌘+Shift 扩展至边缘，区域复制输出 Excel TSV；不同大小区域粘贴展开/缩小或重复填充，左右行对齐，可整步撤销且保存前零写库');

  await range(cell(b, 'end'), cell(a, 'duration')); await fillDown();
  await text(a, 'start', '26-11-04'); await text(a, 'duration', '4天');
  await text(b, 'start', '26-11-04'); await text(b, 'end', '26-11-08'); await text(b, 'duration', '4天');
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').dataset.gridRange === '0,1,1,3');
  await page.screenshot({ path: path.join(output, 'ctrl-d-fill-down.png'), fullPage: true });
  await fillDown(); await page.waitForFunction(() => document.body.textContent.includes('无需重复填充'));
  await page.click('button[title^="撤销"]'); await text(b, 'start', '26-11-05'); await text(b, 'end', '26-11-11');
  await page.click('button[title^="重做"]'); await text(b, 'start', '26-11-04'); await text(b, 'end', '26-11-08');
  await page.click('button[title^="撤销"]'); await text(b, 'start', '26-11-05');
  await range(cell(a, 'duration'), cell(b, 'duration'), true); await fillDown('Meta');
  await text(b, 'start', '26-11-05'); await text(b, 'end', '26-11-09'); await text(b, 'duration', '4天');
  await page.click('button[title^="撤销"]'); await text(b, 'duration', '6天'); await text(b, 'end', '26-11-11');
  await range(cell(a, 'duration'), cell(c, 'duration')); await fillDown();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(element => element.textContent.includes('只读')));
  await text(b, 'duration', '6天'); await text(a, 'duration', '4天');
  await page.click(cell(a, 'duration')); await fillDown();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(element => element.textContent.includes('至少两行')));
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), baseline); assert.equal(report.writes.length, 0);
  pass('真实 Ctrl+D/⌘+D 将选区可见首行向下填充，反向框选与多列日期/工期均正确；重复填充无新撤销步，错误选区整体拒绝，一步撤销重做且保存前零写库');

  await page.click(cell(a, 'ddate'), { count: 2 }); await page.waitForSelector(`${cell(a, 'ddate')} input[type=text]`);
  await fill(`${cell(a, 'ddate')} input[type=text]`, '26/12/1'); await page.keyboard.press('Enter'); await text(a, 'ddate', '26-12-01');
  await range(cell(a, 'ddate'), cell(b, 'ddate')); await fillDown(); await text(b, 'ddate', '26-12-01');
  await page.click(cell(moved, 'name')); await click('提升任务层级', '[data-toolbar-row="tasks"]');
  await page.waitForFunction(selector => parseFloat(document.querySelector(selector).style.paddingLeft) === 4, {}, cell(moved, 'name'));
  await click('全部折叠', '[data-toolbar-row="tasks"]'); await page.click(cell(p, 'name'));
  await (await page.$('[data-toolbar-row="tasks"]')).screenshot({ path: path.join(output, 'new-edit-delete-icons.png') });
  cancelDelete = true; await click('删除选中任务', '[data-toolbar-row="tasks"]'); assert.ok(await page.$(cell(p, 'name')));
  await click('删除选中任务', '[data-toolbar-row="tasks"]'); await page.waitForSelector(cell(p, 'name'), { hidden: true });
  assert.ok(report.confirmations.at(-1).includes('4 个任务'));
  await click('全部展开', '[data-toolbar-row="tasks"]'); for (const id of [p, c, g, h]) assert.equal(await page.$(cell(id, 'name')), null);
  await page.click('button[title^="撤销"]'); await click('全部展开', '[data-toolbar-row="tasks"]'); for (const id of [p, c, g, h]) assert.ok(await page.$(cell(id, 'name')));
  await page.click('button[title^="重做"]'); await page.waitForSelector(cell(p, 'name'), { hidden: true });
  await page.click('button[title^="撤销"]'); await click('全部展开', '[data-toolbar-row="tasks"]');
  await page.click(cell(p, 'name'), { button: 'right' }); await click('删除任务'); await page.waitForSelector(cell(p, 'name'), { hidden: true });
  assert.deepEqual(await state(), baseline); assert.equal(report.writes.length, 0);
  pass('新建/编辑/删除均纯图标；删除父任务覆盖折叠子任务和孙任务，可取消/整步撤销重做，右键路径一致，已移出的子任务保留');

  await click('保存', '[data-toolbar-row="progress"]'); await saved();
  const persisted = await state(); assert.deepEqual(persisted.tasks.map(task => task.id).sort(), [a, b, moved, other].sort());
  assert.equal(persisted.tasks.find(task => task.id === moved).parent_id, null);
  assert.equal(persisted.tasks.find(task => task.id === a).start_date.slice(0, 10), '2026-11-04');
  assert.equal(persisted.tasks.find(task => task.id === b).start_date.slice(0, 10), '2026-11-05');
  assert.equal(persisted.tasks.find(task => task.id === a).duration, 5760); assert.equal(persisted.tasks.find(task => task.id === b).duration, 8640);
  assert.equal(persisted.tasks.find(task => task.id === b).auto_schedule, false);
  assert.equal(persisted.tasks.find(task => task.id === a).deadline.slice(0, 10), '2026-12-01');
  assert.equal(persisted.tasks.find(task => task.id === b).deadline.slice(0, 10), '2026-12-01');
  assert.equal(persisted.dependencies.length, 1); assert.equal(persisted.dependencies[0].from_task_id, a); assert.equal(persisted.dependencies[0].to_task_id, b);
  assert.equal((await api(`/versions/${project.id}?list=1`)).length, 0);
  assert.equal((await api(`/projects/${project.id}`)).status_date, projectBefore.status_date);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.pathname === '/login' || document.querySelector('[data-task-row]'));
  if (new URL(page.url()).pathname === '/login') await login();
  await saved(); await text(a, 'start', '26-11-04'); await text(b, 'end', '26-11-11');
  assert.deepEqual(await state(), persisted); assert.deepEqual(report.pageErrors, []);
  pass('显式保存后父子任务与相关依赖全部删除，移出任务和外部任务保留；年份、工期、手动模式和日期持久化，刷新一致');
  project = await api('/projects', 'POST', { name: `分钟日期验收-${randomUUID().slice(0, 8)}`, start_date: '2026-11-04', planning_status: 'draft', time_granularity: 'minute', use_template: false }); fixtures.push(project);
  const minuteId = randomUUID(), minuteSecond = randomUUID();
  await api(`/tasks/${project.id}`, 'POST', [{ id: minuteId, name: '分钟日期', start_date: '2026-11-04T09:15:00', end_date: '2026-11-04T10:45:00', duration: 90, duration_unit: 'minute', auto_schedule: false, parent_id: null, order_index: 0 },
    { id: minuteSecond, name: '下一天的分钟日期', start_date: '2026-11-05T09:15:00', end_date: '2026-11-05T10:45:00', duration: 90, duration_unit: 'minute', auto_schedule: false, parent_id: null, order_index: 1 }]);
  await page.goto(`${base}/projects/${project.id}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.pathname === '/login' || document.querySelector('[data-task-row]'));
  if (new URL(page.url()).pathname === '/login') await login(); await dateColumns();
  await text(minuteId, 'start', '26-11-04 09:15'); await text(minuteId, 'end', '26-11-04 10:45');
  await page.click(cell(minuteId, 'end'), { count: 2 }); await fill(`${cell(minuteId, 'end')} input[type=text]`, '2026/11/4 11:00');
  await page.keyboard.press('Enter'); await text(minuteId, 'end', '26-11-04 11:00');
  await range(cell(minuteSecond, 'end'), cell(minuteId, 'start')); await fillDown();
  await text(minuteSecond, 'start', '26-11-04 09:15'); await text(minuteSecond, 'end', '26-11-04 11:00');
  await page.click('button[title^="撤销"]'); await text(minuteSecond, 'start', '26-11-05 09:15'); await text(minuteSecond, 'end', '26-11-05 10:45');
  await range(cell(minuteId, 'start'), cell(minuteSecond, 'end')); await paste('10:15\t11:45');
  await text(minuteId, 'start', '26-11-04 10:15'); await text(minuteSecond, 'start', '26-11-05 10:15'); await text(minuteSecond, 'end', '26-11-05 11:45');
  await page.click('button[title^="撤销"]'); await text(minuteId, 'end', '26-11-04 11:00'); await text(minuteSecond, 'start', '26-11-05 09:15');
  await range(cell(minuteId, 'duration'), cell(minuteSecond, 'duration')); await paste('1.5小时\n45分钟');
  await text(minuteSecond, 'end', '26-11-05 10:00');
  await page.click('button[title^="撤销"]'); await text(minuteSecond, 'end', '26-11-05 10:45');
  await page.click(cell(minuteId, 'start')); await paste('26/11/4 10:15\t2026/11/4 11:45');
  await text(minuteId, 'start', '26-11-04 10:15'); await text(minuteId, 'end', '26-11-04 11:45');
  await click('保存', '[data-toolbar-row="progress"]'); await saved();
  const minute = (await state()).tasks[0]; assert.equal(minute.start_date.slice(0, 16), '2026-11-04T10:15'); assert.equal(minute.end_date.slice(0, 16), '2026-11-04T11:45'); assert.equal(minute.duration, 90);
  pass('分钟级 Ctrl+D 精确复制来源日期及时分并可整步撤销，跨行粘贴纯时分保留各自日期，支持分钟/小时工期；保存保持完整年份和90分钟工期');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
}
main().catch(async error => { report.error = error.stack; console.error(error.stack); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); })
.finally(async () => {
  if (browser) await browser.close().catch(() => {});
  report.fixtureCleaned = true;
  for (const fixture of fixtures) try { assert.equal((await api(`/projects/${fixture.id}`)).name, fixture.name); await api(`/projects/${fixture.id}`, 'DELETE'); } catch (error) { report.fixtureCleaned = false; report.cleanupError = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, steps: report.steps.length, cleaned: report.fixtureCleaned, report: path.join(output, 'report.json') }));
});
