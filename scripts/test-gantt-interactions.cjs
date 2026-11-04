// Browser regression with every /api route intercepted. Safe on a deployed URL:
// fixture edits never reach its database. Real API persistence is tested by test:save.
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const base = process.env.INTERACTION_TEST_URL || 'http://127.0.0.1:3117';
const project = { id: 'interaction-fixture', name: '交互回归', user_id: 'fixture', start_date: '2026-11-01', end_date: '2026-11-06', status_date: '2026-11-02', time_granularity: 'day' };
const task = (id, parent_id = null) => ({ id, project_id: project.id, parent_id, task_code: id, name: `任务${id}`, assignee: null, start_date: '2026-11-02T00:00:00', end_date: '2026-11-03T00:00:00', duration: 1440, duration_unit: 'minute', percent_done: 0, is_milestone: false, order_index: Number(id), auto_schedule: false, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', note: null });
let browser;
const errors = [], writes = [];
const waitFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function fill(page, selector, value) {
  await page.$eval(selector, (e, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await waitFrame(page);
  assert.equal(await page.$eval(selector, e => e.value), value);
}
let eventFallbacks = 0;
async function clickElement(page, handle, options = {}) {
  const type = options.clickCount === 2 ? 'dblclick' : 'click';
  await page.evaluate(type => {
    window.__probeCount = 0;
    window.__probe = () => window.__probeCount++;
    document.addEventListener(type, window.__probe, true);
  }, type);
  await handle.click({ delay: 40, ...options }); await waitFrame(page);
  const delivered = await page.evaluate(type => {
    document.removeEventListener(type, window.__probe, true); return window.__probeCount;
  }, type);
  // Some macOS headless sessions drop CDP pointer events entirely. Only fall
  // back when no event reached the document; never bypass app event handlers.
  if (!delivered) {
    eventFallbacks++;
    await handle.evaluate((el, { type, mods }) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...mods }));
    }, { type, mods: page.testModifiers || {} });
    await waitFrame(page);
  }
}
async function button(page, label) {
  const h = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label), label);
  assert.ok(h.asElement(), `button: ${label}`);
  assert.equal(await h.evaluate(b => b.disabled), false, `${label} disabled`);
  await clickElement(page, h.asElement()); await h.dispose();
}
const cell = (id, col) => `[data-task-cell="${id}"][data-col="${col}"]`;
async function text(page, selector) { return page.$eval(selector, e => e.textContent.trim()); }
async function expectText(page, selector, expected, contains = false) { await page.waitForFunction((selector, expected, contains) => { const actual = document.querySelector(selector)?.textContent.trim(); return contains ? actual?.includes(expected) : actual === expected }, {}, selector, expected, contains); }
async function undo(page) { await page.click('button[title^="撤销"]'); await waitFrame(page); }
async function redo(page) { await page.click('button[title^="重做"]'); await waitFrame(page); }
async function selected(page) { return page.$$eval('[data-task-row]', rows => rows.filter(r => r.querySelector('input[type=checkbox]')?.checked).map(r => r.dataset.taskRow)); }
async function fixture(role = 'admin', minute = false, history = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1100 });
  page.setDefaultTimeout(15000);
  // A deployed server may deliver its initial bundles over a slow connection.
  // Keep interaction assertions at 15s; only navigation gets a larger budget.
  page.setDefaultNavigationTimeout(60000);
  page.testModifiers = {};
  const keyDown = page.keyboard.down.bind(page.keyboard), keyUp = page.keyboard.up.bind(page.keyboard);
  const modifierKey = { Shift: 'shiftKey', Control: 'ctrlKey', Meta: 'metaKey' };
  page.keyboard.down = async key => { if (modifierKey[key]) page.testModifiers[modifierKey[key]] = true; return keyDown(key); };
  page.keyboard.up = async key => { if (modifierKey[key]) page.testModifiers[modifierKey[key]] = false; return keyUp(key); };
  const nativePress = page.keyboard.press.bind(page.keyboard);
  page.keyboard.press = async (key, options) => {
    await page.evaluate(() => { window.__keyCount = 0; window.__keyProbe = () => window.__keyCount++; document.addEventListener('keydown', window.__keyProbe, true); });
    await nativePress(key, options); await waitFrame(page);
    const delivered = await page.evaluate(() => { document.removeEventListener('keydown', window.__keyProbe, true); return window.__keyCount; });
    if (!delivered) {
      eventFallbacks++;
      await page.evaluate(({ key, mods }) => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...mods })), { key, mods: page.testModifiers });
      await waitFrame(page);
    }
  };
  page.click = async (selector, options = {}) => {
    const element = await page.$(selector); assert.ok(element, selector);
    await clickElement(page, element, options); await element.dispose();
  };
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept().catch(e => errors.push(e.message)));
  page.pendingRequests = new Set();
  page.on('request', r => page.pendingRequests.add(r.url()));
  page.on('requestfinished', r => page.pendingRequests.delete(r.url()));
  page.on('requestfailed', r => page.pendingRequests.delete(r.url()));
  await page.setRequestInterception(true);
  const p = { ...project, status_date: minute ? '2026-11-02T09:00:00' : project.status_date, time_granularity: minute ? 'minute' : 'day' };
  const tasks = [task('1'), task('2'), task('3'), task('4', '3')].map(t => minute ? { ...t, start_date: '2026-11-02T09:00:00', end_date: '2026-11-02T10:15:00', duration: 75 } : t);
  page.on('request', async req => {
    const url = new URL(req.url()), path = url.pathname;
    if (!path.startsWith('/api/')) return req.continue();
    let value = [];
    if (path === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role }, token: 'fixture-token' };
    else if (req.method() !== 'GET') { writes.push({ method: req.method(), path }); value = null; }
    else if (path === '/api/projects') value = [p];
    else if (path === `/api/projects/${p.id}`) value = p;
    else if (path === `/api/tasks/${p.id}`) value = { tasks, dependencies: [] };
    else if (history && path === `/api/versions/${p.id}`) {
      const version = { id: 'version-fixture', project_id: p.id, version_number: 1, name: '历史快照', status_date: p.status_date, is_autosave: false, created_at: '2026-11-02T00:00:00' };
      value = url.searchParams.has('id') ? { ...version, snapshot: { tasks, dependencies: [], lines: [] } } : [version];
    }
    // Empty versions explicitly verifies that entering a project never creates an initial snapshot.
    await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type=submit]'); await waitFrame(page);
  await page.type('input[type=text]', 'fixture'); await page.type('input[type=password]', 'fixture');
  await page.click('button[type=submit]');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`);
  await page.click(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector(cell('4', 'name')); await waitFrame(page);
  return page;
}
async function main() {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await fixture();
  assert.deepEqual(writes, []);
  await page.click(cell('1', 'name'));
  await page.keyboard.down('Shift'); await page.click(cell('3', 'name')); await page.keyboard.up('Shift');
  assert.deepEqual(await selected(page), ['1', '2', '3']);
  await button(page, '批量修改');
  await page.click('[role=dialog] input[type=checkbox]');
  await page.type('[aria-label="批量责任人"]', '张三');
  await button(page, '应用到草稿');
  await expectText(page, cell('4', 'assignee'), '张三');
  await undo(page); await expectText(page, cell('4', 'assignee'), '');
  await redo(page); await expectText(page, cell('4', 'assignee'), '张三');
  await undo(page);
  // Dragging a selected bar moves the selection together and undoes in one step.
  await page.click(cell('1', 'name'));
  await page.keyboard.down('Shift'); await page.click(cell('2', 'name')); await page.keyboard.up('Shift');
  await button(page, '显示全部');
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-timeline-scroll]').getBoundingClientRect();
    const bar = document.querySelector('[data-task-bar="1"]').getBoundingClientRect();
    return bar.x > viewport.x && bar.right < viewport.right;
  });
  const dragPoint = await page.$eval('[data-task-bar="1"] rect[fill=transparent]', e => {
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, step: Number(document.querySelector('[data-timeline-scroll]').dataset.colWidth) };
  });
  await page.$eval('[data-task-bar="1"] rect[fill=transparent]', (e, p) => e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), dragPoint);
  await waitFrame(page);
  await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x + p.step, clientY: p.y, buttons: 1 })), dragPoint);
  await expectText(page, cell('2', 'start'), '11-03', true);
  await page.evaluate(p => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x + p.step, clientY: p.y, button: 0 })), dragPoint);
  await waitFrame(page);
  await expectText(page, cell('1', 'start'), '11-03', true);
  await expectText(page, cell('4', 'start'), '11-02', true);
  await undo(page); await expectText(page, cell('1', 'start'), '11-02', true);
  await expectText(page, cell('2', 'start'), '11-02', true);
  // A two-column, two-row paste is one history step.
  await page.click(cell('1', 'name'));
  assert.deepEqual(await selected(page), ['1']);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '粘贴甲\t甲\n粘贴乙\t乙');
    document.querySelector('[data-gantt-grid]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await waitFrame(page);
  await expectText(page, cell('2', 'name'), '粘贴乙', true);
  await undo(page); await expectText(page, cell('1', 'name'), '任务1', true);
  // Enter starts editing; Esc cancels; Tab commits and moves to the next editable column.
  await page.click(cell('1', 'name')); await page.keyboard.press('Enter');
  await page.waitForSelector(`${cell('1', 'name')} input`);
  await page.keyboard.type('取消编辑'); await page.keyboard.press('Escape');
  await expectText(page, cell('1', 'name'), '任务1', true);
  await page.keyboard.press('Enter'); await page.keyboard.type('键盘编辑'); await page.keyboard.press('Tab');
  await waitFrame(page); await expectText(page, cell('1', 'name'), '键盘编辑', true);
  await undo(page);
  // Lines are local, including undo/redo and discarding.
  await page.click('button[title="项目线管理"]');
  await page.type('input[placeholder="名称"]', '本地节点');
  await page.$eval('input[placeholder="名称"]', name => { const e = name.parentElement.querySelector('input[type=date]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, '2026-11-05'); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await button(page, '添加');
  assert.ok((await page.$eval('body', e => e.textContent)).includes('本地节点'));
  await undo(page);
  assert.equal((await page.$eval('body', e => e.textContent)).includes('本地节点'), false);
  await redo(page);
  await button(page, '放弃全部更改');
  assert.equal((await page.$eval('body', e => e.textContent)).includes('本地节点'), false);
  await page.click('button[title="项目线管理"]');
  // Task bar double click uses the same editor as the table.
  await button(page, '显示全部');
  await page.click('[data-task-bar="1"] rect[fill=transparent]', { clickCount: 2 });
  await page.waitForSelector('[role=dialog][aria-label="编辑任务"]');
  await button(page, '取消');
  // Core status-date line: preview updates progress before mouseup, then is
  // one undoable draft edit. Neither preview nor undo sends a write request.
  await button(page, '回到状态日期');
  const point = await page.$eval('[data-status-date-handle=body]', e => {
    const r = e.getBoundingClientRect(); const timeline = document.querySelector('[data-timeline-scroll]');
    return { x: r.x, y: r.y + 24, step: Number(timeline.dataset.colWidth) };
  });
  await page.$eval('[data-status-date-handle=body]', (e, p) => e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), point);
  await waitFrame(page);
  await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x + p.step, clientY: p.y, buttons: 1 })), point);
  await page.waitForFunction(() => document.querySelector('h1').textContent.includes('100%'));
  assert.equal(await page.$eval('input[placeholder=YYYY-MM-DD]', e => e.value), '2026-11-02');
  await page.evaluate(p => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x + p.step, clientY: p.y, button: 0 })), point);
  await page.waitForFunction(() => document.querySelector('input[placeholder=YYYY-MM-DD]').value === '2026-11-03');
  assert.equal(await page.$eval('button[title^="撤销"]', b => b.disabled), false);
  await undo(page);
  await page.waitForFunction(() => document.querySelector('input[placeholder=YYYY-MM-DD]').value === '2026-11-02' && document.querySelector('h1').textContent.includes('0%'));
  await page.$eval('[data-status-date-handle=body]', e => e.focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('input[placeholder=YYYY-MM-DD]').value === '2026-11-03');
  await undo(page);
  // Esc cancels an in-flight status preview without adding a history step.
  await page.$eval('[data-status-date-handle=body]', (e, p) => e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 })), point);
  await waitFrame(page);
  await page.evaluate(p => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x + p.step, clientY: p.y, buttons: 1 })), point);
  await page.waitForFunction(() => document.querySelector('h1').textContent.includes('100%'));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
  await page.waitForFunction(() => document.querySelector('h1').textContent.includes('0%'));
  assert.equal(await page.$eval('button[title^="撤销"]', b => b.disabled), true);
  assert.deepEqual(writes, []);
  console.log('PASS status-date line: live progress preview, release to draft, keyboard adjustment, undo; zero writes');
  // Saving and applying views persists only UI preferences.
  await fill(page, 'input[placeholder="搜索任务..."]', '任务1');
  await button(page, '保存视图');
  await fill(page, 'input[aria-label="视图名称"]', '我的视图');
  await button(page, '保存当前视图');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gantt-saved-views-v1-interaction-fixture')));
  assert.equal(stored[0].search, '任务1'); assert.equal('tasks' in stored[0], false);
  await fill(page, 'input[placeholder="搜索任务..."]', '');
  await button(page, '应用');
  assert.equal(await page.$eval('input[placeholder="搜索任务..."]', e => e.value), '任务1');
  assert.deepEqual(writes, []);
  await page.screenshot({ path: '/private/tmp/gantt-interactions.png' });
  console.log('PASS day UI: shift selection, bulk subtree edits, grid paste, Enter/Tab/Esc, undo/redo, local project lines, double-click editor, saved views; zero writes');
  await page.close();
  const minutePage = await fixture('admin', true);
  await button(minutePage, '显示全部');
  await minutePage.click(cell('1', 'duration'), { clickCount: 2 });
  const input = await minutePage.$('input[aria-label="工期（分钟）"]');
  assert.ok(input);
  await input.evaluate(e => { e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '45'); e.dispatchEvent(new Event('input', {bubbles:true})); }); await minutePage.keyboard.press('Enter');
  await waitFrame(minutePage);
  await expectText(minutePage, cell('1', 'duration'), '45分钟');
  await undo(minutePage); await expectText(minutePage, cell('1', 'duration'), '75分钟');
  await minutePage.$eval('[data-status-date-handle=body]', e => e.focus());
  await minutePage.keyboard.press('ArrowRight');
  await minutePage.waitForFunction(() => document.querySelector('h1').textContent.includes('20%'));
  await undo(minutePage);
  await minutePage.waitForFunction(() => document.querySelector('h1').textContent.includes('0%'));
  await minutePage.close();
  const versionPage = await fixture('admin', false, true);
  await versionPage.click('button[title="历史版本"]');
  await versionPage.click('button[title="编辑"]');
  await versionPage.keyboard.type('改名'); await versionPage.keyboard.press('Enter');
  await versionPage.waitForSelector('[aria-label="历史版本管理确认更改"]');
  assert.deepEqual(writes, []);
  await versionPage.$eval('[aria-label="历史版本管理确认更改"] button', e => e.click());
  await button(versionPage, '取消');
  await versionPage.click('button[title="查看此版本（只读浏览，不影响工作状态）"]');
  await versionPage.waitForFunction(() => document.body.textContent.includes('恢复预览'));
  await versionPage.$eval('[data-status-date-handle=body]', e => e.focus());
  await versionPage.keyboard.press('ArrowRight');
  await versionPage.waitForFunction(() => document.querySelector('h1').textContent.includes('100%'));
  assert.deepEqual(writes, []);
  await versionPage.close();
  const viewPage = await fixture('view', false, true);
  assert.equal(await viewPage.$('button[title="创建任务"]'), null);
  await viewPage.$eval('[data-status-date-handle=body]', e => e.focus());
  await viewPage.keyboard.press('ArrowRight');
  await viewPage.waitForFunction(() => document.querySelector('h1').textContent.includes('100%'));
  assert.equal(await viewPage.$eval('input[placeholder=YYYY-MM-DD]', e => e.value), '2026-11-02');
  await viewPage.keyboard.press('Escape');
  await viewPage.waitForFunction(() => document.querySelector('h1').textContent.includes('0%'));
  assert.equal(await viewPage.$('button[title="历史版本"]'), null);
  assert.equal(await viewPage.$$eval('button', buttons => buttons.some(b => b.textContent.trim() === '+ 创建快照')), false);
  await viewPage.close();
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log('PASS minute UI and read-only access; no page errors or business API writes. Dropped native event fallbacks:', eventFallbacks);
}
main().catch(async error => { console.error(error); if (browser) { const pages = await browser.pages(); console.error('Pending browser requests:', [...(pages.at(-1)?.pendingRequests || [])]); await pages.at(-1)?.screenshot({ path: '/private/tmp/gantt-interactions-failure.png' }); } process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
