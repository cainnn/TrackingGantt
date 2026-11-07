// Real Chrome clicks/typing + Puppeteer's select helper + live API verification.
// No mocked responses, DOM click(), Redux mutations, or access to existing projects.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer');
const base = process.env.ATTR_UI_URL || process.argv[2] || 'http://127.0.0.1:3117';
const login = process.env.ATTR_UI_USER || 'admin';
const password = process.env.ATTR_UI_PASSWORD || 'admin123';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-attributes-ui-'));
const modal = '[role="dialog"][aria-label="编辑任务"]';
const report = { base, output, steps: [], screenshots: [], pageErrors: [], writes: [], fileRequests: [], imports: [], files: [], passed: false };
let token, project, task, browser, page;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data.value;
}
function pass(message) { report.steps.push(message); console.log(`PASS ${message}`); }
async function screenshot(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file);
}
async function button(label, scope = 'body', enabled = true) {
  const h = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(e => (e.textContent.trim() === label || e.getAttribute('aria-label') === label) && e.getClientRects().length), { label, scope });
  assert.ok(h.asElement(), `Visible button: ${label}`);
  if (enabled) assert.equal(await h.evaluate(e => e.disabled), false, `${label} enabled`);
  return h;
}
async function click(label, scope = 'body') {
  const h = await button(label, scope);
  const count = await page.evaluate(() => window.__trustedClicks ?? 0);
  await h.asElement().click({ delay: 60 }); await h.dispose();
  await page.waitForFunction(n => window.__trustedClicks > n, { timeout: 5000 }, count);
}
async function fill(selector, value) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { count: 3, delay: 35 });
  await page.keyboard.press('Backspace');
  if (value) await page.type(selector, value, { delay: 15 });
  assert.equal(await page.$eval(selector, e => e.value), value);
}
async function openEditor() {
  await page.click(`[data-task-cell="${task.id}"][data-col="name"]`);
  await page.click('button[title="编辑任务"]');
  await page.waitForSelector(modal, { visible: true });
  assert.equal((await page.$$(modal)).length, 1);
}
async function openValues() { await openEditor(); await click('编辑属性', modal); }
async function closeEditor() { await click('取消', modal); await page.waitForSelector(modal, { hidden: true }); }
const waitFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function barPoint() {
  return page.evaluate(async id => {
    let previous, stable = 0;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const bar = document.querySelector(`[data-task-bar="${id}"] rect[fill="transparent"]`);
      const timeline = document.querySelector('[data-timeline-scroll]');
      if (!bar || !timeline) continue;
      const r = bar.getBoundingClientRect(), v = timeline.getBoundingClientRect();
      const position = JSON.stringify([r.x, r.y, r.width, timeline.scrollLeft, timeline.dataset.colWidth]);
      stable = position === previous ? stable + 1 : 0; previous = position;
      if (stable >= 3 && r.x > v.x && r.right < v.right) {
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, step: Number(timeline.dataset.colWidth) };
      }
    }
    throw new Error('Task bar did not settle inside the timeline');
  }, task.id);
}
async function persisted() {
  const [p, state, versions] = await Promise.all([api(`/projects/${project.id}`), api(`/tasks/${project.id}`), api(`/versions/${project.id}?list=1`)]);
  return { p, task: state.tasks.find(t => t.id === task.id), versions };
}
async function waitSave() {
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存中...'));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认变更' && b.disabled));
}
async function until(check, label) {
  const deadline = Date.now() + 60000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    assert.deepEqual(report.pageErrors, [], label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function loginAndOpen() {
  await page.waitForFunction(() => { const form = document.querySelector('form'); return form && Object.keys(form).some(k => k.startsWith('__reactProps$')); });
  await fill('input[type="text"]', login); await fill('input[type="password"]', password);
  await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`, { visible: true });
  await page.click(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector(`[data-task-cell="${task.id}"][data-col="name"]`);
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  project = await api('/projects', 'POST', { name: `属性点击验收-${randomUUID().slice(0, 8)}`, start_date: '2026-11-01',
    status_date: '2026-11-03', planning_status: 'draft', time_granularity: 'day', use_template: false });
  const taskCount = Number(process.env.ATTR_UI_TASK_COUNT || 2);
  assert.ok(Number.isInteger(taskCount) && taskCount >= 2 && taskCount <= 1000);
  [task] = await api(`/tasks/${project.id}`, 'POST', Array.from({ length: taskCount }, (_, i) => ({ id: randomUUID(),
    task_code: String(31 + i), name: i === 0 ? '验收用采购任务' : `验收用其他任务${i + 1}`, order_index: i,
    start_date: '2026-11-01', end_date: '2026-11-06', duration: 7200, auto_schedule: false, assignee: '验收人员' })));
  report.taskCount = taskCount;
  report.fixture = { id: project.id, name: project.name };
  browser = await puppeteer.launch({ headless: process.env.ATTR_UI_HEADLESS === '1',
    ...(process.env.ATTR_UI_CHROME ? { executablePath: process.env.ATTR_UI_CHROME } : {}),
    args: ['--window-size=1480,1080', '--no-first-run', '--disable-default-apps'] });
  await browser.defaultBrowserContext().setDownloadBehavior({ policy: 'allow', downloadPath: output });
  page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(60000);
  await page.evaluateOnNewDocument(() => {
    window.__trustedClicks = 0;
    document.addEventListener('click', e => { if (e.isTrusted) window.__trustedClicks++; }, true);
  });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', async dialog => {
    // Only app confirmation/alert dialogs in our isolated fixture are accepted.
    if (/失败|error/i.test(dialog.message())) report.pageErrors.push(dialog.message());
    if (dialog.message().includes('导入成功')) report.imports.push(dialog.message());
    await dialog.accept(dialog.type() === 'prompt' ? '2' : undefined);
  });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/mpp/build' || pathname === '/api/mpp/parse') {
      report.fileRequests.push({ method: request.method(), path: pathname }); return request.continue();
    }
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/login') {
      if (!pathname.includes(project.id)) { report.pageErrors.push(`Blocked mutation outside fixture: ${pathname}`); return request.abort(); }
      report.writes.push({ method: request.method(), path: pathname });
    }
    return request.continue();
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await loginAndOpen();
  console.log('Opened isolated test project through login and dashboard clicks');
  assert.equal(report.writes.length, 0, 'Entering project must not write');
  await openEditor(); await button('编辑属性', modal); await screenshot('01-general-entry');
  await click('编辑属性', modal); await click('新增任务属性', modal);
  assert.equal(await page.$eval(modal, e => e.textContent.includes('＋ 支出金额')), false, 'No preset common property');
  await click('＋ 新增属性', modal); await fill(`${modal} input[aria-label="属性名称"]`, '支出金额');
  await page.select(`${modal} select[aria-label="支出金额类型"]`, 'money');
  await fill(`${modal} input[aria-label="支出金额单位"]`, '元'); await click('完成设置', modal);
  await page.waitForSelector(`${modal} input[aria-label="支出金额"]`);
  assert.deepEqual((await persisted()).p.custom_fields, []);
  pass('通用页有编辑属性入口；同一任务窗口可新增金额属性，尚未写入后台');

  await fill(`${modal} input[aria-label="支出金额"]`, '123.45');
  await click('管理属性', modal); await click('＋ 新增属性', modal);
  const names = await page.$$(`${modal} input[aria-label="属性名称"]`);
  await names.at(-1).type('合同编号', { delay: 30 });
  await click('完成设置', modal);
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '123.45', 'Managing definitions preserves current form values');
  await fill(`${modal} input[aria-label="合同编号"]`, 'HT-000123');
  await fill(`${modal} input[aria-label="支出金额"]`, '12.345'); await click('保存', modal);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('2 位小数'), {}, modal);
  await screenshot('02-money-validation');
  assert.equal(report.writes.length, 0);
  pass('新增文本属性时保留已填金额；错误金额显示校验提示且不保存');
  const exact = '999999999999999999.99';
  await fill(`${modal} input[aria-label="支出金额"]`, exact);
  await page.waitForFunction(selector => !document.querySelector(selector)?.textContent.includes('须为数字'), {}, modal);
  await screenshot('03-attribute-values');
  await click('保存', modal); await page.waitForSelector(modal, { hidden: true });
  assert.equal(report.writes.length, 0);
  assert.deepEqual((await persisted()).task.custom_values, {});
  await page.click('button[title^="撤销"]'); await openValues();
  assert.equal(await page.$(`${modal} input[aria-label="支出金额"]`), null, 'Undo removes the task definitions and values together');
  await closeEditor(); await page.click('button[title^="重做"]'); await openValues();
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), exact);
  await closeEditor(); assert.equal(report.writes.length, 0);
  pass('任务保存只进入草稿；撤销、重做恢复当前任务的属性定义和值，后台保持未修改');

  const primaryTask = task;
  const secondTask = (await api(`/tasks/${project.id}`)).tasks.find(t => t.id !== primaryTask.id);
  task = secondTask; await openValues();
  assert.equal(await page.$(`${modal} input[aria-label="支出金额"]`), null, 'Another task has no inherited attributes');
  await click('新增任务属性', modal); await click('＋ 新增属性', modal);
  await fill(`${modal} input[aria-label="属性名称"]`, '支出金额'); await click('完成设置', modal);
  await fill(`${modal} input[aria-label="支出金额"]`, '暂未报支'); await click('保存', modal);
  await page.waitForSelector(modal, { hidden: true }); task = primaryTask;
  await openValues(); assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), exact); await closeEditor();
  assert.equal(report.writes.length, 0);
  pass('另一任务从空属性开始，可以自定义同名文本属性；两个任务的类型和值互不影响');

  await click('确认变更'); const save = await button('确认并保存'); await save.dispose();
  await screenshot('04-draft-confirmation'); await click('确认并保存'); await waitSave();
  let saved = await persisted();
  const money = saved.task.custom_fields.find(f => f.name === '支出金额');
  const contract = saved.task.custom_fields.find(f => f.name === '合同编号');
  assert.deepEqual(saved.p.custom_fields, [], 'Task configuration must not create project-wide properties');
  assert.equal(saved.task.custom_values[money.id], exact); assert.equal(saved.task.custom_values[contract.id], 'HT-000123');
  assert.equal(saved.versions.length, 0); assert.equal(saved.p.planning_status, 'draft');
  assert.equal(saved.task.start_date, task.start_date); assert.equal(saved.task.end_date, task.end_date);
  pass('确认并保存才入库；大金额精度正确，草稿态无强制原因且不生成版本');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.pathname === '/login' || document.querySelector('[data-task-row]'));
  if (new URL(page.url()).pathname === '/login') await loginAndOpen();
  await openValues();
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), exact);
  await fill(`${modal} input[aria-label="支出金额"]`, '99.99'); await closeEditor(); await openValues();
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), exact);
  await closeEditor(); pass('刷新后属性可读取；取消编辑不改动已保存金额');

  // macOS native popup selections do not consume CDP arrow keys even on a
  // plain HTML fixture. Use Puppeteer's select helper to run the real change handler.
  await page.select('select[aria-label="计划状态"]', 'stable');
  await page.waitForFunction(() => document.querySelector('select[aria-label="计划状态"]').value === 'stable');
  await click('确认变更'); await click('确认并保存'); await waitSave();
  const versionsBefore = (await persisted()).versions.length;
  assert.equal(versionsBefore, 1, 'Entering stable state creates the status-date snapshot');
  await openValues(); await fill(`${modal} input[aria-label="支出金额"]`, '0'); await click('保存', modal);
  await page.waitForSelector(modal, { hidden: true }); await click('确认变更');
  const required = await button('确认并保存', 'body', false);
  assert.equal(await required.evaluate(e => e.disabled), true); await required.dispose();
  await screenshot('05-stable-reason-required');
  await fill('textarea[aria-label="任务 31 的变更原因"]', '界面验收：核对金额零值和稳定态原因');
  await click('确认并保存'); await waitSave(); saved = await persisted();
  assert.equal(saved.task.custom_values[money.id], '0.00');
  // The established application policy retains one version per status date.
  // Verify its actual snapshot, not an invented version-per-click policy.
  assert.equal(saved.versions.length, versionsBefore);
  const version = await api(`/versions/${project.id}?id=${saved.versions[0].id}`);
  assert.equal(version.snapshot.tasks.find(t => t.id === task.id).custom_values[money.id], '0.00');
  pass('稳定态要求原因；填写后保存零金额，并更新对应状态日期的版本快照');
  await openValues(); await fill(`${modal} input[aria-label="支出金额"]`, ''); await click('保存', modal);
  await page.waitForSelector(modal, { hidden: true }); await click('确认变更');
  await fill('textarea[aria-label="任务 31 的变更原因"]', '界面验收：清空金额，与零值区分');
  await click('确认并保存'); await waitSave();
  assert.equal((await persisted()).task.custom_values[money.id], '');
  pass('金额可明确清空，后台空值与零金额分别保存');

  const writesBeforeFiles = report.writes.length;
  await openValues(); await fill(`${modal} input[aria-label="支出金额"]`, '50.00'); await click('保存', modal);
  await page.waitForSelector(modal, { hidden: true });
  for (const [label, extension] of [['Excel', '.xlsx'], ['MS Project (.mpp)', '.mpp']]) {
    await page.click('button[title="导出"]'); await click(`导出 ${label}`);
    await until(() => fs.readdirSync(output).some(n => n.endsWith(extension)), `download ${label}`);
    const file = path.join(output, fs.readdirSync(output).find(n => n.endsWith(extension)));
    assert.ok(fs.statSync(file).size > 1000); report.files.push(file);
  }
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(report.files[0]);
  const row = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])[0];
  assert.equal(row['属性：支出金额（元）'], '50.00'); assert.equal(row['属性：合同编号'], 'HT-000123');
  assert.equal(row['工期(天)'], 5);
  await page.click('button[title^="撤销"]');
  for (const [i, label] of ['Excel', 'MS Project (.mpp)'].entries()) {
    const before = report.imports.length;
    await page.click('button[title="导入"]');
    const [chooser] = await Promise.all([page.waitForFileChooser(), click(`导入 ${label}`)]);
    await chooser.accept([report.files[i]]);
    await until(() => report.imports.length > before, `import ${label}`);
    await openValues();
    assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '50.00');
    assert.equal(await page.$eval(`${modal} input[aria-label="合同编号"]`, e => e.value), 'HT-000123');
    await screenshot(`06-import-${i}`); await closeEditor();
    task = secondTask; await openValues();
    assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '暂未报支', `${label} retains per-task definitions`);
    assert.equal(await page.$(`${modal} input[aria-label="合同编号"]`), null, `${label} must not globalize another task's attributes`);
    await closeEditor(); task = primaryTask;
    assert.equal((await persisted()).task.custom_values[money.id], '', `${label} import remains local`);
    await page.click('button[title^="撤销"]'); await openValues();
    assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '');
    await closeEditor();
  }
  assert.equal(report.writes.length, writesBeforeFiles);
  pass('通过菜单导出 Excel/MPP 并重新导入：属性保留、Excel 工期按天、导入可撤销且未写入后台');

  const startCell = `[data-task-cell="${task.id}"][data-col="start"]`;
  const expectStart = value => page.waitForFunction((selector, expected) => document.querySelector(selector)?.textContent.trim() === expected, {}, startCell, value);
  const writesBeforeBar = report.writes.length;
  await expectStart('11-01'); await click('显示全部');
  let point = await barPoint();
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await waitFrames();
  // Send a real browser input event with no held button, as can happen when a
  // second input device moves or mouseup is delayed. Do not dispatch DOM events.
  const pointer = await page.createCDPSession();
  await pointer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + point.step, y: point.y, buttons: 0 });
  await waitFrames();
  assert.equal(await page.$eval(startCell, e => e.textContent.trim()), '11-01', 'An unpressed pointer must not move the task');
  await page.mouse.up(); await pointer.detach(); await waitFrames();
  assert.equal(await page.$eval('button[title^="撤销"]', e => e.disabled), true, 'Hover must not create an undo step');

  point = await barPoint();
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await waitFrames();
  await page.mouse.move(point.x + point.step, point.y, { steps: 5 }); await expectStart('11-02');
  await page.mouse.up(); await waitFrames();
  await page.click('button[title^="撤销"]'); await expectStart('11-01');
  for (let i = 0; i < 3; i++) {
    await click('显示全部'); point = await barPoint();
    await page.mouse.click(point.x, point.y, { count: 2, delay: 60 });
    await page.waitForSelector(modal, { visible: true });
    assert.equal((await page.$$(modal)).length, 1);
    await button('编辑属性', modal); await closeEditor(); await expectStart('11-01');
  }
  assert.equal(report.writes.length, writesBeforeBar);
  assert.equal((await persisted()).task.start_date.slice(0, 10), '2026-11-01');
  pass('未按键移动不拖动任务；正常拖动可撤销；连续双击只打开同一任务窗口且不修改日期');
  const writesBeforeLine = report.writes.length;
  const statusLabel = await page.$eval('[data-status-date-handle="body"]', e => e.getAttribute('aria-valuetext'));
  // SVG elements expose focus(), but Puppeteer's focus helper only accepts HTMLElement.
  await page.$eval('[data-status-date-handle="body"]', e => e.focus()); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before => document.querySelector('[data-status-date-handle="body"]').getAttribute('aria-valuetext') !== before, {}, statusLabel);
  await page.waitForFunction(() => document.querySelector('button[title^="撤销"]')?.disabled === false);
  await page.click('button[title^="撤销"]');
  await page.waitForFunction(before => document.querySelector('[data-status-date-handle="body"]').getAttribute('aria-valuetext') === before, {}, statusLabel);
  assert.equal(report.writes.length, writesBeforeLine);
  assert.equal((await persisted()).p.status_date.slice(0, 10), '2026-11-03');
  await screenshot('06-finished');
  assert.deepEqual(report.pageErrors, []);
  pass('状态日期线键盘调整和撤销仍不落盘');

  const settings = '[role="dialog"][aria-label="显示设置"]';
  const writesBeforeSettings = report.writes.length;
  await click('清除选择'); await screenshot('07-toolbar');
  assert.equal(await page.$eval('[data-toolbar-row="tasks"]', e => e.textContent.includes('已选 0')), false);
  await click('任务操作');
  assert.equal(await page.$eval('[role="menu"] button', e => e.disabled), true);
  await page.keyboard.press('Escape'); await page.waitForSelector('[role="menu"]', { hidden: true });
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '任务操作');
  await fill('input[placeholder="搜索任务..."]', '采购');
  await click('显示设置'); await click('显示内容', settings);
  const toggleAssignee = async () => {
    const label = await page.evaluateHandle(selector => [...document.querySelectorAll(`${selector} label`)].find(e => e.textContent.trim() === '责任人'), settings);
    assert.ok(label.asElement()); await label.asElement().click(); await label.dispose();
  };
  await toggleAssignee(); await click('常用布局', settings); await click('保存当前布局', settings);
  await fill('input[aria-label="布局名称"]', '采购跟踪'); await click('保存布局', settings);
  const layouts = await page.evaluate(id => JSON.parse(localStorage.getItem(`gantt-saved-views-v1-${id}`)), project.id);
  assert.equal(layouts[0].search, '采购'); assert.equal(layouts[0].columns.includes('assignee'), false); assert.equal('tasks' in layouts[0], false);
  assert.equal((await page.$$('[role="dialog"]')).length, 1, 'Saving a layout must not stack dialogs');
  await screenshot('08-layout-settings'); await page.keyboard.press('Escape');
  await fill('input[placeholder="搜索任务..."]', '');
  await click('显示设置'); await click('显示内容', settings); await toggleAssignee(); await click('常用布局', settings);
  await page.select('select[aria-label="已保存布局"]', layouts[0].id);
  await page.waitForFunction(() => document.querySelector('input[placeholder="搜索任务..."]').value === '采购');
  assert.equal(await page.$(`[data-task-cell="${task.id}"][data-col="assignee"]`), null);
  await page.keyboard.press('Escape'); await fill('input[placeholder="搜索任务..."]', '');
  await page.setViewport({ width: 1024, height: 800 }); await click('显示设置'); await click('显示内容', settings); await toggleAssignee();
  assert.equal(await page.$eval(settings, e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
  await screenshot('09-narrow-settings'); await page.keyboard.press('Escape'); await page.setViewport({ width: 1440, height: 1000 });
  assert.equal(report.writes.length, writesBeforeSettings);
  assert.equal(await page.$eval('button[title^="撤销"]', e => e.disabled), true);
  pass('任务操作按选中状态启用；显示设置统一管理列和布局，保存/恢复不改任务；1024 宽度无弹层越界');

  await click('任务操作');
  assert.equal(await page.$eval('[role="menu"]', e => /批量填报属性|属性配置/.test(e.textContent)), false);
  await page.keyboard.press('Escape');
  task = secondTask; await openValues();
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '暂未报支');
  await click('管理属性', modal); await click('＋ 新增属性', modal);
  const canceledNames = await page.$$(`${modal} input[aria-label="属性名称"]`);
  await canceledNames.at(-1).type('取消的属性'); await closeEditor(); await openValues();
  assert.equal(await page.$(`${modal} input[aria-label="取消的属性"]`), null);
  await closeEditor(); task = primaryTask;
  assert.equal(report.writes.length, writesBeforeSettings);
  assert.deepEqual((await persisted()).p.custom_fields, []);
  pass('工具栏不提供通用属性配置；取消新增属性不生效，同名属性在其他任务上保持独立');

  report.pickerOpenMs = [];
  for (const direction of ['前置', '后续']) {
    await openEditor(); const started = Date.now(); await click(direction, modal);
    const input = `${modal} input[aria-label="${direction}任务编号"]`;
    await page.waitForSelector(input); report.pickerOpenMs.push(Date.now() - started);
    assert.ok((await page.$$(`${modal} [role="option"]`)).length <= 30);
    await fill(input, '999999'); await page.keyboard.press('Enter');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('未找到可关联任务'), {}, modal);
    await fill(input, '2'); await page.keyboard.press('Enter');
    await page.waitForSelector(`${modal} [role="option"][aria-selected="true"]`);
    await screenshot(`11-${direction}-number`);
    if (direction === '前置') {
      await click('后续', modal); await fill(`${modal} input[aria-label="后续任务编号"]`, '2'); await page.keyboard.press('Enter');
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('循环依赖'), {}, modal);
    }
    await closeEditor(); await page.click('button[title^="撤销"]'); await expectStart('11-01');
    assert.equal(await page.$eval('button[title^="撤销"]', e => e.disabled), true);
  }
  for (const [col, direction] of [['pred', '前置'], ['succ', '后续']]) {
    await page.click(`[data-task-cell="${task.id}"][data-col="${col}"]`, { count: 2, delay: 60 });
    const popup = `[role="dialog"][aria-label="${direction}任务"]`, input = `${popup} input[aria-label="${direction}任务编号"]`;
    await fill(input, '#2'); await page.keyboard.press('Enter');
    await page.waitForSelector(`${popup} [role="option"][aria-selected="true"]`);
    await fill(input, '2'); await page.keyboard.press('Enter');
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} [role="option"][aria-selected="true"]`).length === 0, {}, popup);
    await page.keyboard.press('Escape'); await page.click('button[title^="撤销"]'); await page.click('button[title^="撤销"]'); await expectStart('11-01');
  }
  assert.equal(report.writes.length, writesBeforeSettings);
  assert.equal((await api(`/tasks/${project.id}`)).dependencies.length, 0);
  assert.deepEqual(report.pageErrors, []);
  pass('编辑窗口及前置/后续单元格均可输入列表编号回车关联；无效编号和循环被拦截；选择列表最多 30 项且全部可撤销');
  const writesBeforeHistory = report.writes.length;
  const latest = (await persisted()).versions[0];
  await click('查看历史');
  const versionButton = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.querySelector('span.font-medium')?.textContent.trim() === label), latest.name || latest.status_date.slice(0, 10));
  assert.ok(versionButton.asElement()); await versionButton.asElement().click({ delay: 60 }); await versionButton.dispose();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '退出查看'));
  await button('退出查看'); await page.click(`[data-task-cell="${task.id}"][data-col="name"]`);
  await click('任务操作'); await click('查看任务属性');
  const readOnlyAttributes = '[role="dialog"][aria-label="任务属性"]';
  await page.waitForSelector(readOnlyAttributes);
  assert.ok(await page.$eval(readOnlyAttributes, e => e.textContent.includes('HT-000123') && e.textContent.includes('只读')));
  assert.equal((await page.$$(`${readOnlyAttributes} input, ${readOnlyAttributes} select`)).length, 0);
  await screenshot('12-history-attributes'); await page.keyboard.press('Escape'); await click('退出查看');
  assert.equal(report.writes.length, writesBeforeHistory);
  assert.deepEqual(report.pageErrors, []);
  pass('历史版本可按任务查看自定义属性，只读查看不产生后台写入');
  report.trustedClicks = await page.evaluate(() => window.__trustedClicks);
  report.passed = true;
}
main().catch(async error => {
  report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  if (page) { await screenshot('failure').catch(() => {}); }
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (project) {
    try {
      const p = await api(`/projects/${project.id}`); assert.equal(p.name, project.name);
      await api(`/projects/${project.id}`, 'DELETE'); report.fixtureCleaned = true;
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, steps: report.steps.length, report: path.join(output, 'report.json'), cleaned: report.fixtureCleaned }));
});
