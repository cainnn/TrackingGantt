// Real UI + API regression. Creates and cleans only its own temporary projects.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const login = process.env.SAVE_TEST_ROOT || 'root', password = process.env.SAVE_TEST_PASSWORD || 'root123';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-copy-drag-'));
const projects = [], errors = [], dialogs = [];
let token, browser, page;
const cell = (id, col = 'name') => `[data-task-cell="${id}"][data-col="${col}"]`;
const sorted = data => ({ ...data, tasks: [...data.tasks].sort((a, b) => a.id.localeCompare(b.id)),
  dependencies: [...data.dependencies].sort((a, b) => a.id.localeCompare(b.id)) });
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', 'x-gantt-confirmed-save': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data.value;
}
async function fixture(precision) {
  const unit = precision === 'day' ? 1440 : 60, minute = precision === 'minute';
  const epoch = Date.UTC(2030, 0, 1, minute ? 9 : 0, minute ? 15 : 0);
  const at = n => new Date(epoch + n * unit * 60000).toISOString().slice(0, 19);
  const project = await api('/projects', 'POST', { name: `拖动复制依赖验收-${precision}-${randomUUID().slice(0, 8)}`,
    start_date: '2030-01-01', status_date: '2030-01-01', time_granularity: precision, use_template: false });
  projects.push(project.id);
  const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, randomUUID()]));
  const dates = { a: [0, 1], b: [0, 2], c: [0, 3], d: [3, 4], e: [4, 5] };
  await api(`/tasks/${project.id}`, 'POST', Object.entries(ids).map(([key, id], i) => ({ id, name: key.toUpperCase(), task_code: String(i + 1),
    parent_id: null, order_index: i, start_date: at(dates[key][0]), end_date: at(dates[key][1]), duration: (dates[key][1] - dates[key][0]) * unit,
    duration_unit: precision, auto_schedule: true, constraint_type: 'asap', note: '依赖保留验收' })));
  for (const [from, to, type, lag, active] of [['a', 'd', 0, 0, true], ['b', 'd', 3, -unit, false], ['c', 'd', 2, 0, true], ['d', 'e', 2, 0, true]])
    await api(`/dependencies/${project.id}`, 'POST', { from_task_id: ids[from], to_task_id: ids[to], type, lag, active });
  await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: {
    id: 'current', name: '验收布局', search: '', columns: ['start', 'end', 'duration', 'pred', 'succ', 'taskType'], colW: minute ? 1440 : 45,
    critical: false, indicators: { deadlineDate: false, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null,
      widths: {}, nameWidth: 150, panelWidth: 1050, panelCollapsed: false, rightCollapsed: false, centerTime: epoch, scrollTop: 0 },
  } });
  return { project, ids, at, unit, minute };
}
async function activate(handle) {
  assert.ok(handle?.asElement());
  await page.evaluate(() => { window.__copyClickCount = 0; window.__copyClickProbe = () => window.__copyClickCount++;
    document.addEventListener('click', window.__copyClickProbe, true); });
  await handle.asElement().click({ delay: 40 });
  const delivered = await page.evaluate(() => { document.removeEventListener('click', window.__copyClickProbe, true); return window.__copyClickCount; });
  if (!delivered) await handle.evaluate(element => element.click());
  await handle.dispose();
}
async function click(label) {
  const matcher = label => [...document.querySelectorAll('button')].find(button => button.getClientRects().length
    && (button.textContent.trim() === label || button.title === label || button.getAttribute('aria-label') === label
      || button.getAttribute('role') === 'menuitem' && button.querySelector('span')?.textContent.trim() === label));
  await page.waitForFunction(matcher, {}, label);
  await activate(await page.evaluateHandle(matcher, label));
}
async function rightClick(selector) {
  await page.evaluate(() => { window.__copyContextCount = 0; window.__copyContextProbe = () => window.__copyContextCount++;
    document.addEventListener('contextmenu', window.__copyContextProbe, true); });
  await page.click(selector, { button: 'right' });
  const delivered = await page.evaluate(() => { document.removeEventListener('contextmenu', window.__copyContextProbe, true); return window.__copyContextCount; });
  if (!delivered) await page.$eval(selector, element => { const r = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 })); });
}
async function open(f) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('form') && Object.keys(document.querySelector('form')).some(key => key.startsWith('__reactProps$')));
  for (const [selector, value] of [['input[type=text]', login], ['input[type=password]', password]]) {
    await page.type(selector, value);
    if (await page.$eval(selector, input => input.value) !== value) {
      await page.$eval(selector, (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
      await frame();
    }
    await page.waitForFunction((selector, value) => document.querySelector(selector)?.value === value, {}, selector, value);
  }
  await click('登录');
  await page.waitForSelector(`a[href="/projects/${f.project.id}"]`);
  await activate(await page.$(`a[href="/projects/${f.project.id}"]`));
  await page.waitForSelector(cell(f.ids.d));
}
async function waitDate(f, id, offset, timeout = 45000) {
  const date = f.at(offset), display = date.slice(2, 10) + (f.minute ? ` ${date.slice(11, 16)}` : '');
  await page.waitForFunction((selector, expected) => document.querySelector(selector)?.textContent.trim() === expected, { timeout }, cell(id, 'start'), display);
}
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function deliverDrag(selector, from, to) {
  // Some macOS CDP sessions drop button state during pointer movement. Re-deliver
  // the same gesture through real DOM handlers; all business assertions remain.
  await page.$eval(selector, (el, point) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true,
    clientX: point.x, clientY: point.y, button: 0, buttons: 1 })), from);
  await frame();
  for (let step = 1; step <= 8; step++) {
    await page.evaluate(({ from, to, step }) => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true,
      clientX: from.x + (to.x - from.x) * step / 8, clientY: from.y + (to.y - from.y) * step / 8, button: 0, buttons: 1 })), { from, to, step });
    await frame();
  }
  await page.evaluate(point => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, buttons: 0 })), to);
  await frame();
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password })).token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(45000); page.setDefaultNavigationTimeout(90000);
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  page.on('pageerror', error => errors.push(error.message));
  for (const precision of ['day', 'minute']) {
    const f = await fixture(precision), baseline = await api(`/tasks/${f.project.id}`);
    await open(f); await activate(await page.$(cell(f.ids.d)));
    await page.waitForFunction(id => document.querySelector(`[data-task-row="${id}"] input[type=checkbox]`)?.checked, {}, f.ids.d);
    if (!f.minute) {
      await rightClick(cell(f.ids.e)); await click('复制选中任务到下方');
    } else {
      await click('任务操作'); await click('复制选中任务');
      await activate(await page.$(cell(f.ids.e))); await click('任务操作'); await click('粘贴任务');
    }
    await page.waitForFunction(() => [...document.querySelectorAll('[data-task-cell][data-col=name]')].some(el => el.querySelector('span.truncate')?.textContent.trim() === 'D (副本)'));
    const copyId = await page.$$eval('[data-task-cell][data-col=name]', cells => cells.find(el => el.querySelector('span.truncate')?.textContent.trim() === 'D (副本)').dataset.taskCell);
    await activate(await page.$('button[title^="撤销"]'));
    await page.waitForSelector(cell(copyId), { hidden: true });
    await activate(await page.$('button[title^="重做"]'));
    await page.waitForSelector(cell(copyId)); await waitDate(f, copyId, 3);
    console.log(`PASS ${precision}: copy and undo/redo retain the new task and its predecessor display`);

    await activate(await page.$(cell(f.ids.d)));
    const from = await page.$eval(`[data-task-drag-handle="${f.ids.d}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const to = await page.$eval(`[data-task-row="${f.ids.a}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + 3 }; });
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(id => document.querySelector('[data-task-row]')?.dataset.taskRow === id, { timeout: 1500 }, f.ids.d)
      .catch(() => deliverDrag(`[data-task-drag-handle="${f.ids.d}"]`, from, to));
    await page.waitForFunction(id => document.querySelector('[data-task-row]')?.dataset.taskRow === id, {}, f.ids.d);
    await waitDate(f, f.ids.d, 3);
    console.log(`PASS ${precision}: row drag changes ordering while keeping dates`);

    await click('显示全部');
    const hit = `[data-task-bar="${f.ids.d}"] rect[fill=transparent]`;
    await page.waitForFunction(selector => {
      const viewport = document.querySelector('[data-timeline-scroll]').getBoundingClientRect(), bar = document.querySelector(selector).getBoundingClientRect();
      return bar.x >= viewport.x && bar.right <= viewport.right;
    }, {}, hit);
    await frame();
    const point = await page.$eval(hit, (el, unit) => { const r = el.getBoundingClientRect(); return {
      x: r.x + r.width / 2, y: r.y + r.height / 2, delta: Number(document.querySelector('[data-timeline-scroll]').dataset.colWidth) * unit / 1440,
    }; }, f.unit);
    // Use the same DOM gesture path as test-gantt-interactions.cjs so minute
    // snapping receives an exact, continuous left-button movement.
    await deliverDrag(hit, point, { x: point.x + point.delta, y: point.y });
    await waitDate(f, f.ids.d, 4); await waitDate(f, f.ids.e, 5); await waitDate(f, copyId, 3);
    await activate(await page.$('button[title^="撤销"]')); await waitDate(f, f.ids.d, 3); await waitDate(f, f.ids.e, 4);
    await activate(await page.$('button[title^="重做"]')); await waitDate(f, f.ids.d, 4); await waitDate(f, f.ids.e, 5);
    assert.deepEqual(sorted(await api(`/tasks/${f.project.id}`)), sorted(baseline), 'Copy and both drags remain local until save');
    await click('保存');
    await page.waitForFunction(() => document.querySelector('[data-action=save-plan]')?.disabled && !document.querySelector('[data-action=save-plan]').textContent.includes('保存中'));
    const saved = await api(`/tasks/${f.project.id}`), byId = new Map(saved.tasks.map(t => [t.id, t]));
    assert.equal(saved.tasks.length, 6);
    assert.equal(byId.get(f.ids.d).start_date.slice(0, 19), f.at(4)); assert.equal(byId.get(f.ids.e).start_date.slice(0, 19), f.at(5));
    assert.equal(byId.get(copyId).start_date.slice(0, 19), f.at(3)); assert.equal(byId.get(copyId).auto_schedule, true);
    assert.equal(byId.get(f.ids.d).auto_schedule, false);
    assert.equal(byId.get(f.ids.d).duration, f.unit); assert.equal(byId.get(copyId).duration, f.unit);
    for (const original of baseline.dependencies) assert.deepEqual(saved.dependencies.find(dep => dep.id === original.id), original);
    const copied = saved.dependencies.filter(dep => dep.to_task_id === copyId);
    assert.equal(copied.length, 3);
    for (const original of baseline.dependencies.filter(dep => dep.to_task_id === f.ids.d)) {
      const cloned = copied.find(dep => dep.from_task_id === original.from_task_id);
      assert.ok(cloned); for (const field of ['type', 'lag', 'active']) assert.equal(cloned[field], original[field]);
    }
    assert.equal(saved.dependencies.filter(dep => dep.to_task_id === f.ids.e).length, 1);
    assert.equal(saved.dependencies.filter(dep => dep.from_task_id === copyId).length, 0);
    assert.equal(byId.get(f.ids.d).order_index, 0);
    await open(f); await waitDate(f, f.ids.d, 4); await waitDate(f, f.ids.e, 5); await waitDate(f, copyId, 3);
    assert.deepEqual(sorted(await api(`/tasks/${f.project.id}`)), sorted(saved));
    await page.screenshot({ path: path.join(output, `${precision}.png`), fullPage: true });
    console.log(`PASS ${precision}: ${f.minute ? 'clipboard paste' : 'context copy'} keeps external predecessors and internal settings; row/bar drags preserve original links; undo/redo, verified save and reopen match the database`);
  }
  assert.deepEqual(errors, []);
  assert.ok(!dialogs.some(message => /保存失败|无法保留/.test(message)), JSON.stringify(dialogs));
  console.log(JSON.stringify({ passed: true, output }));
}
main().catch(async error => { console.error(error.stack); console.error({ output, errors, dialogs }); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); })
  .finally(async () => { if (browser) await browser.close(); for (const id of projects.reverse()) await api(`/projects/${id}`, 'DELETE').catch(error => { console.error(error.message); process.exitCode = 1; }); console.log(`Cleaned ${projects.length} temporary projects`); });
