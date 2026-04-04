/**
 * 生成软件文档 PDF
 * 要求：每页不少于30行；若文档>=60页则提交前30页+后30页；若<60页则提交整个文档
 */

const fs = require('fs');
const path = require('path');

const LINES_PER_PAGE = 30;  // 每页至少30行
const PAGES_THRESHOLD = 60;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 简单 Markdown 转 HTML
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('# ')) {
      out.push(`<h1 class="doc-h1">${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      out.push(`<h2 class="doc-h2">${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith('### ')) {
      out.push(`<h3 class="doc-h3">${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith('#### ')) {
      out.push(`<h4 class="doc-h4">${escapeHtml(line.slice(5))}</h4>`);
    } else if (line === '---') {
      out.push('<hr class="doc-hr">');
    } else if (line.trim() === '') {
      out.push('<div class="doc-blank"></div>');
    } else {
      let text = escapeHtml(line);
      text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      out.push(`<p class="doc-p">${text}</p>`);
    }
  }
  return out.join('\n');
}

function buildHtmlDoc(title, bodyContent) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Microsoft YaHei', 'SimSun', sans-serif; font-size: 11pt; line-height: 1.6; color: #333; }
    .page { page-break-after: always; padding: 15mm; min-height: 277mm; }
    .page:last-child { page-break-after: auto; }
    .doc-h1 { font-size: 18pt; margin: 12pt 0 8pt 0; border-bottom: 1px solid #333; padding-bottom: 4pt; }
    .doc-h2 { font-size: 14pt; margin: 10pt 0 6pt 0; }
    .doc-h3 { font-size: 12pt; margin: 8pt 0 4pt 0; }
    .doc-h4 { font-size: 11pt; margin: 6pt 0 4pt 0; }
    .doc-p { margin: 2pt 0; text-indent: 0; }
    .doc-blank { height: 1em; }
    .doc-hr { border: none; border-top: 1px solid #ccc; margin: 8pt 0; }
    @media print {
      .page { min-height: 0; padding: 12mm; }
    }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

async function main() {
  const rootDir = path.join(__dirname, '..');
  const docPath = path.join(rootDir, 'docs', '软件文档-甘特图管理系统.md');
  const outputDir = path.join(rootDir, 'doc-pdf-output');

  if (!fs.existsSync(docPath)) {
    console.error('文档不存在:', docPath);
    process.exit(1);
  }

  const md = fs.readFileSync(docPath, 'utf8');
  const mdLines = md.split('\n');

  // 按页分割：每页 LINES_PER_PAGE 行（按原始文档行数）
  const totalPages = Math.ceil(mdLines.length / LINES_PER_PAGE) || 1;

  console.log(`文档总行数: ${mdLines.length}, 总页数: ${totalPages}（每页${LINES_PER_PAGE}行）`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let pdfsToGenerate = [];

  if (totalPages < PAGES_THRESHOLD) {
    // 不足60页：提交整个文档
    console.log('文档不足60页，生成完整文档 PDF');
    const pages = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * LINES_PER_PAGE;
      const end = Math.min(start + LINES_PER_PAGE, mdLines.length);
      const pageMd = mdLines.slice(start, end).join('\n');
      const pageHtml = mdToHtml(pageMd);
      pages.push(`<div class="page">${pageHtml}</div>`);
    }
    const html = buildHtmlDoc('甘特图管理系统 - 软件文档（完整版）', pages.join('\n'));
    fs.writeFileSync(path.join(outputDir, '软件文档-完整版.html'), html, 'utf8');
    pdfsToGenerate.push({ html, filename: '软件文档-完整版.pdf' });
  } else {
    // >=60页：前30页 + 后30页
    console.log('文档>=60页，生成前30页和后30页 PDF');
    const pagesFirst = [];
    for (let p = 0; p < 30; p++) {
      const start = p * LINES_PER_PAGE;
      const end = Math.min(start + LINES_PER_PAGE, mdLines.length);
      const pageMd = mdLines.slice(start, end).join('\n');
      const pageHtml = mdToHtml(pageMd);
      pagesFirst.push(`<div class="page">${pageHtml}</div>`);
    }
    const htmlFirst = buildHtmlDoc('甘特图管理系统 - 软件文档（前30页）', pagesFirst.join('\n'));
    fs.writeFileSync(path.join(outputDir, '软件文档-前30页.html'), htmlFirst, 'utf8');
    pdfsToGenerate.push({ html: htmlFirst, filename: '软件文档-前30页.pdf' });

    const startLast = (totalPages - 30) * LINES_PER_PAGE;
    const pagesLast = [];
    for (let p = 0; p < 30; p++) {
      const start = startLast + p * LINES_PER_PAGE;
      const end = Math.min(start + LINES_PER_PAGE, mdLines.length);
      if (start >= mdLines.length) break;
      const pageMd = mdLines.slice(start, end).join('\n');
      const pageHtml = mdToHtml(pageMd);
      pagesLast.push(`<div class="page">${pageHtml}</div>`);
    }
    const htmlLast = buildHtmlDoc('甘特图管理系统 - 软件文档（后30页）', pagesLast.join('\n'));
    fs.writeFileSync(path.join(outputDir, '软件文档-后30页.html'), htmlLast, 'utf8');
    pdfsToGenerate.push({ html: htmlLast, filename: '软件文档-后30页.pdf' });
  }

  // 用 Puppeteer 生成 PDF
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    for (const { html, filename } of pdfsToGenerate) {
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.pdf({
        path: path.join(outputDir, filename),
        format: 'A4',
        margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
        printBackground: true
      });
      console.log('已生成:', filename);
    }
    await browser.close();
  } catch (err) {
    console.log('\n自动生成 PDF 失败:', err.message);
    console.log('请用浏览器打开 output 目录下的 HTML 文件，按 Ctrl+P 选择「另存为 PDF」。');
  }

  console.log('\n输出目录:', outputDir);
}

main().catch(console.error);
