// Isolated browser + disposable project. --stub-ai is explicitly local UI-only;
// omit it to exercise the live provider, endpoint, tool call and browser calculation.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2] || 'http://127.0.0.1:3117', stubAi = process.argv.includes('--stub-ai');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-ai-attributes-ui-'));
const report = { base, output, aiMode: stubAi ? 'stub-ui-only' : 'real-provider', steps: [], aiRequests: [], writes: [], pageErrors: [], passed: false };
const modal = '[role="dialog"][aria-label="编辑任务"]';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1;
const firstEnd = new Date(Date.UTC(year, month + 2, 0)).toISOString().slice(0, 10);
const secondEnd = new Date(Date.UTC(year, month + 3, 0)).toISOString().slice(0, 10);
const futureEnd = new Date(Date.UTC(year, month + 4, 0)).toISOString().slice(0, 10);
const firstMonth = firstEnd.slice(0, 7), secondMonth = secondEnd.slice(0, 7), firstStart = `${firstMonth}-01`;
let token, project, browser, page;
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-gantt-confirmed-save': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(response.ok && data.ok, `${method} ${route}: ${JSON.stringify(data)}`); return data.value;
}
function pass(message) { report.steps.push(message); console.log(`PASS ${message}`); }
async function click(label, scope = 'body') {
  const handle = await page.evaluateHandle(({ label, scope }) => [...document.querySelectorAll(`${scope} button`)]
    .find(button => (button.textContent.trim() === label || button.getAttribute('aria-label') === label) && button.getClientRects().length), { label, scope });
  assert.ok(handle.asElement(), `Missing visible button: ${label}`); assert.equal(await handle.evaluate(button => button.disabled), false);
  await handle.asElement().click({ delay: 50 }); await handle.dispose();
}
async function fill(selector, value) {
  await page.click(selector, { count: 3 }); await page.keyboard.press('Backspace'); await page.type(selector, value);
}
async function ask(text, total) {
  const count = (await page.$$('[data-ai-attribute-report]')).length;
  await fill('textarea[aria-label="AI消息"]', text);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ai/chat') && response.request().method() === 'POST');
  await click('发送AI消息');
  const response = await responsePromise, data = await response.json();
  assert.ok(response.ok() && data.ok, `AI response: ${JSON.stringify(data)}`);
  assert.ok(data.value.message.tool_calls?.some(call => call.function.name === 'query_task_attributes'), 'Must use the attribute query tool');
  if (total == null) {
    await page.waitForFunction(() => document.querySelector('[data-ai-chat]').textContent.includes('未找到「不存在指标」'));
    assert.equal((await page.$$('[data-ai-attribute-report]')).length, count); return;
  }
  await page.waitForFunction(count => document.querySelectorAll('[data-ai-attribute-report]').length === count + 1, {}, count);
  const handle = (await page.$$('[data-ai-attribute-report]')).at(-1);
  assert.equal(await handle.$eval('[data-ai-total]', element => element.dataset.aiTotal), total);
  return handle;
}
async function main() {
  token = (await api('/auth/login', 'POST', { login: 'admin', password: 'admin123' })).token;
  project = await api('/projects', 'POST', { name: `AI属性验收-${randomUUID().slice(0, 8)}`, start_date: '2025-12-01', status_date: '2026-01-15', planning_status: 'draft', time_granularity: 'day', use_template: false });
  const tasks = Array.from({ length: 240 }, (_, index) => {
    const id = randomUUID(), metric = randomUUID();
    return { id, name: `搬迁批次${index + 1}`, task_code: String(index + 1), parent_id: null, order_index: index, assignee: '验收人员',
      start_date: '2025-12-01', end_date: index < 120 ? firstEnd : secondEnd, duration: (Date.parse(index < 120 ? firstEnd : secondEnd) - Date.parse('2025-12-01')) / 60000, auto_schedule: false,
      custom_fields: [{ id: metric, name: '搬迁服务器台数', type: 'number', unit: '台' }], custom_values: { [metric]: index === 239 ? '1000' : '2' } };
  });
  for (const [index, value] of [[0, '999999999999999999.99'], [1, '0.02']]) {
    const id = randomUUID(); tasks[index].custom_fields.push({ id, name: '支出金额', type: 'money', unit: '元' }); tasks[index].custom_values[id] = value;
  }
  await api(`/tasks/${project.id}`, 'POST', tasks);
  const before = await api(`/tasks/${project.id}`), beforeProject = await api(`/projects/${project.id}`);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1920, height: 1080 }); await page.emulateTimezone('Asia/Shanghai');
  page.setDefaultTimeout(90000); page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', async dialog => { report.pageErrors.push(dialog.message()); await dialog.accept(); });
  await page.evaluateOnNewDocument(() => { window.__trustedClicks = 0; document.addEventListener('click', event => { if (event.isTrusted) window.__trustedClicks++; }, true); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/ai/chat' && request.method() === 'POST') {
      const body = JSON.parse(request.postData()), text = [...body.messages].reverse().find(message => message.role === 'user').content;
      report.aiRequests.push({ prompt: text, tasks: body.tasks.length, queryOnly: body.queryOnly });
      if (stubAi) {
        const args = { attribute_name: text.includes('不存在指标') ? '不存在指标' : text.includes('支出金额') ? '支出金额' : '搬迁服务器台数', operation: 'sum', group_by: 'month', date_field: 'end_date',
          ...(text.includes('只看') ? { from_date: firstStart, to_date: firstEnd, group_by: 'none' } : {}) };
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: { message: { role: 'assistant', content: null,
          tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'query_task_attributes', arguments: JSON.stringify(args) } }] } } }) });
      }
      return request.continue();
    }
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/auth/login') {
      report.writes.push({ path: pathname, method: request.method() }); report.pageErrors.push('Unexpected mutation during read-only AI query'); return request.abort();
    }
    return request.continue();
  });
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => { const form = document.querySelector('form'); return form && Object.keys(form).some(key => key.startsWith('__reactProps$')); });
  await page.type('input[type=text]', 'admin'); await page.type('input[type=password]', 'admin123'); await click('登录');
  await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`); await page.waitForSelector('[data-task-row]');
  const statusLine = await page.$eval('[data-status-date-handle="body"]', element => element.getAttribute('aria-valuetext'));
  await click('AI'); await page.waitForSelector('[data-ai-chat]');
  assert.equal(await page.$('[data-ai-chat] select'), null, 'No range picker required');
  assert.ok(await page.$eval('[data-ai-chat]', element => [...element.querySelectorAll('button')].some(button => button.textContent.includes('后3个月'))));
  let result = await ask('按结束日期统计每月搬迁服务器台数，覆盖全部计划', '1478');
  assert.deepEqual(await result.$$eval('[data-ai-group]', rows => rows.map(row => [row.dataset.aiGroup, row.querySelector('[data-ai-value]').dataset.aiValue])), [[firstMonth, '240'], [secondMonth, '1238']]);
  assert.ok(await result.evaluate(element => element.textContent.includes('任务结束日期') && element.textContent.includes('全部 240 项')));
  await page.screenshot({ path: path.join(output, 'monthly-totals.png'), fullPage: true });
  pass('自然语言按结束日期分月统计全部 240 项，跨月整笔计入，汇总包含第 200 项之后的数据');
  result = await ask(`只看${firstMonth.slice(0, 4)}年${Number(firstMonth.slice(5))}月搬迁服务器台数的合计`, '240');
  assert.ok(await result.evaluate((element, range) => element.textContent.includes(range.from) && element.textContent.includes(range.to), { from: firstStart, to: firstEnd }));
  pass('指定月份按自然月过滤，统计口径在结果中可见');
  await ask('那后3个月呢？请直接用文字回答。', '1478');
  const answer = await page.$$eval('[data-ai-message="assistant"]', messages => messages.at(-1).innerText);
  assert.ok(answer.includes(`${firstStart}至${futureEnd}`)); assert.ok(answer.includes('合计1478台'));
  assert.ok(answer.includes(`${firstMonth.slice(0, 4)}年${Number(firstMonth.slice(5))}月：240台`));
  assert.doesNotMatch(answer, /请选择|请指定|确认统计/);
  await page.screenshot({ path: path.join(output, 'future-three-months-text.png'), fullPage: true });
  pass('追问后3个月自动识别属性和范围，直接以文字给出各月数量、合计和日期，不要求选择或确认');
  await ask('按结束日期统计每月支出金额，覆盖全部计划', '1000000000000000000.01');
  await page.screenshot({ path: path.join(output, 'exact-money.png'), fullPage: true });
  pass('大额金额以精确小数汇总，不丢失分位');

  await page.click(`[data-task-cell="${tasks[0].id}"][data-col="name"]`); await page.click('button[title="编辑任务"]'); await page.waitForSelector(modal);
  await click('编辑属性', modal); await fill(`${modal} input[aria-label="搬迁服务器台数"]`, '5'); await click('保存', modal); await page.waitForSelector(modal, { hidden: true });
  result = await ask('按结束日期统计每月搬迁服务器台数，覆盖全部计划', '1481');
  assert.ok(await result.evaluate(element => element.textContent.includes('包含尚未保存的修改')));
  assert.equal(await page.$eval('[data-action="save-plan"]', button => button.disabled), false);
  await page.screenshot({ path: path.join(output, 'unsaved-statistics.png'), fullPage: true });
  await page.click('button[title^="撤销"]');
  assert.equal(await page.$eval('[data-action="save-plan"]', button => button.disabled), true);
  pass('编辑属性但未保存时，AI 统计使用前端当前值并标注；查询不产生撤销步骤，原编辑可一步撤销');
  await ask('统计自定义属性“ 不存在指标 ”的每月合计', null);
  pass('不存在的属性提示未找到，不编造零值或合计');
  assert.ok(report.aiRequests.every(request => request.tasks === 240 && request.queryOnly === true));
  assert.deepEqual(report.writes, []); assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(await api(`/tasks/${project.id}`), before); assert.deepEqual(await api(`/projects/${project.id}`), beforeProject);
  assert.deepEqual(await api(`/versions/${project.id}?list=1`), []);
  assert.equal(await page.$eval('[data-status-date-handle="body"]', element => element.getAttribute('aria-valuetext')), statusLine);
  pass('全部查询零任务写入、零版本，数据库与状态日期线保持原样');
  report.trustedClicks = await page.evaluate(() => window.__trustedClicks); report.passed = true;
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
  console.log(JSON.stringify({ passed: report.passed, aiMode: report.aiMode, steps: report.steps.length, cleaned: report.fixtureCleaned, report: path.join(output, 'report.json') }));
});
