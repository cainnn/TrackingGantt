// Integration regression against a running app. Only this run's uniquely named projects are removed.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.SAVE_TEST_URL || 'http://127.0.0.1:3107';
const rootLogin = process.env.SAVE_TEST_ROOT || 'root';
const rootPassword = process.env.SAVE_TEST_PASSWORD || 'root123';
const prefix = `保存回归-${randomUUID().slice(0, 8)}-`;
const projects = [];
let token, browser;

async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, expected < 400);
  return data.value;
}
async function project(label) {
  const p = await api('/projects', 'POST', {
    name: `${prefix}${label}`, start_date: '2026-10-01',
    status_date: '2026-10-19T00:00:00', time_granularity: 'day',
  }, 201);
  projects.push(p.id);
  return p;
}
function task(name, index = 0) {
  return {
    id: randomUUID(), task_code: String(index + 1), name,
    start_date: '2026-10-19T00:00:00', end_date: '2026-10-20T00:00:00',
    duration: 1440, auto_schedule: true, constraint_type: 'asap', order_index: index,
  };
}
async function seedVersion(p) {
  await api(`/versions/${p.id}`, 'POST', { use_database_snapshot: true, status_date: p.status_date }, 201);
}
async function taskState(p) { return api(`/tasks/${p.id}`); }
async function eventually(fn, label) {
  const started = Date.now();
  while (!(await fn())) {
    assert.ok(Date.now() - started < 20000, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function button(page, text) {
  const handle = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text), text);
  assert.ok(handle.asElement(), `button ${text}`);
  assert.equal(await handle.evaluate(b => b.disabled), false, `${text} must be enabled`);
  await handle.asElement().click();
  await handle.dispose();
}
async function reviewAndSave(page) {
  await button(page, '确认变更');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认并保存'));
  for (const input of await page.$$('textarea')) await input.type('保存回归测试');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认并保存' && !b.disabled));
  await button(page, '确认并保存');
}
async function finishSave(page, p) {
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === `/api/versions/${p.id}` && r.request().method() === 'POST' && r.status() === 201),
    reviewAndSave(page),
  ]);
  const saved = (await response.json()).value;
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存中...'));
  return saved;
}
async function navigateProject(page, p) {
  await page.waitForSelector(`a[href="/projects/${p.id}"]`);
  await page.click(`a[href="/projects/${p.id}"]`);
  await page.waitForSelector('button[title="创建任务"]');
  await page.waitForNetworkIdle({ idleTime: 600 });
}
async function renameTask(page, oldName, newName) {
  const handle = await page.evaluateHandle(name => [...document.querySelectorAll('span')].find(e => e.textContent.trim() === name), oldName);
  assert.ok(handle.asElement(), `task ${oldName}`);
  await handle.asElement().click({ clickCount: 2 });
  await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.type(newName);
  await page.keyboard.press('Enter');
  await handle.dispose();
}
async function saveButtonEnabled(page) {
  return page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认变更' && !b.disabled));
}
async function deleteSelected(page) { await page.click('button[title="删除选中任务"]'); }

async function main() {
  console.log('Test fixture prefix:', prefix);
  token = (await api('/auth/login', 'POST', { login: rootLogin, password: rootPassword })).token;
  const p = await project('API');
  const a = task('API-A'), b = task('API-B', 1);
  await Promise.all([api(`/tasks/${p.id}`, 'POST', [a, b], 201), api(`/tasks/${p.id}`, 'POST', [a, b], 201)]);
  const repeated = await api(`/tasks/${p.id}`, 'POST', [a, b], 201);
  assert.deepEqual(repeated.map(t => t.id), [a.id, b.id]);
  assert.equal((await taskState(p)).tasks.length, 2);
  assert.equal((await api(`/tasks/${p.id}/${a.id}`)).lifecycle.filter(e => e.event_type === 'created').length, 1);
  const dep = { id: randomUUID(), from_task_id: a.id, to_task_id: b.id, type: 2, lag: 0, active: true };
  const concurrent = await Promise.all([api(`/dependencies/${p.id}`, 'POST', dep, 201), api(`/dependencies/${p.id}`, 'POST', dep, 201)]);
  assert.ok(concurrent.every(r => r.dependency.id === dep.id));
  assert.equal((await taskState(p)).dependencies.length, 1);
  assert.equal((await api(`/tasks/${p.id}/${b.id}`)).lifecycle.filter(e => e.event_type === 'dep_added').length, 1);
  const foreign = await project('ID隔离');
  await api(`/tasks/${foreign.id}`, 'POST', a, 409);
  await api(`/dependencies/${foreign.id}`, 'POST', dep, 409);
  await api(`/dependencies/${p.id}`, 'POST', { ...dep, from_task_id: b.id, to_task_id: a.id }, 409);
  assert.equal((await taskState(foreign)).tasks.length, 0);
  assert.equal((await api(`/projects/${p.id}`, 'PUT', { name: `${p.name}-renamed` })).status_date, p.status_date);
  assert.equal((await api(`/projects/${p.id}`, 'PUT', { start_date: '2026-10-02' })).status_date, p.status_date);
  assert.equal((await api(`/projects/${p.id}`, 'PUT', { status_date: null })).status_date, null);
  console.log('PASS API: replay/concurrent create, single lifecycle event, project ID isolation, and status date preservation/explicit clearing');
  if (process.argv.includes('--api-only')) return;

  const empty = await project('空项目');
  const retry = await project('响应丢失');
  const retryDelete = await project('失败后删除');
  const snapshot = await project('快照断网');
  const editing = await project('并发编辑');
  const snapshotTask = task('Snapshot-before');
  const editingTask = task('Concurrent-before');
  await api(`/tasks/${retry.id}`, 'POST', task('Retry-existing'), 201);
  await api(`/tasks/${snapshot.id}`, 'POST', snapshotTask, 201);
  await api(`/tasks/${editing.id}`, 'POST', editingTask, 201);
  for (const p of [empty, retry, retryDelete, snapshot, editing]) await seedVersion(p);

  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.setViewport({ width: 1500, height: 1050 });
  const dialogs = [], errors = [], interceptionErrors = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return form && Object.keys(form).some(k => k.startsWith('__reactProps$'));
  });
  await page.type('input[type="text"]', rootLogin);
  await page.type('input[type="password"]', rootPassword);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === '/dashboard');

  let mode, lostProjectId, createdId, heldRequest;
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    try {
      if (mode === 'lose-create-reply' && request.method() === 'POST' && url.pathname === `/api/tasks/${lostProjectId}`) {
        mode = null;
        createdId = JSON.parse(request.postData())[0].id;
        const response = await fetch(request.url(), {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: request.postData(),
        });
        assert.equal(response.status, 201, await response.text());
        await request.abort('failed');
      } else if (mode === 'stale-recovery-read' && request.method() === 'GET' && url.pathname === `/api/tasks/${retry.id}`) {
        mode = null;
        // Model a recovery read arriving before the previous create commits.
        const state = await taskState(retry);
        state.tasks = state.tasks.filter(t => t.id !== createdId);
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: state }) });
      } else if (mode?.startsWith('snapshot-') && request.method() === 'POST' && url.pathname === `/api/versions/${snapshot.id}`) {
        const failure = mode; mode = null;
        if (failure === 'snapshot-offline') await request.abort('internetdisconnected');
        else await request.respond({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
      } else if (mode === 'hold-version' && request.method() === 'GET' && url.pathname === `/api/versions/${editing.id}` && url.searchParams.has('id')) {
        mode = null; heldRequest = request;
      } else await request.continue();
    } catch (error) {
      interceptionErrors.push(error.message);
      if (!request.isInterceptResolutionHandled()) await request.abort();
    }
  });

  await navigateProject(page, empty);
  await page.click('button[title="创建任务"]');
  assert.equal(await saveButtonEnabled(page), true);
  await finishSave(page, empty);
  assert.equal((await taskState(empty)).tasks.length, 1);
  if (!(await page.$eval('input[type="checkbox"]', input => input.checked))) await page.click('input[type="checkbox"]');
  await deleteSelected(page);
  await finishSave(page, empty);
  assert.equal((await taskState(empty)).tasks.length, 0);
  assert.equal(await saveButtonEnabled(page), false);
  console.log('PASS browser: save the first task, then save deletion of all tasks');

  await page.click('a[href="/dashboard"]');
  await navigateProject(page, retry);
  await page.click('button[title="创建任务"]');
  lostProjectId = retry.id; mode = 'lose-create-reply';
  let dialogCount = dialogs.length;
  await reviewAndSave(page);
  await eventually(() => dialogs.length > dialogCount, 'lost response alert');
  assert.equal((await taskState(retry)).tasks.filter(t => t.id === createdId).length, 1);
  await renameTask(page, 'New Task', 'Edited after failure');
  mode = 'stale-recovery-read';
  await finishSave(page, retry);
  assert.equal((await taskState(retry)).tasks.find(t => t.id === createdId).name, 'Edited after failure');
  assert.equal((await api(`/tasks/${retry.id}/${createdId}`)).lifecycle.filter(e => e.event_type === 'created').length, 1);
  assert.equal(await saveButtonEnabled(page), false);
  console.log('PASS browser: a committed create with a lost response can be edited and retried without duplicate data/history');

  await page.click('a[href="/dashboard"]');
  await navigateProject(page, retryDelete);
  await page.click('button[title="创建任务"]');
  lostProjectId = retryDelete.id; mode = 'lose-create-reply';
  dialogCount = dialogs.length;
  await reviewAndSave(page);
  await eventually(() => dialogs.length > dialogCount, 'lost response before local delete');
  await deleteSelected(page);
  await finishSave(page, retryDelete);
  assert.equal((await taskState(retryDelete)).tasks.length, 0);
  console.log('PASS browser: deleting a newly created task after a failed save leaves no orphan when retried');

  await page.click('a[href="/dashboard"]');
  await navigateProject(page, snapshot);
  await renameTask(page, 'Snapshot-before', 'Snapshot-renamed');
  for (const failure of ['snapshot-offline', 'snapshot-invalid-json']) {
    mode = failure; dialogCount = dialogs.length;
    await reviewAndSave(page);
    await eventually(() => dialogs.length > dialogCount, 'snapshot failure alert');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '确认变更' && !b.disabled));
    assert.equal(await saveButtonEnabled(page), true);
    assert.equal((await taskState(snapshot)).tasks.find(t => t.id === snapshotTask.id).name, 'Snapshot-renamed');
  }
  const savedSnapshot = await finishSave(page, snapshot);
  assert.equal(savedSnapshot.snapshot.tasks.find(t => t.id === snapshotTask.id).name, 'Snapshot-renamed');
  assert.equal(await saveButtonEnabled(page), false);
  console.log('PASS browser: snapshot network/JSON errors release saving state and a later retry succeeds');

  await page.click('a[href="/dashboard"]');
  await navigateProject(page, editing);
  await renameTask(page, 'Concurrent-before', 'Concurrent-submitted');
  mode = 'hold-version';
  await reviewAndSave(page);
  await eventually(() => !!heldRequest, 'held previous-version read');
  await renameTask(page, 'Concurrent-submitted', 'Concurrent-newer-local');
  const firstResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/versions/${editing.id}` && r.request().method() === 'POST');
  await heldRequest.continue(); heldRequest = null;
  await firstResponse;
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '保存中...'));
  assert.equal((await taskState(editing)).tasks.find(t => t.id === editingTask.id).name, 'Concurrent-submitted');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('span')].some(e => e.textContent.trim() === 'Concurrent-newer-local')));
  assert.equal(await saveButtonEnabled(page), true);
  const finalSnapshot = await finishSave(page, editing);
  assert.equal((await taskState(editing)).tasks.find(t => t.id === editingTask.id).name, 'Concurrent-newer-local');
  assert.equal(finalSnapshot.snapshot.tasks.find(t => t.id === editingTask.id).name, 'Concurrent-newer-local');
  assert.equal(await saveButtonEnabled(page), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(interceptionErrors, []);
  console.log('PASS browser: edits during save preparation stay visible and pending; next save persists them in the database and snapshot');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  for (const id of projects.reverse()) {
    try {
      const p = await api(`/projects/${id}`);
      assert.ok(p.name.startsWith(prefix));
      await api(`/projects/${id}`, 'DELETE');
    } catch (error) { console.error('Test project cleanup failed:', id, error.message); process.exitCode = 1; }
  }
  if (projects.length) console.log(`Cleaned ${projects.length} test projects`);
});
