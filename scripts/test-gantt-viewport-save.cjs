// Real API + browser persistence regression. Only this run's disposable projects are written.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3147';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-viewport-save-'));
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
  const find = label => [...document.querySelectorAll('button')].find(b => !b.disabled && (b.textContent.trim() === label || (b.getAttribute('role') === 'menuitem' && b.querySelector('span')?.textContent === label) || b.getAttribute('aria-label') === label || b.title === label || ((label === '撤销' || label === '重做') && b.title.startsWith(label))));
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
async function main() {
  token = (await api('/auth/login', 'POST', { login: process.env.SAVE_TEST_ROOT || 'root', password: process.env.SAVE_TEST_PASSWORD || 'root123' })).token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(90000);
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', async d => { if (/失败|冲突/.test(d.message())) errors.push(d.message()); await d.accept(); });
  for (const precision of ['day', 'minute']) {
    const minute = precision === 'minute', unit = minute ? 60 : 1440;
    const at = n => new Date(Date.UTC(2030, 0, 1, minute ? 9 : 0) + n * unit * 60000).toISOString().slice(0, 19);
    const project = await api('/projects', 'POST', { name: `虚拟滚动保存验收-${precision}-${randomUUID().slice(0, 8)}`, time_granularity: precision, planning_status: 'draft', status_date: at(0), use_template: false }); projects.push(project.id);
    const tasks = Array.from({ length: 500 }, (_, i) => ({ id: randomUUID(), name: `任务 ${i}`, task_code: String(i + 1), order_index: i, parent_id: null,
      start_date: at(0), end_date: at(1), duration: unit, auto_schedule: i === 499, assignee: `责任人${i}` }));
    const first = tasks[0].id, last = tasks.at(-1).id;
    await api(`/tasks/${project.id}`, 'POST', tasks);
    await api(`/dependencies/${project.id}`, 'POST', { from_task_id: first, to_task_id: last, type: 0, lag: 0 });
    await api(`/projects/${project.id}/view-preferences`, 'PUT', { revision: 0, views: [], currentView: { id: 'current', name: '保存验收布局', search: '', columns: ['assignee', 'start', 'end', 'pred'], colW: minute ? 1440 : 28, critical: false,
      indicators: { deadlineDate: true, constraintDate: true }, chart: { expanded: {}, filters: {}, sortCol: null, sortDir: null, widths: {}, nameWidth: 160, panelWidth: 850, panelCollapsed: false, rightCollapsed: false,
        centerTime: new Date(`${at(0)}+08:00`).getTime(), scrollTop: 0 } } });
    const before = await api(`/tasks/${project.id}`); await open(project);
    assert.ok(await page.$$eval('[data-task-row]', rows => rows.length) < 60);
    // Reorder using actual viewport coordinates far below row zero, then undo.
    await scroll(200, tasks[200].id);
    const p = await page.$eval(cell(tasks[200].id), el => { const r = el.getBoundingClientRect(); return { x: r.x + 70, y: r.y + 20 }; });
    const target = await page.$eval(`[data-task-row="${tasks[204].id}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 2 }; });
    await page.$eval(cell(tasks[200].id), (el, p) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), p);
    await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x, clientY: p.y, buttons: 1 })), target);
    await page.waitForSelector('[data-task-drag-preview]'); await page.evaluate(p => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x, clientY: p.y, button: 0 })), target); await frame();
    const reordered = await page.$$eval('[data-task-row]', rows => rows.map(r => r.dataset.taskRow)); assert.ok(reordered.indexOf(tasks[200].id) > reordered.indexOf(tasks[203].id));
    await button('撤销'); console.log('PASS', precision, 'scrolled row reorder');
    // Drag the first task: its automatic successor is several hundred rows off screen.
    await scroll(0, first); await click(cell(first));
    const point = await page.$eval(`[data-task-bar="${first}"] rect[fill=transparent]`, (el, minute) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, dx: Number(document.querySelector('[data-timeline-scroll]').dataset.colWidth) / (minute ? 24 : 1) }; }, minute);
    await page.$eval(`[data-task-bar="${first}"] rect[fill=transparent]`, (el, p) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), point);
    await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x + p.dx, clientY: p.y, buttons: 1 })), point); await frame();
    await page.evaluate(p => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x + p.dx, clientY: p.y, button: 0 })), point); await frame();
    await scroll(499, last);
    await page.waitForFunction((selector, date) => document.querySelector(selector)?.textContent.includes(date), {}, cell(last, 'start'), minute ? '10:00' : '01-02');
    assert.deepEqual(await api(`/tasks/${project.id}`), before, 'Offscreen cascade remains local until Save');
    await button('撤销'); await page.waitForFunction((selector, date) => document.querySelector(selector)?.textContent.includes(date), {}, cell(last, 'start'), minute ? '09:00' : '01-01');
    await button('重做'); console.log('PASS', precision, 'offscreen cascade and undo');
    // Copy a pair selected on different screens; the copied internal dependency must survive.
    await scroll(0, first); await click(cell(first)); await scroll(499, last); await click(`[data-task-row="${last}"] input[type=checkbox]`, { ctrlKey: true });
    await button('任务操作'); await button('复制选中任务'); await button('任务操作'); await button('粘贴任务');
    await page.waitForFunction(() => Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) === 502);
    await button('撤销'); await page.waitForFunction(() => Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) === 500);
    await button('重做'); await page.waitForFunction(() => Number(document.querySelector('[data-gantt-grid]').dataset.rowCount) === 502);
    await button('保存'); await page.waitForFunction(() => { const b = document.querySelector('[data-action=save-plan]'); return b?.disabled && b.textContent.trim() === '保存'; });
    const saved = await api(`/tasks/${project.id}`);
    assert.equal(saved.tasks.length, 502); assert.equal(saved.dependencies.length, 2);
    for (const id of [first, last]) { const t = saved.tasks.find(t => t.id === id); assert.equal(t.start_date.slice(0, 16), at(1).slice(0, 16)); assert.equal(t.end_date.slice(0, 16), at(2).slice(0, 16)); }
    assert.equal(saved.tasks.find(t => t.id === last).auto_schedule, true);
    const originalIds = new Set(tasks.map(t => t.id)), copies = saved.tasks.filter(t => !originalIds.has(t.id)); assert.equal(copies.length, 2);
    assert.ok(saved.dependencies.some(d => copies.some(t => t.id === d.from_task_id) && copies.some(t => t.id === d.to_task_id)));
    for (const task of before.tasks.filter(t => t.id !== first && t.id !== last)) { const actual = saved.tasks.find(t => t.id === task.id); assert.equal(actual.start_date, task.start_date); assert.equal(actual.end_date, task.end_date); assert.equal(actual.assignee, task.assignee); }
    await open(project); await scroll(499, last); await page.waitForFunction((selector, date) => document.querySelector(selector)?.textContent.includes(date), {}, cell(last, 'start'), minute ? '10:00' : '01-02');
    assert.equal(await page.$eval('[data-gantt-grid]', el => Number(el.dataset.rowCount)), 502);
    assert.deepEqual(await api(`/tasks/${project.id}`), saved);
    await page.screenshot({ path: path.join(output, `${precision}-saved.png`), fullPage: true });
    console.log(`PASS ${precision}: 500 rows, offscreen reorder/cascade, cross-screen copy dependencies, undo/redo, full save and reopen`);
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, output, projects: projects.length }));
}
main().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1; })
.finally(async () => { if (browser) await browser.close(); for (const id of projects) await api(`/projects/${id}`, 'DELETE').catch(e => console.error('cleanup', e)); console.log(`Cleaned ${projects.length} temporary projects. ${output}`); });
