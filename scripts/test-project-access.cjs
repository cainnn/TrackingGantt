// Integration regression against a running local app. Only uniquely named test data is removed.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.ACCESS_TEST_URL || 'http://127.0.0.1:3000';
const password = `Access-${randomUUID()}`;
const suffix = Date.now().toString(36);
const users = [];
const projects = [];
let root;
let checks = 0;
let browser;

async function api(token, path, method = 'GET', body, status = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, status < 400, `${method} ${path} result`);
  checks++;
  return data.value;
}
async function login(username, pwd = password) { return api(null, '/auth/login', 'POST', { login: username, password: pwd }); }
async function newUser(label, role = 'admin') {
  const username = `access_${suffix}_${label}`;
  const user = await api(root.token, '/users', 'POST', { username, email: `${username}@example.com`, password, role }, 201);
  users.push(user);
  return { ...user, ...(await login(username)) };
}
async function newProject(session, label, extra = {}) {
  const project = await api(session.token, '/projects', 'POST', { name: `权限回归-${suffix}-${label}`, ...extra }, 201);
  projects.push(project.id);
  return project;
}
async function association(userId, projectId, linked = true) {
  return api(root.token, '/users/projects', linked ? 'POST' : 'DELETE', { userId, projectId });
}
async function readable(token, project, task) {
  for (const path of [`/projects/${project}`, `/tasks/${project}`, `/tasks/${project}/${task}`,
    `/tasks/${project}/changelog`, `/tasks/${project}/retrolog`, `/project-lines/${project}`, `/versions/${project}?list=1`]) {
    await api(token, path);
  }
}
async function denied(token, project, task) {
  for (const path of [`/projects/${project}`, `/tasks/${project}`, `/tasks/${project}/${task}`,
    `/tasks/${project}/changelog`, `/tasks/${project}/retrolog`, `/project-lines/${project}`, `/versions/${project}?list=1`,
    `/versions/${project}/diff`, `/versions/${project}/weekly-diff`]) {
    await api(token, path, 'GET', undefined, 404);
  }
  for (const [path, method, body] of [
    [`/projects/${project}`, 'PUT', { name: 'blocked' }], [`/projects/${project}`, 'DELETE', {}],
    [`/tasks/${project}`, 'POST', { name: 'blocked' }], [`/tasks/${project}`, 'PUT', { id: task, name: 'blocked' }],
    [`/tasks/${project}`, 'DELETE', { id: task }], [`/dependencies/${project}`, 'POST', {}],
    [`/dependencies/${project}`, 'PUT', {}], [`/dependencies/${project}`, 'DELETE', {}],
    [`/project-lines/${project}`, 'POST', {}], [`/project-lines/${project}`, 'PUT', {}], [`/project-lines/${project}`, 'DELETE', {}],
    [`/versions/${project}`, 'POST', {}], [`/versions/${project}`, 'PUT', {}], [`/versions/${project}`, 'DELETE', {}],
    [`/versions/${project}/restore`, 'POST', {}], [`/import/${project}`, 'POST', {}],
    [`/tasks/direct-fix/${project}`, 'POST', {}], [`/tasks/fix-project/${project}`, 'POST', {}],
    [`/tasks/reset-date/${project}`, 'POST', {}], [`/tasks/enable-auto-schedule/${project}`, 'POST', {}],
    ['/share-links', 'POST', { projectId: project }],
  ]) await api(token, path, method, body, 404);
}

async function runUi(member, project) {
  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', process.env.ACCESS_TEST_ROOT || 'root');
  await page.type('input[type="password"]', process.env.ACCESS_TEST_PASSWORD || 'root123');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === '/dashboard');
  await page.locator('button::-p-text(用户与项目)').click();
  await page.waitForSelector('#association-user-search');
  await page.type('#association-user-search', member.username);
  await page.click(`[data-user-id="${member.id}"]`);
  await page.type('input[aria-label="搜索项目"]', project.name);
  await page.waitForSelector(`[data-project-id="${project.id}"]`);
  await page.waitForFunction(() => !document.body.innerText.includes('加载项目关联中'));
  await page.evaluate(() => {
    window.__accessDrags = [];
    for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => window.__accessDrags.push({type, tag: event.target.tagName, text: event.target.textContent?.slice(0,80)}), true);
  });
  async function drag(source, target, linked) {
    await new Promise(resolve => setTimeout(resolve, 600));
    await page.waitForFunction(selector => document.querySelector(selector)?.draggable === true, {}, source);
    const from = await page.$(source);
    const to = await page.$(target);
    const box = await to.boundingBox();
    const sourceBox = await from.boundingBox();
    console.log(`DRAG ${source} -> ${target}`);
    const sourcePoint = { x: sourceBox.x + 18, y: sourceBox.y + 18 };

    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/users/projects') && r.request().method() === (linked ? 'POST' : 'DELETE')),
      (async () => {
        await page.mouse.move(sourcePoint.x, sourcePoint.y);
        await page.mouse.down();
        await page.mouse.move(sourcePoint.x + 40, sourcePoint.y + 8, { steps: 8 });
        await new Promise(resolve => setTimeout(resolve, 100));
        await page.mouse.move(box.x + box.width / 2, box.y + 32, { steps: 20 });
        await new Promise(resolve => setTimeout(resolve, 150));
        await page.mouse.move(box.x + box.width / 2 + 1, box.y + 32);
        await page.mouse.up();
      })(),
    ]);
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => !document.body.innerText.includes('正在保存关联'));
    const current = await api(root.token, '/users/projects');
    assert.equal(current.find(p => p.id === project.id).member_ids.includes(member.id), linked);
  }
  await drag(`[data-project-id="${project.id}"]`, `[data-user-id="${member.id}"]`, true);
  await drag(`[data-project-id="${project.id}"]`, '[data-association-column="unlinked"]', false);
  await drag(`[data-user-id="${member.id}"]`, `[data-project-id="${project.id}"]`, true);
  await page.screenshot({ path: '/private/tmp/gantt-project-access-desktop.png', fullPage: true });
  await page.click(`button[aria-label="移除项目 ${project.name}"]`);
  await page.waitForFunction(() => document.body.innerText.includes('已移除'));
  await page.click(`button[aria-label="关联项目 ${project.name}"]`);
  await page.waitForFunction(() => document.body.innerText.includes('已将'));
  // Responsive layout must not cause horizontal overflow.
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: '/private/tmp/gantt-project-access-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS browser: project→user, user→project, removal drop, buttons, mobile layout');
  await browser.close(); browser = null;
}

async function main() {
  root = await login(process.env.ACCESS_TEST_ROOT || 'root', process.env.ACCESS_TEST_PASSWORD || 'root123');
  assert.equal(root.user.role, 'administrator');
  if (process.argv.includes('--list-fixtures')) {
    console.log((await api(root.token, '/users')).filter(u => /^access_[a-z0-9]+_(owner|member|view)$/.test(u.username)).map(u => ({id:u.id, username:u.username})));
    return;
  }
  const cleanupPrefix = process.argv.find(arg => arg.startsWith('--cleanup-prefix='))?.split('=')[1];
  if (cleanupPrefix) {
    assert.match(cleanupPrefix, /^access_[a-z0-9]+_$/);
    const fixtures = (await api(root.token, '/users')).filter(u => u.username.startsWith(cleanupPrefix));
    const ids = new Set(fixtures.map(u => u.id));
    const fixtureProjects = (await api(root.token, '/users/projects')).filter(p => ids.has(p.user_id));
    for (const p of fixtureProjects) {
      assert.ok(p.name.startsWith('权限回归-'));
      await api(root.token, `/projects/${p.id}`, 'DELETE');
    }
    for (const u of fixtures) await api(root.token, '/users', 'DELETE', { userId: u.id });
    console.log(`Cleaned ${fixtures.length} fixture users and ${fixtureProjects.length} fixture projects`);
    return;
  }
  const owner = await newUser('owner');
  const member = await newUser('member');
  const view = await newUser('view', 'view');
  const p = await newProject(owner, 'owner');
  const q = await newProject(member, 'private');
  const t = (await api(owner.token, `/tasks/${p.id}`, 'POST', { name: '测试任务', start_date: '2026-10-17', end_date: '2026-10-18', duration: 1440 }, 201))[0];
  const foreign = (await api(member.token, `/tasks/${q.id}`, 'POST', { name: '其他项目任务' }, 201))[0];
  assert.deepEqual((await api(owner.token, '/projects')).map(p => p.id), [p.id]);
  assert.deepEqual((await api(view.token, '/projects')), []);
  await denied(member.token, p.id, t.id);
  await readable(root.token, p.id, t.id);
  await api(root.token, `/projects/${p.id}`, 'PUT', { name: p.name });
  await api(member.token, '/users', 'GET', undefined, 403);
  for (const method of ['POST', 'PUT', 'DELETE']) await api(member.token, '/users', method, {}, 403);
  for (const method of ['GET', 'POST', 'DELETE']) await api(member.token, '/users/projects', method, method === 'GET' ? undefined : { userId: member.id, projectId: p.id }, 403);
  await api(null, '/users/projects', 'GET', undefined, 401);
  await api(root.token, '/users/projects', 'POST', { userId: 'bad', projectId: p.id }, 400);
  await api(root.token, '/users/projects', 'POST', { userId: randomUUID(), projectId: p.id }, 404);
  await api(root.token, '/users/projects', 'POST', { userId: root.user.id, projectId: p.id }, 400);
  await api(root.token, '/users', 'POST', { username: 'root', email: 'root-other@example.com', password }, 400);
  await api(null, '/auth/register', 'POST', { username: 'ROOT', email: 'root-other@example.com', password }, 400);
  await association(member.id, p.id);
  await association(member.id, p.id); // idempotent; creator is still associated
  const entries = await api(root.token, '/users/projects');
  assert.deepEqual(new Set(entries.find(x => x.id === p.id).member_ids), new Set([owner.id, member.id]));
  await readable(member.token, p.id, t.id);
  await api(member.token, `/tasks/${p.id}`, 'PUT', { id: t.id, name: '已关联用户编辑' });
  await api(member.token, `/tasks/${p.id}`, 'PUT', { id: t.id, parent_id: foreign.id }, 400);
  await api(member.token, `/dependencies/${p.id}`, 'POST', { from_task_id: t.id, to_task_id: foreign.id }, 400);
  const copied = await newProject(member, 'copied', { copy_from: p.id });
  assert.equal((await api(member.token, `/tasks/${copied.id}`)).tasks.length, 1);
  await association(view.id, p.id);
  await readable(view.token, p.id, t.id);
  assert.deepEqual((await api(view.token, '/projects')).map(p => p.id), [p.id]);
  await api(view.token, `/projects/${p.id}`, 'PUT', { name: 'blocked' }, 403);
  await api(view.token, `/tasks/${p.id}`, 'POST', { name: 'blocked' }, 403);
  await api(view.token, `/projects/${q.id}`, 'GET', undefined, 404);
  const share = await api(member.token, '/share-links', 'POST', { projectId: p.id });
  const guest = await api(null, `/share-links/${share.code}`);
  await readable(guest.token, p.id, t.id);
  await api(guest.token, `/projects/${q.id}`, 'GET', undefined, 404);
  await api(guest.token, '/projects', 'GET', undefined, 403);
  await api(guest.token, '/users/projects', 'GET', undefined, 403);
  await api(guest.token, '/users/projects', 'POST', { userId: member.id, projectId: p.id }, 403);
  await association(owner.id, p.id, false); // creator loses access using their existing token
  await denied(owner.token, p.id, t.id);
  assert.deepEqual(await api(owner.token, '/projects'), []);
  // Repeating the migration must preserve the revoked creator membership and root password.
  require('@next/env').loadEnvConfig(process.cwd());
  const { Pool } = require('pg');
  const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'gantt_app', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || '' });
  try {
    const before = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [root.user.id])).rows[0].password_hash;
    await pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'migrate-project-memberships.sql'), 'utf8'));
    assert.equal((await pool.query('SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2', [p.id, owner.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE id = $1', [root.user.id])).rows[0].password_hash, before);
  } finally { await pool.end(); }
  await api(root.token, '/users', 'DELETE', { userId: owner.id }, 409);
  await api(root.token, `/projects/${p.id}`);
  await association(member.id, p.id, false);
  await association(member.id, p.id, false);
  await denied(member.token, p.id, t.id);
  await association(view.id, p.id, false);
  await api(view.token, `/projects/${p.id}`, 'GET', undefined, 404);
  // Deleted users cannot use an old token to create new projects or manage access.
  await api(root.token, '/users', 'DELETE', { userId: view.id });
  users.splice(users.findIndex(u => u.id === view.id), 1);
  await api(view.token, '/projects', 'GET', undefined, 401);
  console.log(`PASS API and migration: ${checks} assertions across creation, grant, revoke, read-only, share scope, cross-project IDs, deleted sessions, and repeat migration`);
  if (process.argv.includes('--ui')) await runUi(member, p);
}

main().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (browser) {
    const pages = await browser.pages();
    const page = pages[pages.length - 1];
    await page.screenshot({path:'/private/tmp/gantt-project-access-failure.png',fullPage:true});
    console.log('Drag events:', await page.evaluate(() => window.__accessDrags));
  }
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (root) {
    for (const id of projects.reverse()) await api(root.token, `/projects/${id}`, 'DELETE').catch(error => { console.error('Test project cleanup failed:', error.message); process.exitCode = 1; });
    for (const user of users.reverse()) await api(root.token, '/users', 'DELETE', { userId: user.id }).catch(error => { console.error('Test user cleanup failed:', error.message); process.exitCode = 1; });
  }
});
