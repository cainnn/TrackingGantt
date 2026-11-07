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
    .find(e => e.textContent.trim() === label && e.getClientRects().length), { label, scope });
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
  await page.click(selector, { clickCount: 3, delay: 35 });
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
  [task] = await api(`/tasks/${project.id}`, 'POST', [{ id: randomUUID(), task_code: '31', name: '验收用采购任务',
    start_date: '2026-11-01', end_date: '2026-11-06', duration: 7200, auto_schedule: false, assignee: '验收人员' }]);
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
  await click('＋ 支出金额（元）', modal); await click('应用属性配置', modal);
  await page.waitForSelector(`${modal} input[aria-label="支出金额"]`);
  assert.deepEqual((await persisted()).p.custom_fields, []);
  pass('通用页有编辑属性入口；同一任务窗口可新增金额属性，尚未写入后台');

  await fill(`${modal} input[aria-label="支出金额"]`, '123.45');
  await click('管理属性', modal); await click('＋ 新增属性', modal);
  const names = await page.$$(`${modal} input[aria-label="属性名称"]`);
  await names.at(-1).type('合同编号', { delay: 30 });
  await click('应用属性配置', modal);
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
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '');
  await closeEditor(); await page.click('button[title^="重做"]'); await openValues();
  assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), exact);
  await closeEditor(); assert.equal(report.writes.length, 0);
  pass('任务保存只进入草稿；撤销、重做分别恢复属性值，后台保持未修改');

  await click('确认变更'); const save = await button('确认并保存'); await save.dispose();
  await screenshot('04-draft-confirmation'); await click('确认并保存'); await waitSave();
  let saved = await persisted();
  const money = saved.p.custom_fields.find(f => f.name === '支出金额');
  const contract = saved.p.custom_fields.find(f => f.name === '合同编号');
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
    assert.equal((await persisted()).task.custom_values[money.id], '', `${label} import remains local`);
    await page.click('button[title^="撤销"]'); await openValues();
    assert.equal(await page.$eval(`${modal} input[aria-label="支出金额"]`, e => e.value), '');
    await closeEditor();
  }
  assert.equal(report.writes.length, writesBeforeFiles);
  pass('通过菜单导出 Excel/MPP 并重新导入：属性保留、Excel 工期按天、导入可撤销且未写入后台');

  await click('显示全部'); await page.waitForSelector(`[data-task-bar="${task.id}"] rect[fill="transparent"]`);
  await page.click(`[data-task-bar="${task.id}"] rect[fill="transparent"]`, { clickCount: 2, delay: 60 });
  await page.waitForSelector(modal, { visible: true }); await button('编辑属性', modal); await closeEditor();
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
  report.trustedClicks = await page.evaluate(() => window.__trustedClicks);
  pass('右侧任务条双击仍打开同一编辑窗口；状态日期线键盘调整和撤销仍不落盘');
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
