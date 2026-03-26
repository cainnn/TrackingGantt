/**
 * 生成源程序前30页和后30页的 PDF
 * 每页约 50 行代码（A4 打印标准）
 */

const fs = require('fs');
const path = require('path');

const LINES_PER_PAGE = 50;
const PAGES_COUNT = 30;
const EXCLUDE_DIRS = ['node_modules', '.next', 'public'];
const SOURCE_EXT = ['.ts', '.tsx', '.css', '.mjs'];

// 收集源文件（按路径排序）
function collectSourceFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    const relPath = path.relative(baseDir, fullPath);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.some(d => relPath.includes(d))) {
        files.push(...collectSourceFiles(fullPath, baseDir));
      }
    } else if (SOURCE_EXT.some(ext => e.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

// 转义 HTML
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 生成带行号的代码 HTML
function buildCodeHtml(files, startLine, endLine) {
  let html = '';
  let globalLine = 0;
  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    html += `<div class="file-header">// ${escapeHtml(relPath)}</div>\n`;
    for (let i = 0; i < lines.length; i++) {
      globalLine++;
      if (globalLine < startLine) continue;
      if (globalLine > endLine) return html;
      const num = String(globalLine).padStart(5);
      html += `<div class="line"><span class="ln">${num}</span> <span class="code">${escapeHtml(lines[i]) || ' '}</span></div>\n`;
    }
    html += '<div class="file-sep"></div>\n';
  }
  return html;
}

// 生成完整 HTML 文档
function buildHtmlDoc(title, content) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Consolas', 'Monaco', monospace; font-size: 10pt; line-height: 1.35; padding: 15mm; }
    .page { page-break-after: always; min-height: 277mm; }
    .page:last-child { page-break-after: auto; }
    .file-header { color: #0066cc; font-weight: bold; margin: 8px 0 4px 0; padding: 4px 0; border-bottom: 1px solid #ccc; }
    .file-sep { height: 12px; }
    .line { white-space: pre; }
    .ln { color: #999; margin-right: 12px; user-select: none; display: inline-block; width: 50px; text-align: right; }
    .code { color: #333; }
    @media print {
      body { padding: 0; }
      .page { min-height: 0; padding: 12mm; }
    }
  </style>
</head>
<body>
${content}
</body>
</html>`;
}

async function main() {
  const rootDir = path.join(__dirname, '..');
  process.chdir(rootDir);

  const files = collectSourceFiles(rootDir);
  const totalLines = files.reduce((sum, f) => {
    return sum + fs.readFileSync(f, 'utf8').split('\n').length;
  }, 0);

  const totalPages = Math.ceil(totalLines / LINES_PER_PAGE);
  console.log(`总行数: ${totalLines}, 总页数: 约 ${totalPages}`);

  const linesFirst30 = PAGES_COUNT * LINES_PER_PAGE;  // 1500
  const linesLast30 = PAGES_COUNT * LINES_PER_PAGE;   // 1500
  const startLast30 = Math.max(1, totalLines - linesLast30 + 1);

  // 前30页（第1行 到 第1500行）
  const pagesFirst = [];
  for (let p = 0; p < PAGES_COUNT; p++) {
    const start = p * LINES_PER_PAGE + 1;
    const end = Math.min((p + 1) * LINES_PER_PAGE, linesFirst30);
    if (start > totalLines) break;
    pagesFirst.push(`<div class="page">${buildCodeHtml(files, start, end)}</div>`);
  }
  const htmlFirst = buildHtmlDoc('源程序 - 前30页', pagesFirst.join('\n'));

  // 后30页（从倒数第1500行到结尾）
  const pagesLast = [];
  for (let p = 0; p < PAGES_COUNT; p++) {
    const start = startLast30 + p * LINES_PER_PAGE;
    const end = Math.min(startLast30 + (p + 1) * LINES_PER_PAGE - 1, totalLines);
    if (start > totalLines) break;
    pagesLast.push(`<div class="page">${buildCodeHtml(files, start, end)}</div>`);
  }
  const htmlLast = buildHtmlDoc('源程序 - 后30页', pagesLast.join('\n'));

  const outputDir = path.join(rootDir, 'source-pdf-output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const htmlFirstPath = path.join(outputDir, '源程序前30页.html');
  const htmlLastPath = path.join(outputDir, '源程序后30页.html');
  fs.writeFileSync(htmlFirstPath, htmlFirst, 'utf8');
  fs.writeFileSync(htmlLastPath, htmlLast, 'utf8');
  console.log(`已生成: ${htmlFirstPath}`);
  console.log(`已生成: ${htmlLastPath}`);

  // 尝试用 Puppeteer 生成 PDF
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlFirst, { waitUntil: 'domcontentloaded' });
    await page.pdf({
      path: path.join(outputDir, '源程序前30页.pdf'),
      format: 'A4',
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
      printBackground: true
    });
    await page.setContent(htmlLast, { waitUntil: 'domcontentloaded' });
    await page.pdf({
      path: path.join(outputDir, '源程序后30页.pdf'),
      format: 'A4',
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
      printBackground: true
    });
    await browser.close();
    console.log(`已生成 PDF: ${path.join(outputDir, '源程序前30页.pdf')}`);
    console.log(`已生成 PDF: ${path.join(outputDir, '源程序后30页.pdf')}`);
  } catch (err) {
    console.log('\n自动生成 PDF 失败:', err.message);
    console.log('请用浏览器打开上述 HTML 文件，按 Ctrl+P 选择「另存为 PDF」即可。');
  }
}

main().catch(console.error);
