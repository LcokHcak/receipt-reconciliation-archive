'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPhase0 } = require('../scripts/run-phase0-validation');

function makeSampleDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-phase0-'));
  const folders = {
    'BAI FANGRUIYAN EM93': ['passport.jpg', 'receipt.jpg', 'flight.jpg'],
    'WANG XIAOTONG EK00': ['passport.jpg', 'receipt.jpg'],
  };
  for (const [folder, files] of Object.entries(folders)) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir);
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x'); // 占位字节
  }
  return root;
}

// 注入式抽取器：按文件名返回固定字段（绕过真实 LLM/API）
function fakeExtractorByFilename() {
  const byFolder = {
    'BAI FANGRUIYAN EM93': { passportNo: 'EM9314578', flightNo: '9C8572', name: 'BAI FANGRUIYAN' },
    'WANG XIAOTONG EK00': { passportNo: 'EK0053004', flightNo: 'KE123', name: 'WANG XIAOTONG' },
  };
  async function extractImage(imagePath) {
    const folder = path.basename(path.dirname(imagePath));
    const base = path.basename(imagePath);
    const c = byFolder[folder];
    if (base.startsWith('passport')) {
      return { type: 'passport', passportNo: c.passportNo, name: c.name, confidence: 0.95 };
    }
    if (base.startsWith('receipt')) {
      return { type: 'receipt', passportNo: c.passportNo, flightNo: c.flightNo, confidence: 0.9 };
    }
    if (base.startsWith('flight')) {
      return { type: 'flight', flightNo: c.flightNo, confidence: 0.9 };
    }
    return { type: 'other', confidence: 0 };
  }
  return { extractImage };
}

test('Phase0 端到端：遍历文件夹→抽取→归组→评分（注入 mock，无需 API）', async () => {
  const sampleDir = makeSampleDir();
  try {
    const report = await runPhase0({
      sampleDir,
      maxFolders: 0,
      extractor: fakeExtractorByFilename(),
    });

    assert.equal(report.folders, 2);
    assert.equal(report.records, 5); // 3 + 2
    assert.equal(report.clusters, 2); // 两本护照两簇
    assert.equal(report.metrics.precision, 1); // 永不错并
    assert.ok(report.metrics.coverage >= 0.8); // 航班号唯一时也能桥接
  } finally {
    fs.rmSync(sampleDir, { recursive: true, force: true });
  }
});

test('样本目录不存在时明确报错', async () => {
  await assert.rejects(() => runPhase0({ sampleDir: path.join(os.tmpdir(), 'nope-intake-xyz') }), /样本目录不存在/);
});
