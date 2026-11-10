// Synthetic plan/auth responses, real configured AI endpoint, actual browser UI.
// No project/task mutations reach any database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3127';
const aiBase = process.env.AI_HIERARCHY_PROVIDER_URL || 'http://159.75.40.209:3000';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-ai-hierarchy-'));
const project = { id: 'ai-hierarchy-fixture', name: 'AI父子统计验收', user_id: 'fixture', start_date: '2026-01-01', status_date: '2026-01-15', time_granularity: 'day', planning_status: 'draft' };
const task = (id, value, parent_id = null) => ({ id, project_id: project.id, parent_id, task_code: id, name: `任务${id}`, assignee: null,
  start_date: '2026-01-01', end_date: '2026-01-31', duration: 43200, duration_unit: 'minute', percent_done: 0, auto_schedule: false,
  is_milestone: false, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '', note: null,
  custom_fields: [{ id: `field-${id}`, name: '搬迁服务器台数', type: 'number', unit: '台' }], custom_values: { [`field-${id}`]: value } });
const tasks = [task('1', '30'), task('2', '30', '1'), task('3', '10', '2'), task('4', '20', '2'), task('5', '5')];
const report = { passed: false, aiMode: 'real-provider', databaseWrites: [], pageErrors: [], cases: [], eventFallbacks: 0, output };
let browser, page;
async function click(label) {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(button =>
    (button.textContent.trim() === label || button.getAttribute('aria-label') === label) && button.getClientRects().length), label);
  assert.ok(handle.asElement(), label); assert.equal(await handle.evaluate(button => button.disabled), false);
  await clickElement(handle);
}
async function clickSelector(selector) {
  const handle = await page.$(selector); assert.ok(handle, selector); await clickElement(handle);
}
async function clickElement(handle) {
  await page.evaluate(() => { window.__clickProbeCount = 0; window.__clickProbe = () => window.__clickProbeCount++; document.addEventListener('click', window.__clickProbe, true); });
  await handle.asElement().click({ delay: 50 });
  const delivered = await page.evaluate(() => { document.removeEventListener('click', window.__clickProbe, true); return window.__clickProbeCount; });
  // macOS headless sessions occasionally drop CDP clicks before they reach the
  // document. Use the real event handler only when no native click was delivered.
  if (!delivered) { report.eventFallbacks++; await handle.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))); }
  await handle.dispose();
}
async function ask(prompt, expected) {
  const previous = await page.$$eval('[data-ai-message="assistant"]', messages => messages.length);
  await page.type('textarea[aria-label="AI消息"]', prompt);
  await click('发送AI消息');
  await page.waitForFunction(previous => document.querySelectorAll('[data-ai-message="assistant"]').length > previous, {}, previous);
  const message = (await page.$$('[data-ai-message="assistant"]')).at(-1);
  const totals = await message.$$eval('[data-ai-total]', values => values.map(value => value.dataset.aiTotal).sort());
  const text = await message.evaluate(element => element.innerText);
  assert.deepEqual(totals, [...expected].sort(), `${prompt}: ${text}`);
  assert.doesNotMatch(text, /合计(?:60|65|95)台/);
  assert.equal(await page.$eval('[data-action="save-plan"]', button => button.disabled), true);
  report.cases.push({ prompt, totals, answer: text });
  console.log(`PASS ${prompt}: ${totals.some(Boolean) ? `${totals.join(' / ')}台` : '暂无已填记录'}`);
  return text;
}
async function main() {
  const login = await fetch(aiBase + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: process.env.AI_HIERARCHY_USER || 'admin', password: process.env.AI_HIERARCHY_PASSWORD || 'admin123' }), signal: AbortSignal.timeout(30000) });
  const auth = await login.json(); assert.ok(login.ok && auth.ok); const providerToken = auth.value.token;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('Asia/Shanghai'); page.setDefaultTimeout(90000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return request.continue();
    try {
      let value = [];
      if (pathname === '/api/auth/login') value = { user: { id: 'fixture', username: 'fixture', role: 'admin' }, token: 'fixture-token' };
      else if (pathname === '/api/ai/chat') {
        const response = await fetch(aiBase + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerToken}` }, body: request.postData(), signal: AbortSignal.timeout(90000) });
        return request.respond({ status: response.status, contentType: 'application/json', body: await response.text() });
      } else if (request.method() !== 'GET') { report.databaseWrites.push({ pathname, method: request.method() }); return request.abort(); }
      else if (pathname === '/api/projects') value = [project];
      else if (pathname === `/api/projects/${project.id}`) value = project;
      else if (pathname === `/api/tasks/${project.id}`) value = { tasks, dependencies: [] };
      else if (pathname.endsWith('/view-preferences')) value = { revision: 0, currentView: null, views: [] };
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
    } catch (error) { report.pageErrors.push(error.message); return request.abort(); }
  });
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.type('input[type="text"]', 'fixture'); await page.type('input[type="password"]', 'fixture'); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await clickSelector(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector('[data-task-row]'); await click('AI'); await page.waitForSelector('[data-ai-chat]');
  await ask('汇总全部计划的搬迁服务器台数，父子不要重复统计', ['35']);
  await ask('只汇总父任务的搬迁服务器台数，不计子任务，覆盖全部计划', ['30', '30']);
  await ask('父任务和子任务的搬迁服务器台数分别汇总，不要把父子相加，覆盖全部计划', ['30', '30', '35']);
  await page.screenshot({ path: path.join(output, 'parent-child-separate.png'), fullPage: true });
  for (const row of tasks.filter(row => ['3', '4', '5'].includes(row.id))) row.custom_values = {};
  await clickSelector('a[href="/dashboard"]'); await page.waitForSelector(`a[href="/projects/${project.id}"]`);
  await clickSelector(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
  if (!await page.$('[data-ai-chat]')) await click('AI');
  await page.waitForSelector('[data-ai-chat]');
  const unreported = await ask('汇总全部计划的搬迁服务器台数，只看子任务，不从父任务和任务名称补数', ['']);
  assert.match(unreported, /没有符合条件的已填记录/); assert.doesNotMatch(unreported, /合计0台|合计30台|合计60台/);
  await page.screenshot({ path: path.join(output, 'children-unreported.png'), fullPage: true });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1;
  const first = `${today.slice(0, 7)}-01`, last = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  const previousEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const installTask = (id, name, value, parent = null, end = last) => ({ ...task(id, value, parent), name, start_date: end < first ? `${end.slice(0, 7)}-01` : first, end_date: end,
    custom_fields: [{ id: `field-${id}`, name: '设备台数', type: 'number', unit: '台' }], custom_values: value == null ? {} : { [`field-${id}`]: value } });
  tasks.splice(0, tasks.length, installTask('i-parent', '服务器安装', '7'), installTask('i-a', '设备上架', '2', 'i-parent'),
    installTask('i-b', '服务器B安装', '5', 'i-parent'), installTask('i-switch', '安装交换机', '40', 'i-parent'),
    installTask('i-move', '搬迁服务器', '100', 'i-parent'), installTask('i-empty', '安装服务器（未填报）', undefined, 'i-parent'),
    installTask('i-zero', '安装服务器（填报0）', '0', 'i-parent'), installTask('i-old', '安装服务器（上月）', '200', null, previousEnd));
  await clickSelector('a[href="/dashboard"]'); await page.waitForSelector(`a[href="/projects/${project.id}"]`);
  await clickSelector(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
  if (!await page.$('[data-ai-chat]')) await click('AI');
  await page.waitForSelector('[data-ai-chat]');
  const installation = await ask('本月安装多少台服务器', ['7']);
  assert.ok(installation.includes(first) && installation.includes(last), 'Natural current-month range is visible');
  assert.match(installation, /设备台数/); assert.match(installation, /「安装」、「服务器」/); assert.match(installation, /未填属性1项/);
  const answer = (await page.$$('[data-ai-message="assistant"]')).at(-1);
  await clickElement(await answer.$('details > summary'));
  await clickElement(await answer.$('[data-ai-attribute-report] details > summary'));
  const rows = await answer.$$eval('[data-ai-attribute-report] details tbody tr', rows => rows.map(row => row.textContent));
  assert.equal(rows.length, 3); assert.ok(rows.some(row => row.includes('服务器安装 / 设备上架') && row.endsWith('2')));
  assert.ok(rows.some(row => row.includes('服务器B安装') && row.endsWith('5')));
  assert.ok(rows.some(row => row.includes('填报0') && row.endsWith('0')));
  assert.ok(rows.every(row => !/交换机|搬迁|上月/.test(row)), 'Only current-month installation server values appear');
  await page.screenshot({ path: path.join(output, 'this-month-installation-attributes.png'), fullPage: true });
  assert.deepEqual(report.databaseWrites, []); assert.deepEqual(report.pageErrors, []); report.passed = true;
}
main().catch(async error => {
  report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, report: path.join(output, 'report.json') }));
});
