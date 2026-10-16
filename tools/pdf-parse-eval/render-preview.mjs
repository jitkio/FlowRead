#!/usr/bin/env node
/**
 * FlowRead Standalone Dark Theme Reading Preview Generator (render-preview.mjs)
 * Implements React SSR with ReactMarkdown, remark-gfm, remark-math, rehype-katex.
 * Renders from normalized blocks.json with data-block-id, block types, page numbers.
 * Provides interactive split-column inspector (reader view + block attributes / markdown tab).
 * Accurately tracks KaTeX formula rendering and resolves real raw output paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root and KaTeX assets
const projectRoot = path.resolve(__dirname, '../..');
const katexDistDir = path.join(projectRoot, 'node_modules/katex/dist');
const katexFontsDir = path.join(katexDistDir, 'fonts');

function copyDirRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function ensureKatexFonts(targetDir) {
  if (fs.existsSync(katexFontsDir)) {
    const destFontsDir = path.join(targetDir, 'fonts');
    if (!fs.existsSync(destFontsDir)) {
      copyDirRecursiveSync(katexFontsDir, destFontsDir);
    }
  }
}

function getLocalKatexCss() {
  const cssPath = path.join(katexDistDir, 'katex.min.css');
  if (fs.existsSync(cssPath)) {
    return fs.readFileSync(cssPath, 'utf-8');
  }
  return '';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Renders Markdown string to HTML using React SSR with GFM and KaTeX math plugins.
 */
function renderMarkdownWithKatex(markdownText) {
  if (!markdownText || typeof markdownText !== 'string' || !markdownText.trim()) {
    return '';
  }
  try {
    return ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm, remarkMath],
          rehypePlugins: [rehypeKatex],
        },
        markdownText
      )
    );
  } catch (err) {
    return `<div class="render-error">⚠️ Markdown/KaTeX 渲染异常: ${escapeHtml(err.message)}</div><pre><code>${escapeHtml(markdownText)}</code></pre>`;
  }
}

/**
 * Generates the full offline preview HTML from blocks.json and metadata.
 */
export function generatePreviewHtml({
  caseId,
  provider,
  blocks = [],
  contentMd = '',
  diagnostics = {},
  assetPrefix = 'assets/',
  samplePdfRelPath = '',
  rawMdRelPath = '',
  rawJsonRelPath = '',
  blocksJsonRelPath = '',
  verificationRelPath = '',
  comparisonRelPath = '',
  formulaStats = { total_formulas: 0, rendered_count: 0, error_count: 0, errors: [] },
}) {
  const katexCss = getLocalKatexCss();

  // Render individual blocks
  const renderedBlocksHtml = [];

  for (const block of blocks) {
    const bId = escapeHtml(block.id || '');
    const bType = block.type || 'unknown';
    const rawType = escapeHtml(block.raw_type || '');
    const pageSample = block.page_sample != null ? block.page_sample : '';
    const pageSource = block.page_source != null ? block.page_source : '';
    const content = block.content || '';
    const assetRef = block.asset_ref;
    const caption = block.caption || '';
    const inImageText = block.in_image_text || [];

    const pageBadge = pageSource ? `<span class="badge-page" title="样本第 ${pageSample} 页，原件第 ${pageSource} 页">P${pageSource}</span>` : '';

    if (bType in { page_header: 1, page_number: 1, page_footer: 1, PageHeader: 1, PageFooter: 1, PageNumber: 1 }) {
      renderedBlocksHtml.push(`
        <div class="reader-page-marker" data-block-id="${bId}" data-page="${pageSample}">
          <span class="marker-type">${escapeHtml(bType)}</span>
          <span class="marker-text">${escapeHtml(content)}</span>
          ${pageBadge}
        </div>
      `);
      continue;
    }

    if (bType === 'heading') {
      const renderedHeading = renderMarkdownWithKatex(content.startsWith('#') ? content : `## ${content}`);
      renderedBlocksHtml.push(`
        <div class="reader-block reader-heading" data-block-id="${bId}" data-block-type="heading" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill">heading</span>
            ${pageBadge}
          </div>
          <div class="block-content">${renderedHeading}</div>
        </div>
      `);
    } else if (bType === 'formula') {
      formulaStats.total_formulas++;
      const tex = content.trim();
      const markdownTex = (tex.startsWith('$$') && tex.endsWith('$$')) ? tex : `$$\n${tex}\n$$`;
      const renderedFormula = renderMarkdownWithKatex(markdownTex);

      if (renderedFormula.includes('katex')) {
        formulaStats.rendered_count++;
      } else {
        formulaStats.error_count++;
        formulaStats.errors.push({ id: bId, tex });
      }

      renderedBlocksHtml.push(`
        <div class="reader-block reader-formula" data-block-id="${bId}" data-block-type="formula" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill formula">formula</span>
            ${pageBadge}
          </div>
          <div class="block-content math-display-wrap">${renderedFormula}</div>
        </div>
      `);
    } else if (bType === 'image') {
      let imgTag = '';
      if (assetRef) {
        const imgSrc = `${assetPrefix}${escapeHtml(assetRef)}`;
        imgTag = `<div class="figure-media"><img src="${imgSrc}" alt="${escapeHtml(caption || bId)}" loading="lazy" /></div>`;
      }

      let figcaptionHtml = '';
      if (caption) {
        figcaptionHtml = `<figcaption class="figure-caption">${renderMarkdownWithKatex(caption)}</figcaption>`;
      } else if (content && !content.startsWith('![') && rawType === 'chart') {
        figcaptionHtml = `<figcaption class="figure-caption">${renderMarkdownWithKatex(content)}</figcaption>`;
      }

      let inImageDetails = '';
      if (inImageText.length > 0) {
        const chips = inImageText.map(t => `<span class="img-chip">${renderMarkdownWithKatex(t)}</span>`).join('');
        inImageDetails = `
          <details class="in-image-details">
            <summary>图内识别文字 (${inImageText.length} 项，已与正文分离)</summary>
            <div class="chip-container">${chips}</div>
          </details>
        `;
      }

      renderedBlocksHtml.push(`
        <figure class="reader-block reader-figure" data-block-id="${bId}" data-block-type="image" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill image">image (${rawType})</span>
            ${pageBadge}
          </div>
          ${imgTag}
          ${figcaptionHtml}
          ${inImageDetails}
        </figure>
      `);
    } else if (bType === 'caption') {
      renderedBlocksHtml.push(`
        <div class="reader-block reader-caption" data-block-id="${bId}" data-block-type="caption" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill caption">caption</span>
            ${pageBadge}
          </div>
          <div class="block-content caption-box">${renderMarkdownWithKatex(content)}</div>
        </div>
      `);
    } else if (bType === 'table') {
      const isHtml = block.content_format === 'html' || content.includes('<table');
      const tableInner = isHtml ? content : renderMarkdownWithKatex(content);
      renderedBlocksHtml.push(`
        <div class="reader-block reader-table" data-block-id="${bId}" data-block-type="table" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill table">table</span>
            ${pageBadge}
          </div>
          <div class="block-content table-scroll">${tableInner}</div>
        </div>
      `);
    } else if (bType === 'unknown') {
      renderedBlocksHtml.push(`
        <div class="reader-block reader-unknown" data-block-id="${bId}" data-block-type="unknown" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill unknown">⚠️ 未识别 (${rawType})</span>
            ${pageBadge}
          </div>
          <div class="block-content"><pre class="unknown-code"><code>${escapeHtml(content)}</code></pre></div>
        </div>
      `);
    } else {
      // Paragraph and general text
      const renderedPara = renderMarkdownWithKatex(content);
      renderedBlocksHtml.push(`
        <div class="reader-block reader-paragraph" data-block-id="${bId}" data-block-type="paragraph" data-page="${pageSample}">
          <div class="block-bar">
            <span class="block-id">#${bId}</span>
            <span class="block-type-pill">paragraph</span>
            ${pageBadge}
          </div>
          <div class="block-content">${renderedPara}</div>
        </div>
      `);
    }
  }

  const blocksJsonStr = JSON.stringify(blocks, null, 2);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlowRead 渲染预览 - [${escapeHtml(provider)}] ${escapeHtml(caseId)}</title>
  <style>
    :root {
      --bg-canvas: #090a0f;
      --bg-panel: #11141a;
      --bg-card: #171b22;
      --bg-card-hover: #1e232d;
      --border-subtle: #272c36;
      --border-active: #58a6ff;
      --text-main: #e6edf3;
      --text-muted: #8b949e;
      --text-accent: #58a6ff;
      --color-success: #3fb950;
      --color-warn: #d29922;
      --color-danger: #f85149;
      --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-canvas);
      color: var(--text-main);
      font-family: var(--font-body);
      line-height: 1.68;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Top Navigation Header */
    .top-header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border-subtle);
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      z-index: 100;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
    }
    .badge.mineru { background: #1f6feb; }
    .badge.datalab, .badge.datalab_v1, .badge.datalab_v2 { background: #8957e5; }
    .badge.default { background: #30363d; }
    .header-case {
      font-weight: 600;
      font-size: 14px;
      color: var(--text-main);
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .nav-btn {
      color: var(--text-accent);
      text-decoration: none;
      padding: 4px 10px;
      border-radius: 4px;
      background: rgba(88, 166, 255, 0.1);
      border: 1px solid rgba(88, 166, 255, 0.2);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .nav-btn:hover {
      background: rgba(88, 166, 255, 0.2);
      text-decoration: none;
    }
    .nav-btn.toggle-inspector {
      background: #238636;
      border-color: #2ea043;
      color: #ffffff;
    }

    /* Diagnostics Sub-bar */
    .stats-bar {
      background: #14171e;
      border-bottom: 1px solid var(--border-subtle);
      padding: 6px 20px;
      display: flex;
      gap: 18px;
      font-size: 12px;
      color: var(--text-muted);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .stats-item b { color: var(--text-main); }
    .stats-item.ok b { color: var(--color-success); }
    .stats-item.err b { color: var(--color-danger); }

    /* Main Split Layout */
    .app-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }

    /* Left Reader Column */
    .reader-column {
      flex: 1;
      overflow-y: auto;
      padding: 30px 40px 100px 40px;
      display: flex;
      justify-content: center;
    }
    .reader-scroll-canvas {
      max-width: 860px;
      width: 100%;
    }

    /* Reader Blocks */
    .reader-block {
      margin-bottom: 1.4em;
      padding: 12px 16px;
      border-radius: 6px;
      border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
      position: relative;
    }
    .reader-block:hover {
      background: rgba(255, 255, 255, 0.02);
      border-color: rgba(88, 166, 255, 0.3);
    }
    .reader-block.selected {
      background: rgba(88, 166, 255, 0.05);
      border-color: var(--border-active);
      box-shadow: 0 0 0 1px var(--border-active);
    }

    .block-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 6px;
      user-select: none;
    }
    .block-id {
      font-family: var(--font-mono);
      color: #79c0ff;
      font-weight: 600;
    }
    .block-type-pill {
      background: #21262d;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      text-transform: uppercase;
    }
    .block-type-pill.formula { background: #38235e; color: #d2a8ff; }
    .block-type-pill.image { background: #1f3b26; color: #7ee787; }
    .block-type-pill.table { background: #3b2e1e; color: #f2cc60; }
    .block-type-pill.caption { background: #263545; color: #a5d6ff; }
    .block-type-pill.unknown { background: #4a1e1e; color: #ff7b72; }
    .badge-page {
      background: #30363d;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      color: #c9d1d9;
    }

    .reader-page-marker {
      font-size: 11px;
      color: #6e7681;
      padding: 4px 12px;
      margin: 16px 0 8px 0;
      border-left: 2px solid #30363d;
      background: rgba(255, 255, 255, 0.01);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .marker-type {
      text-transform: uppercase;
      font-weight: 600;
      font-size: 9px;
      background: #21262d;
      padding: 1px 4px;
      border-radius: 3px;
    }

    /* Typographic Elements */
    .reader-heading h1, .reader-heading h2, .reader-heading h3 {
      color: #f0f6fc;
      margin-bottom: 0.2em;
    }
    .reader-heading h2 { font-size: 1.45rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 6px; }
    .reader-paragraph p { margin-bottom: 0.6em; }

    /* Formula Block */
    .reader-formula {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
    }
    .math-display-wrap {
      overflow-x: auto;
      padding: 8px 0;
      font-size: 1.05rem;
    }

    /* Figure Block */
    .reader-figure {
      text-align: center;
      margin: 2em 0;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
    }
    .figure-media img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
      background: #ffffff;
      border: 1px solid var(--border-subtle);
    }
    .figure-caption {
      margin-top: 10px;
      font-size: 13px;
      color: #8b949e;
      font-style: italic;
    }
    .in-image-details {
      margin-top: 12px;
      text-align: left;
      font-size: 12px;
      background: rgba(0, 0, 0, 0.3);
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px dashed var(--border-subtle);
    }
    .in-image-details summary {
      cursor: pointer;
      color: var(--text-accent);
      font-weight: 500;
    }
    .chip-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .img-chip {
      background: #21262d;
      border: 1px solid #30363d;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
    }

    /* Caption Block */
    .caption-box {
      font-size: 13px;
      color: #8b949e;
      border-left: 3px solid var(--text-accent);
      padding-left: 10px;
      font-style: italic;
    }

    /* Table Block */
    .table-scroll {
      overflow-x: auto;
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 12px;
      border: 1px solid var(--border-subtle);
    }
    th {
      background: #21262d;
      color: #fff;
      font-weight: 600;
    }
    tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }

    .unknown-code {
      font-family: var(--font-mono);
      font-size: 12px;
      color: #ff7b72;
      background: #221515;
      padding: 10px;
      border-radius: 4px;
      white-space: pre-wrap;
    }

    /* Right Inspector Column */
    .inspector-column {
      width: 460px;
      background: var(--bg-panel);
      border-left: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: width 0.2s ease;
    }
    .inspector-column.hidden {
      display: none;
    }

    .inspector-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: #14171e;
    }
    .tab-btn {
      flex: 1;
      padding: 10px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      text-align: center;
    }
    .tab-btn.active {
      color: var(--text-accent);
      border-bottom-color: var(--text-accent);
      background: rgba(88, 166, 255, 0.05);
    }

    .inspector-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .inspector-pane { display: none; }
    .inspector-pane.active { display: block; }

    pre.code-viewer {
      white-space: pre-wrap;
      word-break: break-all;
      color: #c9d1d9;
      background: #090a0f;
      padding: 12px;
      border-radius: 4px;
      border: 1px solid var(--border-subtle);
    }

    .prop-row {
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .prop-label {
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .prop-value {
      color: #f0f6fc;
      font-size: 12px;
    }

    /* KaTeX Embedded CSS */
    ${katexCss}
  </style>
</head>
<body>
  <!-- Top Navigation Bar -->
  <header class="top-header">
    <div class="header-left">
      <span class="badge ${escapeHtml(provider)}">${escapeHtml(provider)}</span>
      <span class="header-case">${escapeHtml(caseId)}</span>
    </div>
    <div class="nav-actions">
      <button class="nav-btn toggle-inspector" id="toggleInspectorBtn">🔲 切换右侧检查器</button>
      <a href="${escapeHtml(samplePdfRelPath)}" target="_blank" class="nav-btn">📄 切片 PDF</a>
      <a href="${escapeHtml(rawMdRelPath)}" target="_blank" class="nav-btn">📝 真实原 Markdown</a>
      <a href="${escapeHtml(rawJsonRelPath)}" target="_blank" class="nav-btn">⚙️ 真实原 JSON</a>
      <a href="${escapeHtml(blocksJsonRelPath)}" target="_blank" class="nav-btn">🧱 blocks.json</a>
      <a href="${escapeHtml(verificationRelPath)}" target="_blank" class="nav-btn">🎯 叠框核对</a>
      <a href="${escapeHtml(comparisonRelPath)}" class="nav-btn">📊 回到总览</a>
    </div>
  </header>

  <!-- Diagnostics Bar -->
  <div class="stats-bar">
    <div class="stats-item">结构块: <b>${blocks.length}</b></div>
    <div class="stats-item ${formulaStats.rendered_count > 0 ? 'ok' : ''}">公式总数: <b>${formulaStats.total_formulas}</b></div>
    <div class="stats-item ${formulaStats.rendered_count > 0 ? 'ok' : ''}">KaTeX 渲染成功: <b>${formulaStats.rendered_count}</b></div>
    <div class="stats-item ${formulaStats.error_count > 0 ? 'err' : ''}">公式异常: <b>${formulaStats.error_count}</b></div>
    <div class="stats-item">表格数: <b>${diagnostics.tables_count || 0}</b></div>
    <div class="stats-item">插图数: <b>${diagnostics.images_count || 0}</b></div>
    <div class="stats-item">未识别结构: <b>${(diagnostics.unhandled_structures || []).length}</b></div>
  </div>

  <!-- App Main Split -->
  <div class="app-layout">
    <!-- Reader Main Pane -->
    <main class="reader-column" id="readerScroll">
      <div class="reader-scroll-canvas" id="canvasContainer">
        ${renderedBlocksHtml.join('\n')}
      </div>
    </main>

    <!-- Right Inspector Pane -->
    <aside class="inspector-column" id="inspectorSidebar">
      <div class="inspector-tabs">
        <button class="tab-btn active" data-tab="tab-block">🧱 当前块属性</button>
        <button class="tab-btn" data-tab="tab-blocks-json">📋 blocks.json</button>
        <button class="tab-btn" data-tab="tab-content-md">📝 content.md</button>
      </div>

      <div class="inspector-content">
        <!-- Tab 1: Current Block Properties -->
        <div class="inspector-pane active" id="tab-block">
          <div id="selectedBlockProps">
            <p style="color: #8b949e; text-align: center; margin-top: 40px;">
              👈 点击左侧阅读器中的任意块，<br/>在此处查看其结构属性、来源页码与归一化坐标。
            </p>
          </div>
        </div>

        <!-- Tab 2: Full blocks.json -->
        <div class="inspector-pane" id="tab-blocks-json">
          <pre class="code-viewer"><code>${escapeHtml(blocksJsonStr)}</code></pre>
        </div>

        <!-- Tab 3: Full content.md -->
        <div class="inspector-pane" id="tab-content-md">
          <pre class="code-viewer"><code>${escapeHtml(contentMd)}</code></pre>
        </div>
      </div>
    </aside>
  </div>

  <!-- Client-side Inspector Controller -->
  <script>
    const ALL_BLOCKS = ${JSON.stringify(blocks)};
    const blocksMap = {};
    for (const b of ALL_BLOCKS) {
      if (b.id) blocksMap[b.id] = b;
    }

    const toggleBtn = document.getElementById('toggleInspectorBtn');
    const sidebar = document.getElementById('inspectorSidebar');
    const propsBox = document.getElementById('selectedBlockProps');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const panes = document.querySelectorAll('.inspector-pane');
    const readerBlocks = document.querySelectorAll('.reader-block');

    // Sidebar toggle
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('hidden');
    });

    // Tab switching
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const tabId = btn.getAttribute('data-tab');
        const targetPane = document.getElementById(tabId);
        if (targetPane) targetPane.classList.add('active');
      });
    });

    // Block selection and inspector update
    function selectBlock(blockId) {
      readerBlocks.forEach(el => el.classList.remove('selected'));
      const activeEl = document.querySelector(\`[data-block-id="\${blockId}"]\`);
      if (activeEl) {
        activeEl.classList.add('selected');
      }

      const b = blocksMap[blockId];
      if (!b) return;

      // Ensure sidebar is open
      sidebar.classList.remove('hidden');

      // Switch to block tab
      tabBtns[0].click();

      // Render block details
      propsBox.innerHTML = \`
        <div class="prop-row">
          <div class="prop-label">Block ID / 统一类型</div>
          <div class="prop-value"><b style="color:#58a6ff;">\${b.id}</b> (\${b.type})</div>
        </div>
        <div class="prop-row">
          <div class="prop-label">服务端原始类型 (raw_type)</div>
          <div class="prop-value"><code>\${b.raw_type || '-'}</code></div>
        </div>
        <div class="prop-row">
          <div class="prop-label">页码映射</div>
          <div class="prop-value">样本页: <b>\${b.page_sample || '-'}</b> | 原书页: <b>\${b.page_source || '-'}</b></div>
        </div>
        <div class="prop-row">
          <div class="prop-label">归一化坐标 [x0, y0, x1, y1]</div>
          <div class="prop-value"><code style="color:#7ee787;">\${JSON.stringify(b.normalized_bbox)}</code></div>
        </div>
        <div class="prop-row">
          <div class="prop-label">PDF 点坐标 (pt_bbox)</div>
          <div class="prop-value"><code>\${JSON.stringify(b.pt_bbox)}</code></div>
        </div>
        \${b.asset_ref ? \`
        <div class="prop-row">
          <div class="prop-label">关联图像资产 (asset_ref)</div>
          <div class="prop-value"><code>\${b.asset_ref}</code></div>
        </div>\` : ''}
        \${b.in_image_text && b.in_image_text.length ? \`
        <div class="prop-row">
          <div class="prop-label">图内文字识别项 (\${b.in_image_text.length})</div>
          <div class="prop-value"><code>\${JSON.stringify(b.in_image_text)}</code></div>
        </div>\` : ''}
        \${b.inline_runs && b.inline_runs.length ? \`
        <div class="prop-row">
          <div class="prop-label">行内结构 Runs (\${b.inline_runs.length} 项)</div>
          <pre class="code-viewer" style="font-size:11px; max-height:180px; overflow-y:auto;"><code>\${JSON.stringify(b.inline_runs, null, 2)}</code></pre>
        </div>\` : ''}
        <div class="prop-row">
          <div class="prop-label">完整 JSON 节点</div>
          <pre class="code-viewer" style="font-size:11px; max-height:220px; overflow-y:auto;"><code>\${JSON.stringify(b, null, 2)}</code></pre>
        </div>
      \`;
    }

    readerBlocks.forEach(el => {
      el.addEventListener('click', (e) => {
        const bId = el.getAttribute('data-block-id');
        if (bId) selectBlock(bId);
      });
    });
  </script>
</body>
</html>`;
}

// CLI handler if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: node render-preview.mjs <case_id> <provider> <normalized_dir> [output_preview_html]");
    process.exit(1);
  }

  const [caseId, provider, normDir, outHtml] = args;
  const targetPath = outHtml || path.join(normDir, 'preview.html');
  const targetDir = path.dirname(path.resolve(targetPath));

  // Ensure offline KaTeX fonts are available next to preview.html
  ensureKatexFonts(targetDir);

  const assetsAbs = path.join(path.resolve(normDir), 'assets');
  let assetPrefix = path.relative(targetDir, assetsAbs).replace(/\\/g, '/');
  if (!assetPrefix.endsWith('/')) assetPrefix += '/';
  if (assetPrefix.startsWith('//')) assetPrefix = assetPrefix.slice(1);

  const blocksJsonPath = path.join(normDir, 'blocks.json');
  const contentMdPath = path.join(normDir, 'content.md');
  const diagPath = path.join(normDir, 'diagnostics.json');

  const blocks = fs.existsSync(blocksJsonPath) ? JSON.parse(fs.readFileSync(blocksJsonPath, 'utf-8')) : [];
  const contentMd = fs.existsSync(contentMdPath) ? fs.readFileSync(contentMdPath, 'utf-8') : '# 无内容';
  const diag = fs.existsSync(diagPath) ? JSON.parse(fs.readFileSync(diagPath, 'utf-8')) : {};

  // Dynamically compute navigation links relative to targetDir
  const providerDir = path.resolve(normDir, '..');
  const caseDir = path.resolve(providerDir, '..');
  const resultsDir = path.resolve(caseDir, '..');
  const runDir = path.resolve(resultsDir, '..');

  const samplePdfPath = path.join(runDir, 'samples', caseId, 'input.pdf');
  const rawDir = path.join(providerDir, 'raw');

  // Accurately resolve raw Markdown file (especially MinerU raw/extracted/full.md)
  let rawMdPath = path.join(rawDir, 'content.md');
  const extractedDir = path.join(rawDir, 'extracted');
  if (fs.existsSync(path.join(extractedDir, 'full.md'))) {
    rawMdPath = path.join(extractedDir, 'full.md');
  } else if (fs.existsSync(path.join(rawDir, 'result.md'))) {
    rawMdPath = path.join(rawDir, 'result.md');
  }

  // Accurately resolve raw JSON file (especially MinerU raw/extracted/*content_list_v2.json)
  let rawJsonPath = path.join(rawDir, 'result.json');
  if (fs.existsSync(extractedDir)) {
    const c2 = fs.readdirSync(extractedDir).filter(f => f.endsWith('content_list_v2.json'));
    if (c2.length > 0) {
      rawJsonPath = path.join(extractedDir, c2[0]);
    }
  } else if (!fs.existsSync(rawJsonPath) && fs.existsSync(path.join(rawDir, 'datalab_response.json'))) {
    rawJsonPath = path.join(rawDir, 'datalab_response.json');
  }

  const verificationHtmlPath = path.join(runDir, 'verification', 'verification.html');
  const comparisonHtmlPath = path.join(runDir, 'comparison.html');

  const toRel = (p) => {
    return path.relative(targetDir, p).replace(/\\/g, '/');
  };

  const formulaStats = {
    total_formulas: 0,
    rendered_count: 0,
    error_count: 0,
    errors: [],
  };

  const html = generatePreviewHtml({
    caseId,
    provider,
    blocks,
    contentMd,
    diagnostics: diag,
    assetPrefix: assetPrefix.replace(/\/$/, '') + '/',
    samplePdfRelPath: toRel(samplePdfPath),
    rawMdRelPath: toRel(rawMdPath),
    rawJsonRelPath: toRel(rawJsonPath),
    blocksJsonRelPath: toRel(blocksJsonPath),
    verificationRelPath: toRel(verificationHtmlPath),
    comparisonRelPath: toRel(comparisonHtmlPath),
    formulaStats,
  });

  fs.writeFileSync(targetPath, html, 'utf-8');

  // Save formula_stats.json in normalized dir
  const statsOut = path.join(normDir, 'formula_stats.json');
  fs.writeFileSync(statsOut, JSON.stringify(formulaStats, null, 2), 'utf-8');

  console.log(`[Preview] Generated preview: ${targetPath} (Formulas: ${formulaStats.total_formulas}, Rendered: ${formulaStats.rendered_count}, Errors: ${formulaStats.error_count})`);
}
