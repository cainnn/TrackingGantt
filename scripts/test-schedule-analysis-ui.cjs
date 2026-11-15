// Real API/browser acceptance; creates and deletes only isolated test projects.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const { makePlanBaseline } = require('../.test-dist/lib/planBaseline.js');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const login = process.env.SAVE_TEST_ROOT || 'root', password = process.env.SAVE_TEST_PASSWORD || 'root123';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-schedule-analysis-'));
const projects = [], errors = [], dialogs = [];
let token, browser, page;
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
async function request(route, method = 'GET', body, expected = 200, revision) {
  const response = await fetch(`${base}/api${route}`, { method, signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'x-gantt-confirmed-save': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(revision ? { 'x-gantt-plan-revision': revision } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (expected != null) assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  if (response.ok) assert.ok(data.ok, JSON.stringify(data));
  return { status: response.status, value: data.value, error: data.error, revision: response.headers.get('x-gantt-plan-revision') };
}
const api = async (...args) => (await request(...args)).value;
const state = id => api(`/tasks/${id}?save_state=1`);
async function fixture(precision) {
  const unit = precision === 'day' ? 1440 : 60;
  const epoch = Date.UTC(2030, 0, 1, precision === 'minute' ? 9 : 0);
  const at = n => new Date(epoch + n * unit * 60000).toISOString().slice(0, 19);
  const project = await api('/projects', 'POST', { name: `排程基线验收-${precision}-${randomUUID().slice(0, 8)}`, time_granularity: precision, use_template: false, status_date: at(0) }, 201);
  projects.push(project.id);
  const ids = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, randomUUID()]));
  const spans = { a: [0, 1], b: [0, 2], c: [0, 3], d: [3, 4] };
  await api(`/tasks/${project.id}`, 'POST', Object.entries(ids).map(([key, id], index) => ({ id, name: key.toUpperCase(), task_code: String(index + 1), parent_id: null, order_index: index,
    start_date: at(spans[key][0]), end_date: at(spans[key][1]), duration: (spans[key][1] - spans[key][0]) * unit, duration_unit: precision, auto_schedule: true, constraint_type: 'asap' })), 201);
  for (const from of ['a', 'b', 'c']) await api(`/dependencies/${project.id}`, 'POST', { from_task_id: ids[from], to_task_id: ids.d, type: 2, lag: 0 }, 201);
  await api(`/projects/${project.id}`, 'PUT', { planning_status: 'stable', status_date: at(0) });
  const version = await api(`/versions/${project.id}`, 'POST', { status_date: at(0), use_database_snapshot: true, include_snapshot: true }, 201);
  await api(`/projects/${project.id}`, 'PUT', { planning_status: 'draft' });
  await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: {
    id: 'current', name: '分析验收布局', search: '', columns: ['start', 'end', 'slack', 'baselineFinish', 'baselineDuration'], colW: precision === 'minute' ? 720 : 30,
    critical: true, indicators: { deadlineDate: true, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null,
      widths: {}, nameWidth: 140, panelWidth: 1050, panelCollapsed: false, rightCollapsed: false, centerTime: epoch, scrollTop: 0 },
  } });
  return { project, ids, unit, at, version, precision };
}
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(label) {
  const match = label => {
    const buttons = [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && !b.disabled);
    return buttons.find(b => b.textContent.trim() === label) ?? buttons.find(b => b.title === label || b.getAttribute('aria-label') === label || (label === '撤销' && b.title.startsWith('撤销')) || (label === '重做' && b.title.startsWith('重做')));
  };
  await page.waitForFunction(match, {}, label);
  const handle = await page.evaluateHandle(match, label);
  await page.evaluate(() => { window.__analysisClickCount = 0; window.__analysisClickProbe = () => window.__analysisClickCount++; document.addEventListener('click', window.__analysisClickProbe, true); });
  await handle.asElement().click({ delay: 40 });
  const delivered = await page.evaluate(() => { document.removeEventListener('click', window.__analysisClickProbe, true); return window.__analysisClickCount; });
  if (!delivered) await handle.evaluate(b => b.click());
  await handle.dispose(); await frame();
}
async function fill(selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await frame();
}
async function open(f) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
  await fill('input[type=text]', login); await fill('input[type=password]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${f.project.id}"]`);
  await page.$eval(`a[href="/projects/${f.project.id}"]`, el => el.click());
  await page.waitForSelector(cell(f.ids.a, 'slack'));
}
async function text(selector) { return page.$eval(selector, el => el.textContent.trim()); }
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (!(await predicate())) { assert.ok(Date.now() < end, `Timed out: ${label}; dialogs: ${dialogs.join('; ')}`); await new Promise(r => setTimeout(r, 150)); }
}
async function renameLocal(id, value) {
  await page.$eval(cell(id, 'name'), el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  const selector = `${cell(id, 'name')} input`;
  await fill(selector, value);
  await page.$eval(selector, input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })));
  await until(async () => (await text(cell(id, 'name'))).includes(value), 'local rename');
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  for (const precision of ['day', 'minute']) {
    const f = await fixture(precision), before = await state(f.project.id);
    await open(f);
    assert.match(await text(cell(f.ids.a, 'slack')), precision === 'day' ? /\+2天/ : /\+2小时/);
    assert.match(await text(cell(f.ids.c, 'slack')), /^0/);
    assert.equal(await text(cell(f.ids.d, 'baselineFinish')), '—');
    await click('历史版本');
    await page.waitForSelector(`select[aria-label="基线来源版本"] option[value="${f.version.id}"]`);
    await page.select('select[aria-label="基线来源版本"]', f.version.id);
    await fill('input[aria-label="基线设定原因"]', '批准初始计划，固定作为后续比较基准');
    await click('应用基线到草稿');
    await page.waitForFunction(() => document.querySelector('[aria-label="固定项目基线"]')?.textContent.includes('待保存'));
    assert.equal((await state(f.project.id)).planBaseline, null);
    assert.equal((await api(`/projects/${f.project.id}/baseline-history`)).length, 0);
    await click('历史版本');
    await click('撤销'); assert.equal(await text(cell(f.ids.d, 'baselineFinish')), '—');
    await click('重做'); assert.match(await text(cell(f.ids.d, 'baselineFinish')), /^0/);
    await click('保存');
    await until(async () => !!(await state(f.project.id)).planBaseline, 'baseline persisted');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存' && b.disabled));
    const saved = await state(f.project.id);
    assert.deepEqual(saved.tasks, before.tasks); assert.deepEqual(saved.dependencies, before.dependencies);
    assert.equal((await api(`/projects/${f.project.id}/baseline-history`)).length, 1);
    await click('显示固定基线');
    await page.screenshot({ path: path.join(output, `${precision}-baseline.png`), fullPage: true });
    await open(f); assert.match(await text(cell(f.ids.d, 'baselineFinish')), /^0/);
    console.log(`PASS ${precision}: slack, draft baseline, undo/redo, explicit save and reopen`);

    // Replacing a status-date version must not mutate the frozen baseline.
    await api(`/tasks/${f.project.id}`, 'PUT', [{ id: f.ids.d, start_date: f.at(4), end_date: f.at(5), duration: f.unit }]);
    await api(`/projects/${f.project.id}`, 'PUT', { planning_status: 'stable' });
    const replacement = await api(`/versions/${f.project.id}`, 'POST', { status_date: f.at(0), use_database_snapshot: true, include_snapshot: true }, 201);
    assert.equal(replacement.id, f.version.id);
    await api(`/projects/${f.project.id}`, 'PUT', { planning_status: 'draft' });
    assert.deepEqual((await state(f.project.id)).planBaseline, saved.planBaseline);
    await open(f);
    assert.match(await text(cell(f.ids.d, 'baselineFinish')), precision === 'day' ? /\+1天/ : /\+1小时/);
    const current = await state(f.project.id);
    const staleSource = { ...saved.planBaseline, id: randomUUID(), reason: '旧来源版本' };
    await request(`/projects/${f.project.id}`, 'PUT', { plan_baseline: staleSource }, 409, current.revision);
    await request(`/projects/${f.project.id}`, 'PUT', { plan_baseline: staleSource }, 428);
    const latestVersion = await api(`/versions/${f.project.id}?id=${f.version.id}`);
    const valid = makePlanBaseline(latestVersion, randomUUID(), '重新批准');
    const invalid = structuredClone(valid); invalid.tasks[0].duration += 1;
    await request(`/projects/${f.project.id}`, 'PUT', { plan_baseline: invalid }, 409, current.revision);
    const race = await Promise.all([valid, { ...valid, id: randomUUID(), reason: '另一个会话' }].map(b => request(`/projects/${f.project.id}`, 'PUT', { plan_baseline: b }, null, current.revision)));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    assert.equal((await api(`/projects/${f.project.id}/baseline-history`)).length, 2);
    // This browser still has the old baseline; saving a local edit must stop.
    await renameLocal(f.ids.a, '旧页面修改');
    const dialogCount = dialogs.length;
    await click('保存'); await until(() => dialogs.length > dialogCount, 'stale page conflict');
    assert.match(dialogs.at(-1), /固定基线.*后台修改/);
    assert.equal((await state(f.project.id)).tasks.find(t => t.id === f.ids.a).name, 'A');
    assert.ok((await text(cell(f.ids.a, 'name'))).includes('旧页面修改'));
    console.log(`PASS ${precision}: immutable baseline, source validation, concurrency and stale browser guard`);

    // Invalid automatic schedule opens the actionable panel before writing.
    await api(`/tasks/${f.project.id}`, 'PUT', [{ id: f.ids.d, start_date: f.at(2), end_date: f.at(3), duration: f.unit }]);
    await open(f); await fill('input[placeholder^="搜索任务"]', 'A');
    await page.waitForSelector(cell(f.ids.d, 'name'), { hidden: true });
    await click('排程检查');
    await page.waitForSelector('[data-schedule-issue="dependency"]');
    assert.match(await text('[aria-label="排程检查"]'), /D.*前置.*C/);
    await page.screenshot({ path: path.join(output, `${precision}-conflicts.png`), fullPage: true });
    await click('编辑任务'); await page.waitForSelector('[role=dialog][aria-label="编辑任务"]'); await click('取消');
    await click('排程检查'); await click('定位任务');
    await page.waitForSelector('[aria-label="排程检查"]', { hidden: true });
    await page.waitForSelector(cell(f.ids.d, 'name'));
    await renameLocal(f.ids.a, '本地待保存');
    const checkpoint = await state(f.project.id);
    await click('保存'); await page.waitForSelector('[aria-label="排程检查"]');
    assert.deepEqual(await state(f.project.id), checkpoint);
    await click('撤销上一步'); await click('关闭排程检查');
    assert.match(await text(cell(f.ids.a, 'name')), /A/);
    // Manual scheduling remains valid; exceeding a deadline only warns.
    await api(`/tasks/${f.project.id}`, 'PUT', [{ id: f.ids.d, auto_schedule: false, deadline: f.at(2) }]);
    await open(f); await click('排程检查');
    assert.equal(await page.$$eval('[data-schedule-issue="dependency"]', els => els.length), 0);
    await page.waitForSelector('[data-schedule-issue="deadline"]');
    await click('关闭排程检查');
    await renameLocal(f.ids.a, '提醒不阻止保存'); await click('保存');
    await until(async () => (await state(f.project.id)).tasks.find(t => t.id === f.ids.a).name === '提醒不阻止保存', 'warning-only save');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存' && b.disabled));
    const pinned = (await state(f.project.id)).planBaseline;
    await api(`/versions/${f.project.id}`, 'DELETE', { id: f.version.id });
    assert.deepEqual((await state(f.project.id)).planBaseline, pinned);
    const retryState = await state(f.project.id);
    await request(`/projects/${f.project.id}`, 'PUT', { plan_baseline: pinned }, 200, retryState.revision);
    assert.equal((await api(`/projects/${f.project.id}/baseline-history`)).length, 2);
    console.log(`PASS ${precision}: actionable conflicts, blocked save, manual skip, warning-only save, source deletion`);
  }
  const stable = await fixture('minute');
  await api(`/projects/${stable.project.id}`, 'PUT', { planning_status: 'stable' });
  await open(stable); await click('历史版本');
  await page.waitForSelector(`select[aria-label="基线来源版本"] option[value="${stable.version.id}"]`);
  await page.select('select[aria-label="基线来源版本"]', stable.version.id);
  await fill('input[aria-label="基线设定原因"]', '稳定态批准，保存同时覆盖同日版本');
  await click('应用基线到草稿');
  await page.waitForFunction(() => document.querySelector('[aria-label="固定项目基线"]')?.textContent.includes('待保存'));
  await click('历史版本'); await click('确认变更');
  await page.waitForSelector('[aria-label="变更审核"]');
  assert.match(await text('[aria-label="变更审核"]'), /固定基线/);
  await click('确认并保存');
  await until(async () => !!(await state(stable.project.id)).planBaseline, 'stable baseline saved');
  await page.waitForSelector('[aria-label="变更审核"]', { hidden: true });
  const stableSaved = await state(stable.project.id);
  assert.equal(stableSaved.planBaseline.sourceVersionId, stable.version.id);
  assert.equal((await api(`/projects/${stable.project.id}/baseline-history`)).length, 1);
  const rewritten = await api(`/versions/${stable.project.id}?id=${stable.version.id}`);
  assert.equal(rewritten.snapshot.plan_baseline.id, stableSaved.planBaseline.id);
  await open(stable); await click('历史版本');
  await page.waitForFunction(() => document.querySelector('[aria-label="固定项目基线"]')?.textContent.includes('稳定态批准'));
  await page.$eval('[aria-label="固定项目基线"] details', el => { el.open = true; });
  await page.waitForFunction(() => document.querySelector('[aria-label="固定项目基线"] details')?.textContent.includes('稳定态批准'));
  await page.screenshot({ path: path.join(output, 'stable-baseline-history.png'), fullPage: true });
  const otherProject = projects[0], remoteBefore = await state(otherProject);
  const crossProject = makePlanBaseline(rewritten, randomUUID(), '跨项目基线应拒绝');
  await request(`/projects/${otherProject}`, 'PUT', { plan_baseline: crossProject }, 409, remoteBefore.revision);
  assert.deepEqual(await state(otherProject), remoteBefore);
  const unauth = await fetch(`${base}/api/projects/${otherProject}/baseline-history`);
  assert.equal(unauth.status, 401);
  console.log('PASS stable: reviewed save, same-date snapshot replacement, baseline history, project isolation and auth');
  assert.deepEqual(errors, [], 'browser errors');
  console.log(JSON.stringify({ passed: true, output, projects: projects.length, dialogs }, null, 2));
}
main().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); for (const id of projects) await api(`/projects/${id}`, 'DELETE').catch(e => console.error('cleanup', id, e.message)); console.log(`Cleaned ${projects.length} temporary projects. Artifacts: ${output}`); });
