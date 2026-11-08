// Real browser interactions and real database/API verification in one disposable
// project. No response mocks, DOM clicks, Redux edits, or existing project writes.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3117';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-hierarchy-ui-'));
const login = process.env.ATTR_UI_USER || 'admin', password = process.env.ATTR_UI_PASSWORD || 'admin123';
const report = { base, output, steps: [], writes: [], pageErrors: [], expectedFailures: [], passed: false };
let token, project, browser, page, abortUpdate = false, expectFailure = false, priorClicks = 0;
const cell = id => `[data-task-cell="${id}"][data-col="name"]`;
const review = '[role="dialog"][aria-label="变更审核"]';
async function api(route, method = 'GET', body) {
  const r = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await r.json(); assert.ok(r.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
const state = () => api(`/tasks/${project.id}`);
const versions = () => api(`/versions/${project.id}?list=1`);
function pass(message) { report.steps.push(message); console.log(`PASS ${message}`); }
async function click(label, scope = 'body') {
  const h = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(e => (e.textContent.trim() === label || e.getAttribute('aria-label') === label) && e.getClientRects().length), { label, scope });
  assert.ok(h.asElement(), `Visible button: ${label}`); assert.equal(await h.evaluate(e => e.disabled), false);
  const before = await page.evaluate(() => window.__trustedClicks);
  await h.asElement().click({ delay: 60 }); await h.dispose();
  await page.waitForFunction(n => window.__trustedClicks > n, {}, before);
}
async function operation(ids, label) {
  await page.click(cell(ids[0]));
  for (const id of ids.slice(1)) await page.click(`[data-task-row="${id}"] input[type=checkbox]`);
  assert.deepEqual((await page.$$eval('[data-task-row] input:checked', inputs => inputs.map(el => el.closest('[data-task-row]').dataset.taskRow))).sort(), [...ids].sort());
  if (label === '提升任务层级' || label === '降为子任务') {
    await click(label === '降为子任务' ? '降低任务层级' : label, '[data-toolbar-row="tasks"]');
  } else if (label === '删除选中任务') { await click(label, '[data-toolbar-row="tasks"]'); }
  else { await click('任务操作'); await click(label); }
}
async function level(id, expected) {
  await page.waitForFunction((selector, expected) => Number.parseFloat(document.querySelector(selector)?.style.paddingLeft) === 4 + expected * 16, {}, cell(id), expected);
}
async function dragBefore(id, target) {
  const from = await page.$eval(`[data-task-row="${id}"] [title="拖动排序"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const to = await page.$eval(`[data-task-row="${target}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + 10, y: r.y + 4 }; });
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 15 }); await page.mouse.up();
}
async function startNameDrag(id, target) {
  const from = await page.$eval(cell(id), el => { const r = el.getBoundingClientRect(); return { x: r.x + Math.min(r.width - 12, 85), y: r.y + r.height / 2 }; });
  const to = await page.$eval(`[data-task-row="${target}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + 120, y: r.y + 4 }; });
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.waitForSelector('[data-task-drag-preview]');
}
const visibleIds = () => page.$$eval('[data-task-row]', rows => rows.map(r => r.dataset.taskRow));
async function expectIds(ids) {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('[data-task-row]')].map(r => r.dataset.taskRow)) === JSON.stringify(ids), {}, ids);
}
async function parentInUi(id, parent) {
  await page.waitForFunction((id, parent) => {
    const ancestors = [];
    for (const row of document.querySelectorAll('[data-task-row]')) {
      const depth = (Number.parseFloat(row.querySelector('[data-col=name]').style.paddingLeft) - 4) / 16;
      if (row.dataset.taskRow === id) return (depth ? ancestors[depth - 1] : null) === parent;
      ancestors[depth] = row.dataset.taskRow;
    }
    return false;
  }, {}, id, parent);
}
async function saveDraft() {
  await click('保存', '[data-toolbar-row="progress"]'); await saved();
  assert.equal(await page.$(review), null);
}
async function saved() {
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-action="save-plan"]'); return b?.disabled && b.textContent.trim() !== '保存中...';
  });
  assert.deepEqual(report.pageErrors, []);
}
async function loginAndOpen() {
  await page.waitForFunction(() => { const f = document.querySelector('form'); return f && Object.keys(f).some(k => k.startsWith('__reactProps$')); });
  await page.type('input[type=text]', login); await page.type('input[type=password]', password); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector('[data-task-row]');
}
async function reload() {
  priorClicks += await page.evaluate(() => window.__trustedClicks);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => location.pathname === '/login' || document.querySelector('[data-task-row]'));
  if (new URL(page.url()).pathname === '/login') await loginAndOpen();
}
async function graphMatchesUi() {
  const rows = await page.$$eval('[data-task-row]', rows => rows.map(r => ({ id: r.dataset.taskRow,
    level: (Number.parseFloat(r.querySelector('[data-col=name]').style.paddingLeft) - 4) / 16 })));
  const tasks = (await state()).tasks;
  const flatten = (parent = null, depth = 0) => tasks.filter(t => t.parent_id === parent)
    .sort((a, b) => a.order_index - b.order_index).flatMap(t => [{ id: t.id, level: depth }, ...flatten(t.id, depth + 1)]);
  assert.deepEqual(rows, flatten(), 'Database hierarchy/order must exactly match the visible expanded task tree');
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  project = await api('/projects', 'POST', { name: `层级点击验收-${randomUUID().slice(0, 8)}`, start_date: '2026-11-01',
    status_date: '2026-11-03', planning_status: 'draft', time_granularity: 'day', use_template: false });
  const [a, b, c, d, e, f] = Array.from({ length: 6 }, randomUUID);
  const make = (id, name, parent_id, order_index, code) => ({ id, name, parent_id, order_index, task_code: String(code),
    start_date: '2026-11-01T00:00:00', end_date: '2026-11-05T00:00:00', duration: 5760, duration_unit: 'day', auto_schedule: false });
  await api(`/tasks/${project.id}`, 'POST', [make(a, '父任务 A', null, 0, 1), make(b, '子任务 B', a, 1, 2),
    make(c, '子任务 C', a, 0, 3), make(d, '父任务 D', null, 1, 4), make(e, '子任务 E', d, 0, 5), make(f, '任务 F', null, 2, 6)]);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1680, height: 1080, deviceScaleFactor: 2 });
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
  await page.evaluateOnNewDocument(() => { window.__trustedClicks = 0; document.addEventListener('click', e => { if (e.isTrusted) window.__trustedClicks++; }, true); });
  page.on('pageerror', e => report.pageErrors.push(e.message));
  page.on('dialog', async dialog => {
    if (expectFailure && dialog.message().startsWith('保存失败：')) { report.expectedFailures.push(dialog.message()); expectFailure = false; }
    else if (/失败|修正|error/i.test(dialog.message())) report.pageErrors.push(dialog.message());
    await dialog.accept();
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/login') {
      if (!pathname.includes(project.id)) { report.pageErrors.push(`Blocked mutation outside fixture: ${pathname}`); return request.abort(); }
      report.writes.push({ path: pathname, method: request.method(), body: request.postData() });
      if (abortUpdate && pathname === `/api/tasks/${project.id}` && request.method() === 'PUT') { abortUpdate = false; return request.abort('internetdisconnected'); }
    }
    return request.continue();
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' }); await loginAndOpen();
  const initialIds = [a, c, b, d, e, f], beforeDrag = await state();
  for (const label of ['全部折叠', '全部展开', '提升任务层级', '降低任务层级']) {
    const button = await page.$(`[data-toolbar-row="tasks"] button[aria-label="${label}"]`);
    assert.ok(button, `Always visible toolbar icon: ${label}`);
    assert.equal(await button.evaluate(element => element.textContent.trim()), '');
    assert.equal(await button.evaluate(element => element.title), label);
    assert.equal((await button.$$('svg')).length, 1);
    if (label.includes('层级')) assert.equal(await button.evaluate(element => element.disabled), true);
  }
  await click('全部折叠', '[data-toolbar-row="tasks"]'); await expectIds([a, d, f]);
  await click('全部折叠', '[data-toolbar-row="tasks"]'); await expectIds([a, d, f]);
  await click('全部展开', '[data-toolbar-row="tasks"]'); await expectIds(initialIds);
  assert.equal(await page.$eval('[data-action="save-plan"]', button => button.disabled), true);
  await page.click(cell(b));
  await page.waitForFunction(() => ['提升任务层级', '降低任务层级'].every(label => document.querySelector(`[data-toolbar-row="tasks"] button[aria-label="${label}"]`)?.disabled === false));
  await page.$eval('[data-toolbar-row="tasks"]', element => element.scrollIntoView({ block: 'nearest' }));
  await (await page.$('[data-toolbar-row="tasks"]')).screenshot({ path: path.join(output, 'main-toolbar-icons.png') });
  await (await page.$('[role="group"][aria-label="任务层级"]')).screenshot({ path: path.join(output, 'toolbar-hierarchy-icons.png') });
  await click('清除选择');
  assert.equal(report.writes.length, 0); assert.deepEqual(await state(), beforeDrag);
  pass('主工具栏常显四个纯图标按钮，悬停名称完整；无选择时升降级置灰，全部折叠/展开不产生待保存更改');
  assert.equal(await page.$eval(`[data-task-drag-handle="${f}"]`, el => getComputedStyle(el).opacity), '1');
  const rowTopBefore = await page.$eval(cell(a), el => el.getBoundingClientRect().top);
  await startNameDrag(f, a);
  assert.ok(await page.$eval('[data-task-drag-preview]', el => el.textContent.includes('放到「父任务 A」上方')));
  assert.equal(await page.$eval(cell(a), el => el.getBoundingClientRect().top), rowTopBefore, 'Insertion indicator must not move the rows');
  await page.screenshot({ path: path.join(output, 'name-drag-preview.png'), fullPage: true });
  await page.mouse.up(); await expectIds([f, a, c, b, d, e]);
  await page.click('button[title^="撤销"]'); await expectIds(initialIds);
  await page.click('button[title^="重做"]'); await expectIds([f, a, c, b, d, e]);
  await page.click('button[title^="撤销"]'); await expectIds(initialIds);
  await page.click(`${cell(a)} button`); await expectIds([a, d, e, f]);
  await startNameDrag(a, f); await page.mouse.up(); await expectIds([d, e, a, f]);
  await page.click(`${cell(a)} button`); await expectIds([d, e, a, c, b, f]);
  await page.click('button[title^="撤销"]'); await expectIds(initialIds);
  assert.equal(report.writes.length, 0); assert.deepEqual(await state(), beforeDrag);
  pass('任务名称可直接向上/向下拖动，手柄常显、插入线不挤动行；折叠父任务带全部子任务移动，撤销重做不写后台');

  await page.click(cell(d)); await page.click(`[data-task-row="${f}"] input[type=checkbox]`);
  await startNameDrag(f, c);
  assert.ok(await page.$eval('[data-task-drag-preview]', el => el.textContent.includes('移动 2 个任务（含子任务）')));
  await page.mouse.up(); await expectIds([a, d, e, f, c, b]); await parentInUi(d, a); await parentInUi(e, d); await parentInUi(f, a);
  await page.click('button[title^="撤销"]'); await expectIds(initialIds);
  await page.click(cell(a)); await startNameDrag(a, b);
  assert.ok(await page.$eval('[data-task-drag-preview]', el => el.textContent.includes('不能移到自身或子任务内')));
  await page.mouse.up(); await expectIds(initialIds);
  await page.click(cell(f)); await startNameDrag(f, a); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.waitForSelector('[data-task-drag-preview]', { hidden: true }); await expectIds(initialIds);
  await startNameDrag(f, a);
  const outside = await page.$eval('[data-gantt-grid]', el => { const r = el.getBoundingClientRect(); return { x: r.right + 50, y: r.top + 50 }; });
  await page.mouse.move(outside.x, outside.y); await page.mouse.up(); await expectIds(initialIds);
  assert.equal(report.writes.length, 0); assert.deepEqual(await state(), beforeDrag);
  pass('多选任务按原顺序整组移动；自身/子任务位置被拦截，Esc 或列表外释放均取消，原结构不丢失');

  await level(b, 1); await operation([b], '提升任务层级'); await level(b, 0);
  assert.equal(report.writes.length, 0); assert.equal((await state()).tasks.find(t => t.id === b).parent_id, a);
  // Simulate an independently changed backend and an unseen task in this fixture only.
  await api(`/tasks/${project.id}`, 'PUT', { id: c, parent_id: null, order_index: 9 });
  const remote = randomUUID(); await api(`/tasks/${project.id}`, 'POST', make(remote, '另一会话新增', null, 99, 7));
  await saveDraft();
  let rows = (await state()).tasks;
  assert.equal(rows.find(t => t.id === b).parent_id, null); assert.equal(rows.find(t => t.id === b).order_index, 1);
  assert.equal(rows.find(t => t.id === c).parent_id, a); assert.equal(rows.find(t => t.id === c).order_index, 0);
  assert.ok(rows.some(t => t.id === remote)); assert.equal((await versions()).length, 0);
  await reload(); await graphMatchesUi();
  pass('升级在保存前零写入；保存自动比对最新后台并恢复前端父级/排序，保留其他会话新增任务，刷新结果一致');

  const writes = report.writes.length;
  await operation([b], '降为子任务'); await level(b, 1);
  await page.click('button[title^="撤销"]'); await level(b, 0);
  await page.click('button[title^="重做"]'); await level(b, 1);
  assert.equal(report.writes.length, writes); await saveDraft(); await graphMatchesUi();
  assert.equal((await state()).tasks.find(t => t.id === b).parent_id, a);
  await operation([c, b], '提升任务层级'); await level(c, 0); await level(b, 0); await saveDraft(); await graphMatchesUi();
  await operation([c, b], '降为子任务'); await level(c, 1); await level(b, 1); await saveDraft(); await reload(); await graphMatchesUi();
  pass('降级、撤销/重做、多选升降级均同步父子关系和兄弟顺序，保存后刷新不回退');

  for (const [target, parent] of [[f, null], [e, d], [b, a]]) {
    const before = await state(), writesBeforeDrag = report.writes.length;
    await dragBefore(c, target); await parentInUi(c, parent);
    assert.equal(report.writes.length, writesBeforeDrag); assert.deepEqual(await state(), before);
    await saveDraft(); assert.equal((await state()).tasks.find(t => t.id === c).parent_id, parent);
    await reload(); await parentInUi(c, parent); await graphMatchesUi();
  }
  pass('真实拖动子任务到顶级、拖入另一父任务、再拖回原父任务，均自动识别层级/排序差异，保存刷新后结构一致');

  await page.select('select[aria-label="计划状态"]', 'stable');
  await operation([b], '提升任务层级'); await click('确认变更'); await page.waitForSelector(review);
  assert.ok(await page.$eval(review, e => e.textContent.includes('父任务:') && e.textContent.includes('父任务 A') && e.textContent.includes('顶级任务')));
  assert.equal(await page.$eval(review, e => [...e.querySelectorAll('button')].find(b => b.textContent.trim() === '确认并保存').disabled), true);
  const reason = '按实施顺序调整任务层级';
  for (const textarea of await page.$$(`${review} textarea[aria-required=true]`)) await textarea.type(reason);
  await page.screenshot({ path: path.join(output, 'stable-parent-review.png'), fullPage: true });
  await click('确认并保存', review); await saved(); await graphMatchesUi();
  const vs = await versions(); assert.equal(vs.length, 1);
  const version = await api(`/versions/${project.id}?id=${vs[0].id}`);
  assert.equal(version.snapshot.tasks.find(t => t.id === b).parent_id, null);
  assert.ok((await api(`/tasks/${project.id}/${b}`)).lifecycle.some(event => event.field_name === 'parent_id' && event.reason === reason));
  pass('稳定态识别父任务变化并要求原因，数据库、生命周期及版本快照的层级一致');

  await page.select('select[aria-label="计划状态"]', 'draft'); await click('新建任务');
  const fresh = await page.$eval('[data-task-row] input:checked', el => el.closest('[data-task-row]').dataset.taskRow);
  await dragBefore(fresh, b);
  await operation([b], '降为子任务'); await level(b, 1);
  await operation([fresh], '降为子任务'); await level(fresh, 1); await level(b, 2);
  abortUpdate = true; expectFailure = true;
  await click('保存', '[data-toolbar-row="progress"]');
  const deadline = Date.now() + 30000;
  while (report.expectedFailures.length !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(report.expectedFailures.length, 1); assert.equal(abortUpdate, false);
  await page.waitForFunction(() => !document.querySelector('[data-action="save-plan"]').disabled);
  assert.ok((await state()).tasks.some(t => t.id === fresh), 'Create committed before the interrupted hierarchy update');
  await level(b, 2); await saveDraft();
  rows = (await state()).tasks;
  assert.equal(rows.filter(t => t.id === fresh).length, 1); assert.equal(rows.find(t => t.id === fresh).parent_id, a);
  assert.equal(rows.find(t => t.id === b).parent_id, fresh); assert.equal((await versions()).length, 1);
  await reload(); await level(b, 2); await graphMatchesUi();
  pass('新建父任务、拖动排序及已有任务降级一起保存；中途失败后自动重新判断差异，无重复任务、无层级丢失');

  await operation([e], '提升任务层级'); await level(e, 0); await operation([d], '删除选中任务'); await saveDraft();
  rows = (await state()).tasks; assert.ok(!rows.some(t => t.id === d)); assert.equal(rows.find(t => t.id === e).parent_id, null);
  await reload(); await graphMatchesUi(); assert.deepEqual(report.pageErrors, []);
  pass('提升保留的子任务再删除旧父任务，保存不会误删子任务');

  const extra = Array.from({ length: 60 }, (_, i) => make(randomUUID(), `滚动验收 ${i + 1}`, null, i + 100, i + 100));
  await api(`/tasks/${project.id}`, 'POST', extra); await reload();
  const beforeScrollIds = await visibleIds(), beforeScrollState = await state(), writesBeforeScroll = report.writes.length;
  const source = await page.$eval(cell(a), el => { const r = el.getBoundingClientRect(); return { x: r.x + 85, y: r.y + r.height / 2 }; });
  const edge = await page.$eval('[data-gantt-grid]', el => { const r = el.getBoundingClientRect(); return { x: r.x + 150, y: r.bottom - 8 }; });
  await page.mouse.move(source.x, source.y); await page.mouse.down(); await page.mouse.move(edge.x, edge.y, { steps: 15 });
  await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').scrollTop > 160);
  await page.waitForFunction(() => Math.abs(document.querySelector('[data-gantt-grid]').scrollTop - document.querySelector('[data-timeline-scroll]').scrollTop) < 2);
  await page.screenshot({ path: path.join(output, 'edge-auto-scroll.png'), fullPage: true });
  await page.mouse.up();
  assert.notDeepEqual(await visibleIds(), beforeScrollIds);
  assert.equal(report.writes.length, writesBeforeScroll); assert.deepEqual(await state(), beforeScrollState);
  await page.click('button[title^="撤销"]'); await expectIds(beforeScrollIds);
  await page.click('button[title^="重做"]'); await saveDraft(); await reload(); await graphMatchesUi();
  pass('长列表拖到边缘自动滚动且左右同步；父任务整棵分支移动后可撤销重做，保存刷新仍保持顺序');
  assert.deepEqual(report.pageErrors, []);
  report.trustedClicks = priorClicks + await page.evaluate(() => window.__trustedClicks); report.passed = true;
  await page.screenshot({ path: path.join(output, 'saved-hierarchy.png'), fullPage: true });
}
main().catch(async error => {
  report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (project) {
    try { assert.equal((await api(`/projects/${project.id}`)).name, project.name); await api(`/projects/${project.id}`, 'DELETE'); report.fixtureCleaned = true; }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, steps: report.steps.length, cleaned: report.fixtureCleaned, report: path.join(output, 'report.json') }));
});
