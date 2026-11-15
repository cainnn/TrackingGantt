// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-impact-'));
const projects = [], errors = []; let token, browser, page;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', 'x-gantt-confirmed-save': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
const cell = (id, col = 'name') => `[data-task-cell="${id}"][data-col="${col}"]`;
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function click(selector, extra = {}) { await page.$eval(selector, (el, extra) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...extra })), extra); await frame(); }
async function button(label) {
  const find = label => [...document.querySelectorAll('button')].find(b => !b.disabled && b.getClientRects().length && (b.textContent.trim() === label || (b.getAttribute('role') === 'menuitem' && b.querySelector('span')?.textContent === label) || b.getAttribute('aria-label') === label || b.title === label || ((label === '撤销' || label === '重做') && b.title.startsWith(label))));
  await page.waitForFunction(find, {}, label); const h = await page.evaluateHandle(find, label); await h.evaluate(el => el.click()); await h.dispose(); await frame();
}
async function fill(selector, value) { await page.$eval(selector, (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value); await frame(); }
async function scroll(index, id) { await page.$eval('[data-gantt-grid]', (el, index) => { el.scrollTop = index * 40; el.dispatchEvent(new Event('scroll')); }, index); await page.waitForSelector(cell(id)); await frame(); }
async function open(project) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(k => k.startsWith('__reactProps$')));
  await fill('input[type=text]', process.env.SAVE_TEST_ROOT || 'root'); await fill('input[type=password]', process.env.SAVE_TEST_PASSWORD || 'root123'); await button('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
  // Project preferences arrive separately and restore scroll over two frames.
  await page.waitForNetworkIdle({ idleTime: 150 }); await frame();
}
// The API does not promise dependency row order; compare all records by ID.
const canonical = plan => ({ ...plan, tasks: [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id)), dependencies: [...plan.dependencies].sort((a, b) => a.id.localeCompare(b.id)) });
const panel = '#schedule-impact-panel';
const impactTask = id => `${panel} [data-impact-task="${id}"]`;
const text = selector => page.$eval(selector, el => el.textContent.trim());
async function rename(id, value) {
  await page.$eval(cell(id), el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  await fill(`${cell(id)} input`, value);
  await page.$eval(`${cell(id)} input`, input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })));
  await frame();
}
async function waitSaved() { await page.waitForFunction(() => { const b = document.querySelector('[data-action=save-plan]'); return b?.disabled && b.textContent.trim() === '保存'; }); }
async function main() {
  token = (await api('/auth/login', 'POST', { login: process.env.SAVE_TEST_ROOT || 'root', password: process.env.SAVE_TEST_PASSWORD || 'root123' })).token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  let held, holdDeletion = false, failWrite = false;
  await page.setRequestInterception(true);
  page.on('request', async r => {
    try {
      if (holdDeletion && r.method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/tasks/')) { holdDeletion = false; held = r; return; }
      if (failWrite && r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/tasks/')) { failWrite = false; return await r.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '验收模拟暂时不可用' }) }); }
      await r.continue();
    } catch (e) { if (!r.isInterceptResolutionHandled()) await r.abort(); errors.push(e.message); }
  });
  for (const precision of ['day', 'minute']) {
    const minute = precision === 'minute', unit = minute ? 60 : 1440;
    const at = n => new Date(Date.UTC(2030, 0, 1, minute ? 9 : 0) + n * unit * 60000).toISOString().slice(0, 19);
    const project = await api('/projects', 'POST', { name: `影响预览验收-${precision}-${randomUUID().slice(0, 8)}`, time_granularity: precision, planning_status: 'draft', status_date: at(0), use_template: false }); projects.push(project.id);
    const ids = Object.fromEntries(['a','b','c','d','m','e'].map(k => [k, randomUUID()]));
    const spans = { a: [0, 1], b: [0, 2], c: [0, 3], d: [3, 4], m: [3, 4], e: [4, 5] };
    const tasks = Object.entries(ids).map(([key, id], index) => ({ id, name: key.toUpperCase(), task_code: String(index + 1), parent_id: null, order_index: key === 'e' ? 90 : index,
      start_date: at(spans[key][0]), end_date: at(spans[key][1]), duration: (spans[key][1] - spans[key][0]) * unit, duration_unit: precision, auto_schedule: key !== 'm', constraint_type: 'asap' }));
    tasks.push(...Array.from({ length: 70 }, (_, n) => ({ id: randomUUID(), name: `其他任务 ${n}`, task_code: String(n + 10), parent_id: null, order_index: n + 10,
      start_date: at(0), end_date: at(1), duration: unit, auto_schedule: false })));
    await api(`/tasks/${project.id}`, 'POST', tasks);
    for (const [from, to] of [['a','d'],['b','d'],['c','d'],['d','e'],['b','m'],['c','m']]) await api(`/dependencies/${project.id}`, 'POST', { from_task_id: ids[from], to_task_id: ids[to], type: 2, lag: 0 });
    // Creating a dependency intentionally switches its target to automatic mode.
    await api(`/tasks/${project.id}`, 'PUT', [{ id: ids.m, auto_schedule: false }]);
    await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: { id: 'current', name: '影响验收布局', search: '', columns: ['start','end','duration','lag','pred'], colW: minute ? 1440 : 35, critical: false,
      indicators: { deadlineDate: true, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null, widths: {}, nameWidth: 160, panelWidth: 770, panelCollapsed: false, rightCollapsed: false,
        centerTime: new Date(`${at(0)}+08:00`).getTime(), scrollTop: 0 } } });
    const before = await api(`/tasks/${project.id}`); assert.equal(before.tasks.find(t => t.id === ids.m).auto_schedule, false); await open(project);
    await button('影响预览'); assert.match(await text(panel), /暂无待保存操作/);
    await rename(ids.a, 'A 修改');
    await click(cell(ids.c)); await button('删除选中任务');
    await page.waitForSelector(impactTask(ids.e));
    assert.match(await text(impactTask(ids.c)), /删除 · 直接操作/);
    assert.match(await text(impactTask(ids.d)), /自动级联.*删除前置「C」.*当前由「B」/);
    assert.match(await text(impactTask(ids.e)), /自动级联.*随前置「D」/);
    assert.match(await text(impactTask(ids.m)), /手动保留.*起止日期保持不变/);
    assert.match(await text(impactTask(ids.d)), minute ? /提前 1小时/ : /提前 1天/);
    assert.equal(await page.$(impactTask(ids.a)), null, 'latest excludes earlier rename');
    assert.deepEqual(canonical(await api(`/tasks/${project.id}`)), canonical(before), 'preview never saves');
    await button('全部待保存'); assert.match(await text(impactTask(ids.a)), /直接操作/);
    await button('最近一步');
    await fill('input[placeholder="搜索任务..."]', 'A 修改');
    await button('定位 E'); await page.waitForSelector(cell(ids.e));
    assert.equal(await page.$eval('input[placeholder="搜索任务..."]', el => el.value), '');
    assert.match(await text(cell(ids.e, 'start')), minute ? /12:00/ : /01-04/);
    await button('撤销最近一步'); assert.match(await text(panel), /重命名任务/);
    await button('重做'); await page.waitForSelector(impactTask(ids.d));
    await page.screenshot({ path: path.join(output, `${precision}-delete-impact.png`), fullPage: true });
    console.log('PASS', precision, 'latest/cumulative delete causes, manual skip, offscreen locate, grouped undo/redo');

    await button('定位 E');
    await page.$eval(cell(ids.e, 'lag'), el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    await fill(`${cell(ids.e, 'lag')} input`, minute ? '60' : '1'); await page.$eval(`${cell(ids.e, 'lag')} input`, el => el.blur()); await frame();
    assert.match(await text(impactTask(ids.e)), /直接操作.*修改依赖间隔/);
    assert.match(await text(panel), /依赖变化（1）/);
    await button('撤销最近一步');

    await button('定位 D'); await click(cell(ids.d));
    const point = await page.$eval(`[data-task-bar="${ids.d}"] rect[fill=transparent]`, (el, minute) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dx: Number(document.querySelector('[data-timeline-scroll]').dataset.colWidth) / (minute ? 24 : 1) }; }, minute);
    await page.$eval(`[data-task-bar="${ids.d}"] rect[fill=transparent]`, (el, p) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), point);
    await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x + p.dx, clientY: p.y, buttons: 1 })), point); await frame();
    await page.evaluate(p => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x + p.dx, clientY: p.y, button: 0 })), point); await frame();
    assert.match(await text(impactTask(ids.d)), /直接操作.*移动任务/);
    assert.match(await text(impactTask(ids.e)), /自动级联/);
    await button('撤销最近一步');
    await click(cell(ids.d)); await button('任务操作'); await button('复制选中任务'); await button('任务操作'); await button('粘贴任务');
    assert.match(await text(panel), /新增 · 直接操作/); assert.match(await text(panel), /依赖变化/);
    await button('撤销最近一步');
    assert.deepEqual(canonical(await api(`/tasks/${project.id}`)), canonical(before));
    console.log('PASS', precision, 'dependency lag, drag and copy are inspectable single undo steps');

    // Pause a real save and make a new local edit; only the submitted changes
    // should leave the preview after authoritative backend readback.
    holdDeletion = true; await button('保存');
    const deadline = Date.now() + 30000;
    while (!held) { assert.ok(Date.now() < deadline, 'save reaches deletion request'); await new Promise(r => setTimeout(r, 80)); }
    assert.match(await text(panel), /正在保存/);
    assert.equal(await page.$eval(`${panel} button[title^="撤销"]`, b => b.disabled), true);
    await scroll(0, ids.b); await rename(ids.b, 'B 保存期间修改');
    const request = held; held = null; await request.continue();
    await page.waitForFunction(() => document.querySelector('[data-action=save-plan]')?.textContent.trim() === '保存');
    await page.waitForSelector(impactTask(ids.b));
    assert.equal(await page.$(impactTask(ids.c)), null, 'saved operation no longer appears');
    await button('全部待保存'); assert.equal(await page.$$eval(`${panel} [data-impact-task]`, els => els.length), 1);
    const saved = await api(`/tasks/${project.id}`);
    assert.equal(saved.tasks.some(t => t.id === ids.c), false);
    assert.equal(saved.tasks.find(t => t.id === ids.d).start_date.slice(0, 16), at(2).slice(0, 16));
    assert.equal(saved.tasks.find(t => t.id === ids.e).start_date.slice(0, 16), at(3).slice(0, 16));
    assert.equal(saved.tasks.find(t => t.id === ids.m).start_date.slice(0, 16), at(3).slice(0, 16));
    assert.equal(saved.tasks.find(t => t.id === ids.b).name, 'B');
    await button('保存'); await waitSaved(); assert.match(await text(panel), /当前草稿与已保存计划一致/);
    console.log('PASS', precision, 'backend confirms cascades; in-flight edits remain pending until next save');

    await button('最近一步'); await rename(ids.b, 'B 重试保存'); failWrite = true; await button('保存');
    await page.waitForFunction(() => document.querySelector('#schedule-impact-panel')?.textContent.includes('上次保存结果待核对'));
    assert.match(await text(impactTask(ids.b)), /B 重试保存/);
    assert.equal(await page.$eval(`${panel} button[title^="撤销"]`, b => b.disabled), true);
    assert.equal((await api(`/tasks/${project.id}`)).tasks.find(t => t.id === ids.b).name, 'B 保存期间修改');
    await button('保存'); await waitSaved(); assert.match(await text(panel), /暂无待保存操作/);
    await open(project); await button('影响预览'); assert.match(await text(panel), /暂无待保存操作/);
    const reopened = await api(`/tasks/${project.id}`);
    assert.equal(reopened.tasks.find(t => t.id === ids.b).name, 'B 重试保存');
    assert.equal(reopened.tasks.find(t => t.id === ids.e).start_date.slice(0, 16), at(3).slice(0, 16));
    assert.equal(reopened.dependencies.some(d => d.from_task_id === ids.c || d.to_task_id === ids.c), false);
    console.log('PASS', precision, 'failed save retains preview; retry and reopen confirm persistence');
  }
  assert.deepEqual(errors, []); assert.equal(dialogs.filter(d => d.includes('保存失败')).length, 2);
  console.log(JSON.stringify({ passed: true, output, projects: projects.length }));
}
main().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; })
.finally(async () => { if (browser) await browser.close(); for (const id of projects) await api(`/projects/${id}`, 'DELETE').catch(e => console.error('cleanup', e)); console.log(`Cleaned ${projects.length} temporary projects. ${output}`); });
