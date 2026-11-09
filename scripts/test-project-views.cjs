// Real API/database and Chrome regression. Only this run's fixtures are deleted.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.env.LAYOUT_TEST_URL || 'http://127.0.0.1:3127';
const login = process.env.LAYOUT_TEST_USER || 'root', password = process.env.LAYOUT_TEST_PASSWORD || 'root123';
const prefix = `布局验收-${randomUUID().slice(0, 8)}`;
const projects = [], users = [], errors = [];
let token, browser, page, failNextSave = false;
const settings = '[role="dialog"][aria-label="显示设置"]';
const route = p => `/projects/${p.id}/view-preferences`;
const empty = () => ({ revision: 0, currentView: null, views: [] });
const view = (id = 'current', extra = {}) => ({ id, name: '项目布局', search: '', columns: ['end', 'assignee', 'start'],
  indicators: { deadlineDate: false, constraintDate: true }, colW: 28, critical: false,
  chart: { expanded: {}, filters: {}, sortCol: 'start', sortDir: 'desc', widths: { start: 150 }, nameWidth: 240,
    panelWidth: 680, panelCollapsed: false, rightCollapsed: false, centerTime: new Date('2026-11-08T12:00:00').getTime(), scrollTop: 0 }, ...extra });
async function api(url, method = 'GET', body, expected = 200, auth = token) {
  const response = await fetch(`${base}/api${url}`, { method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${data.error ?? response.status}`);
  assert.equal(data.ok, expected < 400);
  return data.value;
}
function pass(message) { console.log(`PASS ${message}`); }
async function click(label, scope = 'body') {
  const handle = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(b => (b.textContent.trim() === label || b.getAttribute('aria-label') === label) && b.getClientRects().length), { label, scope });
  assert.ok(handle.asElement(), `Visible button: ${label}`);
  assert.equal(await handle.evaluate(b => b.disabled), false, `${label} enabled`);
  await handle.asElement().click(); await handle.dispose();
}
async function fill(selector, value) {
  await page.click(selector, { count: 3 }); await page.keyboard.press('Backspace');
  if (value) await page.type(selector, value);
}
async function openLayouts() { await click('显示设置'); await click('常用布局', settings); }
async function saveCurrent() {
  // Native wheel scrolling and panel resizing animate over several frames.
  await page.evaluate(async () => {
    let previous = '', stable = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const e = document.querySelector('[data-timeline-scroll]');
      const current = JSON.stringify([e.scrollLeft, e.clientWidth]);
      stable = previous === current ? stable + 1 : 0; previous = current;
      if (stable >= 5) return;
    }
    throw new Error('Layout did not settle before saving');
  });
  const saved = page.waitForResponse(r => r.url().endsWith('/view-preferences') && r.request().method() === 'PUT' && r.status() === 200);
  await click('保存当前布局', settings); await saved;
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('布局已保存'));
}
async function navigate(p) {
  if (!new URL(page.url()).pathname.startsWith('/dashboard')) await page.click('a[href="/dashboard"]');
  await page.waitForSelector(`a[href="/projects/${p.id}"]`);
  await page.click(`a[href="/projects/${p.id}"]`);
  await page.waitForSelector('[data-timeline-scroll]');
}
async function browserLogin(username, pwd) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', username); await page.type('input[type="password"]', pwd); await click('登录');
  await page.waitForSelector('a[href^="/projects/"]');
}
async function checkbox(label) {
  const handle = await page.evaluateHandle(({ label, settings }) => [...document.querySelectorAll(`${settings} label`)]
    .find(e => e.textContent.trim() === label)?.querySelector('input'), { label, settings });
  assert.ok(handle.asElement(), `Checkbox: ${label}`); await handle.asElement().click(); await handle.dispose();
}
async function main() {
  token = (await api('/auth/login', 'POST', { login, password }, 200, null)).token;
  for (const [label, granularity] of [['A', 'day'], ['B', 'day'], ['分钟', 'minute']]) {
    projects.push(await api('/projects', 'POST', { name: `${prefix}-${label}`, start_date: '2026-11-01',
      status_date: '2026-11-08', time_granularity: granularity, use_template: false }, 201));
  }
  const [a, b, minute] = projects;
  await api(`/tasks/${a.id}`, 'POST', Array.from({ length: 60 }, (_, i) => ({ id: randomUUID(), task_code: String(i + 1),
    name: `采购任务 ${i + 1}`, assignee: i % 2 ? '张三' : '李四', order_index: i, auto_schedule: false,
    start_date: '2026-11-01', end_date: '2026-11-15', duration: 20160 })), 201);
  const before = await api(`/tasks/${a.id}`), projectBefore = await api(`/projects/${a.id}`), versionsBefore = await api(`/versions/${a.id}?list=1`);
  assert.deepEqual(await api(route(a)), empty());
  await api(route(a), 'GET', undefined, 401, null);
  const first = await api(route(a), 'PUT', { ...empty(), currentView: view() });
  assert.equal(first.revision, 1); assert.deepEqual((await api(route(a))).currentView, view());
  assert.deepEqual(await api(route(b)), empty());
  await api(route(a), 'PUT', { ...empty(), currentView: view('stale') }, 409);
  await api(route(a), 'PUT', { ...first, currentView: { ...view(), chart: { ...view().chart, panelCollapsed: 'yes' } } }, 400);
  assert.deepEqual(await api(route(a)), first);
  const races = await Promise.all([1, 2].map(async n => {
    const response = await fetch(`${base}/api${route(a)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...first, currentView: view(`race${n}`) }) });
    return response.status;
  }));
  assert.deepEqual(races.sort(), [200, 409]);
  pass('database roundtrip, project isolation, invalid input and concurrent-save protection');
  const viewerName = `layout-${randomUUID().slice(0, 8)}`, viewerPassword = randomUUID();
  const viewer = await api('/users', 'POST', { username: viewerName, email: `${viewerName}@example.test`, password: viewerPassword, role: 'view' }, 201);
  users.push(viewer);
  const viewerToken = (await api('/auth/login', 'POST', { login: viewerName, password: viewerPassword }, 200, null)).token;
  await api(route(a), 'GET', undefined, 404, viewerToken);
  await api('/users/projects', 'POST', { userId: viewer.id, projectId: a.id });
  assert.deepEqual(await api(route(a), 'GET', undefined, 200, viewerToken), empty());
  await api(route(a), 'PUT', { ...empty(), currentView: view('viewer', { columns: [] }) }, 200, viewerToken);
  assert.notEqual((await api(route(a))).currentView.id, 'viewer');
  await api(`/projects/${a.id}`, 'PUT', { name: 'blocked' }, 403, viewerToken);
  await api(route(b), 'PUT', { ...empty(), currentView: view() }, 404, viewerToken);
  const share = await api('/share-links', 'POST', { projectId: a.id });
  const shareToken = (await api(`/share-links/${share.code}`, 'GET', undefined, 200, null)).token;
  assert.equal((await api(route(a), 'GET', undefined, 200, shareToken)).currentView, null);
  await api(route(a), 'PUT', { ...empty(), currentView: view() }, 403, shareToken);
  pass('account isolation, read-only personal preferences, project access and share-session protection');
  const current = await api(route(a));
  await api(route(a), 'PUT', { ...current, currentView: view() });
  await api(route(b), 'PUT', { ...empty(), currentView: view('current', { columns: ['assignee'], colW: 7 }) });
  await api(route(minute), 'PUT', { ...empty(), currentView: view('current', { columns: [], colW: 720 }) });
  if (!process.argv.includes('--api-only')) {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (failNextSave && request.method() === 'PUT' && request.url().endsWith('/view-preferences')) {
        failNextSave = false; return request.abort('internetdisconnected');
      }
      return request.continue();
    });
    await browserLogin(login, password); await navigate(a);
    assert.equal(await page.$eval('[data-timeline-scroll]', e => Number(e.dataset.colWidth)), 28);
    await click('显示设置'); await click('全不选', settings); await checkbox('完成时间'); await checkbox('开始时间');
    await click('关闭显示设置');
    const grid = await page.$('[data-gantt-grid]'); await grid.hover(); await page.mouse.wheel({ deltaY: 224 });
    await page.waitForFunction(() => document.querySelector('[data-gantt-grid]').scrollTop > 0);
    await page.hover('[data-timeline-scroll]'); await page.mouse.wheel({ deltaX: 196 });
    await openLayouts(); await saveCurrent();
    const saved = (await api(route(a))).currentView;
    const geometry = () => page.$eval('[data-timeline-scroll]', e => ({ left: e.scrollLeft, width: e.clientWidth, origin: e.dataset.origin, scale: e.dataset.colWidth }));
    const savedGeometry = await geometry();
    assert.deepEqual(saved.columns, ['end', 'start']); assert.ok(saved.chart.scrollTop > 0);
    await click('关闭显示设置');
    await page.reload({ waitUntil: 'networkidle0' });
    // The existing app asks users to log in again after a full reload.
    await page.waitForSelector('input[type="password"]'); await browserLogin(login, password); await navigate(a);
    await page.waitForFunction(top => Math.abs(document.querySelector('[data-gantt-grid]').scrollTop - top) < 2, {}, saved.chart.scrollTop);
    assert.equal(await page.$('[data-task-cell][data-col="assignee"]'), null);
    const start = await page.$eval('[data-task-cell][data-col="start"]', e => e.getBoundingClientRect().left);
    const end = await page.$eval('[data-task-cell][data-col="end"]', e => e.getBoundingClientRect().left);
    assert.ok(end < start, 'saved column order');
    await openLayouts(); await saveCurrent();
    const recaptured = (await api(route(a))).currentView;
    const centerDelta = Math.abs(recaptured.chart.centerTime - saved.chart.centerTime);
    assert.ok(centerDelta <= 86400000 / saved.colW + 60000, JSON.stringify({ message: 'restored timeline center within one pixel', centerDelta,
      saved: { time: saved.chart.centerTime, panel: saved.chart.panelWidth }, recaptured: { time: recaptured.chart.centerTime, panel: recaptured.chart.panelWidth }, savedGeometry, restoredGeometry: await geometry() }));
    assert.equal(recaptured.chart.panelWidth, saved.chart.panelWidth);
    assert.deepEqual(recaptured.chart.widths, saved.chart.widths);
    pass('real browser save, refresh restoration, column order/widths, panel width and timeline/grid scroll');
    await click('另存为常用布局', settings); await page.type('input[aria-label="布局名称"]', '周例会');
    await click('保存布局', settings);
    await page.waitForSelector('select[aria-label="已保存布局"] option[value]:not([value=""])');
    const namedId = await page.$eval('select[aria-label="已保存布局"]', e => e.value);
    assert.ok(namedId); await click('关闭显示设置');
    await fill('input[placeholder="搜索任务..."]', '采购任务 1');
    await openLayouts(); await click('更新此布局', settings);
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('布局已保存'));
    const named = await api(route(a));
    assert.equal(named.views.length, 1); assert.equal(named.views[0].id, namedId); assert.equal(named.views[0].search, '采购任务 1');
    await click('关闭显示设置'); await fill('input[placeholder="搜索任务..."]', '采购任务 2');
    await openLayouts(); failNextSave = true; await click('保存当前布局', settings);
    await page.waitForSelector(`${settings} [role="alert"]`);
    assert.deepEqual(await api(route(a)), named, 'failed save preserves database state');
    await saveCurrent(); assert.equal((await api(route(a))).currentView.search, '采购任务 2');
    pass('named layout creation/update and failed-save retry without losing saved data');
    await click('关闭显示设置');
    await page.click('a[href="/dashboard"]'); await page.waitForSelector(`a[href="/projects/${b.id}"]`);
    await page.click(`a[href="/projects/${b.id}"]`); await page.waitForSelector('[data-timeline-scroll]');
    assert.equal(await page.$eval('[data-timeline-scroll]', e => Number(e.dataset.colWidth)), 7);
    assert.equal(await page.$eval('input[placeholder="搜索任务..."]', e => e.value), '');
    await navigate(minute); assert.equal(await page.$eval('[data-timeline-scroll]', e => Number(e.dataset.colWidth)), 720);
    const context = await browser.createBrowserContext();
    page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    await browserLogin(login, password); await navigate(a);
    assert.equal(await page.$eval('input[placeholder="搜索任务..."]', e => e.value), '采购任务 2');
    pass('SPA project switching, empty minute project restoration and fresh-browser account restore');
    const viewerContext = await browser.createBrowserContext(); page = await viewerContext.newPage();
    await page.setViewport({ width: 1440, height: 1000 }); await browserLogin(viewerName, viewerPassword); await navigate(a);
    await openLayouts(); await saveCurrent();
    assert.ok((await api(route(a), 'GET', undefined, 200, viewerToken)).revision > 1);
    assert.equal((await api(route(a))).currentView.search, '采购任务 2');
    assert.deepEqual(errors, []);
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-project-layouts-'));
    await page.screenshot({ path: path.join(output, 'saved-layout.png'), fullPage: true });
    console.log(`Screenshot: ${output}/saved-layout.png`);
    pass('read-only account saves through the browser without modifying another user layout');
  }
  assert.deepEqual(await api(`/tasks/${a.id}`), before);
  assert.deepEqual(await api(`/projects/${a.id}`), projectBefore);
  assert.deepEqual(await api(`/versions/${a.id}?list=1`), versionsBefore);
  pass('layout operations leave project plan, tasks, dependencies and versions unchanged');
}
main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (page) {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-layout-failure-'));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    console.error({ url: page.url(), errors, screenshot: path.join(output, 'failure.png') });
  }
}).finally(async () => {
  if (browser) await browser.close();
  for (const p of projects) await api(`/projects/${p.id}`, 'DELETE').catch(console.error);
  for (const user of users) await api('/users', 'DELETE', { userId: user.id }).catch(console.error);
});
