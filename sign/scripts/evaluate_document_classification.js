const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { classifyDocument } = require('../lib/document_classifier');
const {
  applyManualOverride,
  buildSourceKey,
  loadManualOverrides,
  summarizeDocTypes,
} = require('../lib/classification_review');
const { DOC_TYPES } = require('../lib/package_constants');

const PROJECT_ROOT = require('node:path').resolve(__dirname, '..');
const DEFAULT_INPUT_DIR = 'D:\\JIN HAIMIN\\self\\ticket\\ppocrlabel\\workspace\\111';
const PYTHON_EXE = path.join(PROJECT_ROOT, 'paddleocr_standalone', '.venv', 'Scripts', 'python.exe');
const OCR_SCRIPT = path.join(PROJECT_ROOT, 'paddleocr_standalone', 'run_document_ocr_batch.py');
const DEFAULT_SAMPLE_SIZE = 50;
const DEFAULT_WORKER_COUNT = Math.min(3, Math.max(2, Math.ceil(os.cpus().length / 3)));
const DEFAULT_MAX_SIDE = 960;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);
const DOC_TYPE_OPTIONS = [
  DOC_TYPES.PASSPORT,
  DOC_TYPES.RECEIPT,
  DOC_TYPES.OTHER,
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '_');
}

function collectSampleImages(rootDir, sampleSize) {
  const folders = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'));

  const images = [];
  for (const folderPath of folders) {
    const folderImages = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(folderPath, entry.name))
      .filter((filePath) => SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'));

    for (const imagePath of folderImages) {
      images.push(imagePath);
      if (images.length >= sampleSize) {
        return images;
      }
    }
  }

  return images;
}

function chunkArray(items, chunkCount) {
  const chunks = Array.from({ length: chunkCount }, () => []);
  items.forEach((item, index) => {
    chunks[index % chunkCount].push(item);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

function buildOcrArgs(manifestPath, ocrJsonPath, ocrOptions) {
  const args = [
    OCR_SCRIPT,
    '--manifest',
    manifestPath,
    '--out',
    ocrJsonPath,
    '--max-side',
    String(ocrOptions.maxSide),
  ];

  if (ocrOptions.useAngleCls) {
    args.push('--use-angle-cls');
  }

  return args;
}

function runPythonOcrJob(manifestPath, ocrJsonPath, ocrOptions) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXE, buildOcrArgs(manifestPath, ocrJsonPath, ocrOptions), {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `OCR process failed with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(fs.readFileSync(ocrJsonPath, 'utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runBatchOcr(sampleImages, outputDir, workerCount, ocrOptions) {
  const manifestPath = path.join(outputDir, 'sample_manifest.txt');
  fs.writeFileSync(manifestPath, `${sampleImages.join('\n')}\n`, 'utf8');

  if (workerCount <= 1 || sampleImages.length <= 1) {
    const ocrJsonPath = path.join(outputDir, 'ocr_results.json');
    const result = spawnSync(PYTHON_EXE, buildOcrArgs(manifestPath, ocrJsonPath, ocrOptions), {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || 'Batch OCR failed');
    }

    return JSON.parse(fs.readFileSync(ocrJsonPath, 'utf8'));
  }

  const chunkedImages = chunkArray(sampleImages, workerCount);
  const jobs = chunkedImages.map((chunk, index) => {
    const chunkManifestPath = path.join(outputDir, `sample_manifest_${index + 1}.txt`);
    const chunkOcrJsonPath = path.join(outputDir, `ocr_results_${index + 1}.json`);
    fs.writeFileSync(chunkManifestPath, `${chunk.join('\n')}\n`, 'utf8');
    return runPythonOcrJob(chunkManifestPath, chunkOcrJsonPath, ocrOptions);
  });

  const results = await Promise.all(jobs);
  return results.flat();
}

function _escapeHtml(value) { // 备用,_=有意保留未用
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsvReport(entries, outputDir) {
  const csvHeaders = [
    'index',
    'folderName',
    'fileName',
    'sourceKey',
    'docTypeAuto',
    'docTypeFinal',
    'manualOverride',
    'manualReviewNote',
    'confidence',
    'needsReview',
    'reviewReasons',
    'lineCount',
    'averageOcrScore',
    'ocrError',
    'ocrPreview',
    'sourcePath',
    'copiedImagePath',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const entry of entries) {
    csvLines.push(csvHeaders.map((header) => csvCell(entry[header])).join(','));
  }
  const reportCsvPath = path.join(outputDir, 'report.csv');
  fs.writeFileSync(reportCsvPath, `${csvLines.join('\n')}\n`, 'utf8');
  return reportCsvPath;
}

function writeHtmlReport(entries, outputDir, summary) {
  const reportEntries = entries.map((entry) => ({
    index: entry.index,
    folderName: entry.folderName,
    fileName: entry.fileName,
    sourceKey: entry.sourceKey,
    sourcePath: entry.sourcePath,
    relativeImagePath: path.relative(outputDir, entry.copiedImagePath).split(path.sep).join('/'),
    docTypeAuto: entry.docTypeAuto,
    docTypeFinal: entry.docTypeFinal,
    manualOverride: entry.manualOverride,
    manualReviewNote: entry.manualReviewNote,
    confidence: entry.confidence,
    needsReview: entry.needsReview,
    reviewReasons: Array.isArray(entry.reviewReasons)
      ? entry.reviewReasons
      : String(entry.reviewReasons || '')
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean),
    lineCount: entry.lineCount,
    averageOcrScore: entry.averageOcrScore,
    ocrPreview: entry.ocrPreview,
  }));

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Document Classification Audit</title>
  <style>
    :root {
      --bg: #f3f6fb;
      --surface: #ffffff;
      --line: #d8e0ea;
      --text: #102033;
      --muted: #607389;
      --primary: #2563eb;
      --success: #17804f;
      --warning: #c78708;
      --danger: #ca4a35;
      --shadow: 0 12px 28px rgba(16, 32, 51, 0.08);
      --radius: 18px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(37, 99, 235, 0.06), transparent 28%),
        linear-gradient(180deg, #f7faff 0%, var(--bg) 100%);
      font: 14px/1.5 "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    }
    button, select, textarea { font: inherit; }
    .page {
      max-width: 1680px;
      margin: 0 auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .hero, .panel, .card {
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 18px 20px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
    }
    .hero h1 {
      margin: 0 0 6px;
      font-size: 28px;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 760px;
    }
    .stats {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-start;
    }
    .stat {
      min-width: 118px;
      padding: 12px 14px;
      border-radius: 14px;
      background: #f8fbff;
      border: 1px solid #e3ebf5;
    }
    .stat-label {
      font-size: 12px;
      color: var(--muted);
    }
    .stat-value {
      margin-top: 4px;
      font-size: 22px;
      font-weight: 700;
    }
    .panel {
      padding: 16px 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
    }
    .panel-left {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .button {
      border: none;
      border-radius: 12px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .button.primary { background: var(--primary); color: #fff; }
    .button.ghost { background: #eef3fb; color: var(--text); }
    .button.warn { background: #fff4dc; color: #875b05; }
    .legend {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid transparent;
    }
    .badge.passport { background: #e9f3ff; color: #0e4ab5; border-color: #cfe1ff; }
    .badge.receipt { background: #fff3e7; color: #b45a15; border-color: #ffd8b2; }
    .badge.ticket { background: #edf8f0; color: #147a49; border-color: #ccead7; }
    .badge.other { background: #f2f4f8; color: #58667a; border-color: #dde4ed; }
    .badge.review { background: #fff5dd; color: #a86f02; border-color: #f0d79a; }
    .badge.manual { background: #fdece7; color: #b23f2c; border-color: #f5c7bb; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 16px;
    }
    .card {
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .thumb-wrap {
      background: linear-gradient(180deg, #fbfdff 0%, #f3f7fc 100%);
      border-bottom: 1px solid var(--line);
      padding: 10px;
    }
    .thumb {
      width: 100%;
      height: 320px;
      object-fit: contain;
      border-radius: 14px;
      background: #fff;
      border: 1px solid #e7edf5;
    }
    .card-body {
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .card-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
    }
    .card-title strong {
      display: block;
      font-size: 15px;
      word-break: break-word;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      word-break: break-word;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field span {
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
    }
    select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: #fff;
      color: var(--text);
    }
    textarea {
      min-height: 78px;
      resize: vertical;
    }
    pre {
      margin: 0;
      padding: 10px 12px;
      border-radius: 12px;
      background: #f7f9fc;
      border: 1px solid #e8edf5;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      color: #32455d;
    }
    .path-box {
      padding: 10px 12px;
      border-radius: 12px;
      background: #f7f9fc;
      border: 1px solid #e8edf5;
      font-size: 12px;
      color: #32455d;
      word-break: break-all;
    }
    .muted {
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 900px) {
      .hero {
        flex-direction: column;
      }
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div>
        <h1>分类抽样复核台</h1>
        <p>这份页面现在支持你直接人工改分类、填写备注、复制原图路径，并导出纠错 JSON/CSV。下次重跑时把导出的 JSON 传回脚本，系统就会按你的人工结果落目录。</p>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="stat-label">样本数</div>
          <div class="stat-value">${summary.sampleSize}</div>
        </div>
        <div class="stat">
          <div class="stat-label">并行 worker</div>
          <div class="stat-value">${summary.workerCount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">OCR 秒数</div>
          <div class="stat-value">${summary.elapsedSeconds}</div>
        </div>
        <div class="stat">
          <div class="stat-label">自动复核数</div>
          <div class="stat-value">${summary.reviewCount}</div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-left">
        <button id="exportJsonBtn" class="button primary" type="button">导出纠错 JSON</button>
        <button id="exportCsvBtn" class="button ghost" type="button">导出纠错 CSV</button>
        <button id="resetLocalBtn" class="button warn" type="button">清空本页人工修改</button>
      </div>
      <div class="legend" id="liveSummary"></div>
    </section>

    <section class="grid" id="grid"></section>
  </div>

  <script>
    const DOC_TYPE_OPTIONS = ${JSON.stringify(DOC_TYPE_OPTIONS)};
    const REPORT_ENTRIES = ${JSON.stringify(reportEntries)};
    const REPORT_META = ${JSON.stringify({
      outputDir: summary.outputDir,
      sampleSize: summary.sampleSize,
      workerCount: summary.workerCount,
      elapsedSeconds: summary.elapsedSeconds,
      reviewCount: summary.reviewCount,
    })};
    const STORAGE_KEY = 'classification-audit:' + REPORT_META.outputDir;

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function readLocalOverrides() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (_error) {
        return {};
      }
    }

    function writeLocalOverrides(value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    }

    function badgeClass(docType) {
      return ['passport', 'receipt', 'other'].includes(docType) ? docType : 'other';
    }

    function computeCounts(entries) {
      return entries.reduce((counts, entry) => {
        counts[entry.docTypeFinal] = (counts[entry.docTypeFinal] || 0) + 1;
        return counts;
      }, {});
    }

    function buildSummary(entries) {
      const counts = computeCounts(entries);
      const changed = entries.filter((entry) => entry.docTypeFinal !== entry.docTypeAuto || entry.manualReviewNote).length;
      const parts = [
        '<span>当前人工结果:</span>',
        ...Object.entries(counts).map(([key, value]) => (
          '<span class="badge ' + badgeClass(key) + '">' + escapeHtml(key) + ' ' + value + '</span>'
        )),
        '<span class="badge manual">人工变更 ' + changed + '</span>',
      ];
      document.querySelector('#liveSummary').innerHTML = parts.join('');
    }

    function applyLocalOverrides(entries) {
      const overrides = readLocalOverrides();
      return entries.map((entry) => {
        const override = overrides[entry.sourceKey] || null;
        return {
          ...entry,
          docTypeFinal: override?.docTypeFinal || entry.docTypeFinal,
          manualReviewNote: override?.reviewNote || entry.manualReviewNote || '',
        };
      });
    }

    function persistEntry(entry) {
      const overrides = readLocalOverrides();
      const shouldKeep = entry.docTypeFinal !== entry.docTypeAuto || entry.manualReviewNote;
      if (shouldKeep) {
        overrides[entry.sourceKey] = {
          sourceKey: entry.sourceKey,
          sourcePath: entry.sourcePath,
          docTypeAuto: entry.docTypeAuto,
          docTypeFinal: entry.docTypeFinal,
          reviewNote: entry.manualReviewNote || '',
        };
      } else {
        delete overrides[entry.sourceKey];
      }
      writeLocalOverrides(overrides);
    }

    function downloadText(fileName, content, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (_error) {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
      }
    }

    function collectManualOverrides(entries) {
      return entries
        .filter((entry) => entry.docTypeFinal !== entry.docTypeAuto || entry.manualReviewNote)
        .map((entry) => ({
          sourceKey: entry.sourceKey,
          sourcePath: entry.sourcePath,
          docTypeAuto: entry.docTypeAuto,
          docTypeFinal: entry.docTypeFinal,
          reviewNote: entry.manualReviewNote || '',
        }));
    }

    function render(entries) {
      buildSummary(entries);
      const cards = entries.map((entry, index) => {
        const reviewBadges = [];
        if (entry.needsReview) {
          reviewBadges.push('<span class="badge review">待人工确认</span>');
        }
        if (entry.docTypeFinal !== entry.docTypeAuto || entry.manualReviewNote) {
          reviewBadges.push('<span class="badge manual">已人工修改</span>');
        }
        reviewBadges.push('<span class="badge ' + badgeClass(entry.docTypeAuto) + '">自动 ' + escapeHtml(entry.docTypeAuto) + '</span>');
        reviewBadges.push('<span class="badge ' + badgeClass(entry.docTypeFinal) + '">最终 ' + escapeHtml(entry.docTypeFinal) + '</span>');

        const reasonHtml = entry.reviewReasons.length
          ? entry.reviewReasons.map((reason) => '<span class="badge review">' + escapeHtml(reason) + '</span>').join(' ')
          : '<span class="muted">无强制复核原因</span>';

        const optionsHtml = DOC_TYPE_OPTIONS
          .map((docType) => '<option value="' + docType + '"' + (docType === entry.docTypeFinal ? ' selected' : '') + '>' + docType + '</option>')
          .join('');

        return \`
          <article class="card" data-entry-index="\${index}">
            <div class="thumb-wrap">
              <img class="thumb" src="\${escapeHtml(entry.relativeImagePath)}" alt="\${escapeHtml(entry.fileName)}" />
            </div>
            <div class="card-body">
              <div class="card-title">
                <div>
                  <strong>\${escapeHtml(entry.fileName)}</strong>
                  <div class="meta">\${escapeHtml(entry.folderName)}</div>
                </div>
                <div class="meta">#\${entry.index}</div>
              </div>

              <div class="row">\${reviewBadges.join(' ')}</div>
              <div class="row">\${reasonHtml}</div>

              <div class="meta">置信度 \${entry.confidence} · OCR 行数 \${entry.lineCount} · 平均分 \${entry.averageOcrScore}</div>

              <label class="field">
                <span>人工最终分类</span>
                <select data-role="doc-type">
                  \${optionsHtml}
                </select>
              </label>

              <label class="field">
                <span>人工备注</span>
                <textarea data-role="review-note" placeholder="例如：这张其实是护照 + 购物卡混合图，需要按护照处理">\${escapeHtml(entry.manualReviewNote || '')}</textarea>
              </label>

              <div class="field">
                <span>原始路径</span>
                <div class="path-box">\${escapeHtml(entry.sourcePath)}</div>
              </div>

              <div class="row">
                <button class="button ghost" type="button" data-role="copy-path">复制原路径</button>
                <button class="button ghost" type="button" data-role="reset-entry">恢复自动分类</button>
              </div>

              <details>
                <summary>查看 OCR 预览与 sourceKey</summary>
                <div class="meta" style="margin: 8px 0 6px;">sourceKey: \${escapeHtml(entry.sourceKey)}</div>
                <pre>\${escapeHtml(entry.ocrPreview || '暂无 OCR 文本')}</pre>
              </details>
            </div>
          </article>\`;
      }).join('');

      document.querySelector('#grid').innerHTML = cards;

      document.querySelectorAll('[data-entry-index]').forEach((card) => {
        const index = Number(card.dataset.entryIndex);
        const entry = entries[index];
        const docTypeSelect = card.querySelector('[data-role="doc-type"]');
        const reviewNoteInput = card.querySelector('[data-role="review-note"]');
        const copyPathBtn = card.querySelector('[data-role="copy-path"]');
        const resetEntryBtn = card.querySelector('[data-role="reset-entry"]');

        docTypeSelect.addEventListener('change', (event) => {
          entry.docTypeFinal = event.target.value;
          persistEntry(entry);
          buildSummary(entries);
        });

        reviewNoteInput.addEventListener('input', (event) => {
          entry.manualReviewNote = event.target.value;
          persistEntry(entry);
          buildSummary(entries);
        });

        copyPathBtn.addEventListener('click', async () => {
          await copyText(entry.sourcePath);
          copyPathBtn.textContent = '已复制';
          setTimeout(() => { copyPathBtn.textContent = '复制原路径'; }, 1200);
        });

        resetEntryBtn.addEventListener('click', () => {
          entry.docTypeFinal = entry.docTypeAuto;
          entry.manualReviewNote = '';
          docTypeSelect.value = entry.docTypeFinal;
          reviewNoteInput.value = '';
          persistEntry(entry);
          buildSummary(entries);
        });
      });
    }

    const state = {
      entries: applyLocalOverrides(REPORT_ENTRIES),
    };

    document.querySelector('#exportJsonBtn').addEventListener('click', () => {
      const overrides = collectManualOverrides(state.entries);
      downloadText(
        'classification_manual_overrides.json',
        JSON.stringify({
          version: 1,
          createdAt: new Date().toISOString(),
          generatedFrom: REPORT_META.outputDir,
          entries: overrides,
        }, null, 2),
        'application/json'
      );
    });

    document.querySelector('#exportCsvBtn').addEventListener('click', () => {
      const rows = collectManualOverrides(state.entries);
      const headers = ['sourceKey', 'sourcePath', 'docTypeAuto', 'docTypeFinal', 'reviewNote'];
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        csvLines.push(headers.map((header) => {
          const text = String(row[header] ?? '');
          return /[",\\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
        }).join(','));
      }
      downloadText('classification_manual_overrides.csv', csvLines.join('\\n') + '\\n', 'text/csv;charset=utf-8');
    });

    document.querySelector('#resetLocalBtn').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      state.entries = REPORT_ENTRIES.map((entry) => ({ ...entry }));
      render(state.entries);
    });

    render(state.entries);
  </script>
</body>
</html>`;

  const reportHtmlPath = path.join(outputDir, 'index.html');
  fs.writeFileSync(reportHtmlPath, html, 'utf8');
  return reportHtmlPath;
}

async function main() {
  const inputDir = process.argv[2] || DEFAULT_INPUT_DIR;
  const requestedSampleSize = Number(process.argv[3] || DEFAULT_SAMPLE_SIZE);
  const sampleSize = Number.isFinite(requestedSampleSize) && requestedSampleSize > 0
    ? Math.floor(requestedSampleSize)
    : DEFAULT_SAMPLE_SIZE;
  const requestedWorkers = Number(process.argv[4] || process.env.CLASSIFIER_WORKERS || DEFAULT_WORKER_COUNT);
  const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(Math.floor(requestedWorkers), Math.max(1, os.cpus().length))
    : DEFAULT_WORKER_COUNT;
  const overridePath = process.argv[5] || process.env.CLASSIFIER_OVERRIDES || '';
  const maxSide = Number(process.env.CLASSIFIER_MAX_SIDE || DEFAULT_MAX_SIDE);
  const useAngleCls = String(process.env.CLASSIFIER_USE_ANGLE_CLS || '').toLowerCase() === 'true';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const outputDir = path.join(PROJECT_ROOT, `classification_test_${sampleSize}_${stamp}_${crypto.randomUUID().slice(0, 6)}`);

  ensureDir(outputDir);
  for (const subdir of DOC_TYPE_OPTIONS) {
    ensureDir(path.join(outputDir, subdir));
  }

  const sampleImages = collectSampleImages(inputDir, sampleSize);
  if (sampleImages.length === 0) {
    throw new Error(`No images found in ${inputDir}`);
  }

  const manualOverrides = loadManualOverrides(overridePath);
  const ocrOptions = {
    maxSide,
    useAngleCls,
  };

  const startedAt = Date.now();
  const ocrResults = await runBatchOcr(sampleImages, outputDir, workerCount, ocrOptions);
  const entries = [];

  for (let index = 0; index < ocrResults.length; index += 1) {
    const result = ocrResults[index];
    const sourcePath = result.image;
    const folderName = path.basename(path.dirname(sourcePath));
    const fileName = path.basename(sourcePath);
    const classification = classifyDocument({
      fileName,
      ocrText: result.joined_text || '',
    });
    const sourceKey = buildSourceKey(inputDir, sourcePath);

    const reviewedEntry = applyManualOverride(
      {
        index: index + 1,
        folderName,
        fileName,
        sourcePath,
        sourceKey,
        predictedDocType: classification.docType,
        docTypeAuto: classification.docType,
        docTypeFinal: classification.docType,
        confidence: classification.confidence,
        needsReview: classification.needsReview,
        reviewReasons: classification.reviewReasons,
        lineCount: result.line_count || 0,
        averageOcrScore: result.average_score || 0,
        ocrPreview: (result.lines || []).slice(0, 8).map((line) => line.text).join('\n'),
        fullOcrText: result.joined_text || '',
        ocrError: result.error || '',
      },
      manualOverrides
    );

    const prefix = String(index + 1).padStart(3, '0');
    const copiedName = `${prefix}__${sanitizeSegment(folderName)}__${sanitizeSegment(fileName)}`;
    const copiedImagePath = path.join(outputDir, reviewedEntry.docTypeFinal, copiedName);
    fs.copyFileSync(sourcePath, copiedImagePath);

    entries.push({
      ...reviewedEntry,
      copiedImagePath,
      reviewReasons: reviewedEntry.reviewReasons,
    });
  }

  const reportJsonPath = path.join(outputDir, 'report.json');
  fs.writeFileSync(reportJsonPath, JSON.stringify(entries, null, 2), 'utf8');
  const reportCsvPath = writeCsvReport(entries, outputDir);

  const summary = {
    inputDir,
    sampleSize: entries.length,
    workerCount,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    outputDir,
    ocrOptions,
    overridePath: overridePath || '',
    overrideCount: entries.filter((entry) => entry.manualOverride).length,
    predictedCounts: summarizeDocTypes(entries, 'docTypeAuto'),
    finalCounts: summarizeDocTypes(entries, 'docTypeFinal'),
    reviewCount: entries.filter((entry) => entry.needsReview).length,
    reportJsonPath,
    reportCsvPath,
    reportHtmlPath: '',
  };

  summary.reportHtmlPath = writeHtmlReport(entries, outputDir, summary);
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
