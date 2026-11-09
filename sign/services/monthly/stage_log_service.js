'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createStageLogService({ exportRoot = null } = {}) {
  const root = path.resolve(exportRoot || path.join(os.tmpdir(), 'monthly-exports'));

  function workspaceLogDir(workspaceKey) {
    const dir = path.join(root, String(workspaceKey || ''), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function createRunLog({ workspaceKey, stage, stageJobId = null, startedAt = null }) {
    if (!workspaceKey || !stage) throw new Error('workspaceKey and stage required');
    const started = startedAt || new Date().toISOString();
    const dir = workspaceLogDir(workspaceKey);
    const filename = buildLogFilename({ stage, stageJobId, startedAt: started });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, '', 'utf8');

    const writer = {
      filename,
      filePath,
      writeLine(line = '') {
        fs.appendFileSync(filePath, `${line}\n`, 'utf8');
      },
      writeJson(label, payload) {
        writer.writeLine(`${label}: ${JSON.stringify(payload, null, 2)}`);
      },
      finish({ finishedAt = null, result = null, error = null } = {}) {
        writer.writeLine('');
        writer.writeLine(`结束时间：${finishedAt || new Date().toISOString()}`);
        if (error) writer.writeLine(`错误：${error?.message || String(error)}`);
        if (result) writer.writeJson('最终统计', result);
        return { logFile: filename, logPath: filePath };
      },
    };
    return writer;
  }

  function writeStageSummary({ workspaceKey, stage, stageJobId = null, startedAt = null, result = null, operator = null }) {
    const log = createRunLog({ workspaceKey, stage, stageJobId, startedAt });
    log.writeLine(`阶段：${stageDisplayName(stage)}`);
    log.writeLine(`工作区：${workspaceKey}`);
    if (stageJobId != null) log.writeLine(`任务编号：${stageJobId}`);
    if (operator) log.writeLine(`操作员：${operator}`);
    log.writeLine(`开始时间：${startedAt || new Date().toISOString()}`);
    log.writeLine('');
    log.writeLine('说明：本日志记录该月度按钮执行后的输入、输出和统计结果。');
    if (result) log.writeJson('执行结果', result);
    return log.finish({ result });
  }

  function resolveLogPath({ workspaceKey, filename }) {
    const safeName = path.basename(String(filename || ''));
    if (!safeName || !safeName.endsWith('.log')) return null;
    const dir = workspaceLogDir(workspaceKey);
    const filePath = path.join(dir, safeName);
    const normalizedDir = `${path.resolve(dir)}${path.sep}`;
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedDir)) return null;
    return fs.existsSync(normalizedFile) ? normalizedFile : null;
  }

  return {
    root,
    createRunLog,
    writeStageSummary,
    resolveLogPath,
  };
}

function stageDisplayName(stage) {
  return {
    import_daily_receipt: '导入台账/每日收票',
    import_store_bill: '导入店铺账单',
    bill_match: '账单匹配',
    merge: '合并月度数据',
    second_pass: '二次扫漏',
    export: '导出交付包',
    received_receipt_export: '生成收票汇总',
  }[stage] || String(stage || '月度任务');
}

function buildLogFilename({ stage, stageJobId = null, startedAt = null }) {
  const stamp = String(startedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .replace(/[^\dTZ-]/g, '');
  const jobPart = stageJobId == null ? 'manual' : `job-${stageJobId}`;
  return `${sanitize(stage)}_${jobPart}_${stamp}.log`;
}

function sanitize(value) {
  return String(value || 'stage').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
}

module.exports = { createStageLogService };
