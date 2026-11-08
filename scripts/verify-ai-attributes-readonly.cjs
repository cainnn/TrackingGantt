// Explicitly named real project, read-only. No fixture creation, updates or deletes.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const base = process.argv[2], projectName = process.argv[3];
assert.ok(base && projectName, 'Usage: node scripts/verify-ai-attributes-readonly.cjs URL EXACT_PROJECT_NAME');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'gantt-ai-real-readonly-'));
const report = { base, projectName, output, mutations: [], pageErrors: [], passed: false };
let token, browser, page;
const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function read(route) {
  const response = await fetch(base + '/api' + route, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.ok(response.ok && data.ok); return data.value;
}
async function main() {
  const auth = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'admin123' }) });
  token = (await auth.json()).value.token;
  const project = (await read('/projects')).find(project => project.name === projectName); assert.ok(project, 'Exact project match required');
  const snapshot = () => Promise.all([read(`/tasks/${project.id}`), read(`/projects/${project.id}`), read(`/versions/${project.id}?list=1`), read(`/project-lines/${project.id}`)]);
  const before = await snapshot();
  assert.equal(before[0].tasks.some(task => task.custom_fields?.length || Object.keys(task.custom_values ?? {}).length), false, 'This check verifies the observed real project with no populated attributes');
  report.projectId = project.id; report.taskCount = before[0].tasks.length; report.beforeChecksum = checksum(before);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] }); page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1080 }); await page.emulateTimezone('Asia/Shanghai'); page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !['/api/auth/login', '/api/ai/chat'].includes(pathname)) {
      report.mutations.push({ pathname, method: request.method() }); return request.abort();
    }
    return request.continue();
  });
  await page.goto(base + '/login', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => { const form = document.querySelector('form'); return form && Object.keys(form).some(key => key.startsWith('__reactProps$')); });
  await page.type('input[type=text]', 'admin'); await page.type('input[type=password]', 'admin123');
  const loginButton = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '登录'));
  await loginButton.asElement().click(); await page.waitForSelector(`a[href="/projects/${project.id}"]`); await page.click(`a[href="/projects/${project.id}"]`);
  await page.waitForSelector('[data-task-row]');
  const aiButton = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'AI'));
  await aiButton.asElement().click(); await page.waitForSelector('[data-ai-chat]');
  const example = await page.evaluateHandle(() => [...document.querySelectorAll('[data-ai-chat] button')].find(button => button.textContent.includes('后3个月')));
  assert.ok(example.asElement()); report.example = await example.evaluate(button => button.textContent.trim());
  await example.asElement().click();
  assert.equal(await page.$eval('textarea[aria-label="AI消息"]', input => input.value), report.example);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/ai/chat') && response.request().method() === 'POST');
  await page.click('button[aria-label="发送AI消息"]'); const response = await responsePromise, answer = await response.json();
  assert.ok(response.ok() && answer.ok, 'Live AI must return a successful response');
  assert.ok(answer.value.message.tool_calls?.some(call => call.function.name === 'query_task_attributes'));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-message="assistant"]')].some(element => element.innerText.includes('未找到')));
  report.answer = await page.$$eval('[data-ai-message="assistant"]', elements => elements.at(-1).innerText);
  assert.doesNotMatch(report.answer, /合计\s*\d|0台/); assert.equal(await page.$('[data-ai-chat] select'), null);
  await page.screenshot({ path: path.join(output, 'real-project-text-answer.png'), fullPage: true });
  report.afterChecksum = checksum(await snapshot());
  assert.equal(report.afterChecksum, report.beforeChecksum); assert.deepEqual(report.mutations, []); assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, project: projectName, tasks: report.taskCount, mutations: 0, exampleClicked: true, noInventedStatistics: true }));
}
main().catch(async error => {
  report.error = error.message; console.error(error.message); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), passed: report.passed }));
});
