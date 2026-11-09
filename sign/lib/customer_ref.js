'use strict';

/**
 * 客户引用解析(单一来源)—— 从 sourceOriginalPath/任务里解出 { workspaceKey, customerId }。
 * customerId 形如 CLxxxxxxxx-NNN(N) 3~4 位序号;前一段路径段是 workspaceKey。
 *
 * 之前在 workbench_export / batch_customer_data_export / monthly customer_evidence /
 * final_delivery_export 各写一份(同正则同逻辑),收敛到这里。
 *
 * 两种语义保留(调用方依赖):
 *   parseCustomerRefFromPath(path)  —— 无匹配返回 null(路径版调用方 `if(!ref) return null`)
 *   parseCustomerRefFromTask(task)  —— 无匹配返回 {workspaceKey:'', customerId:''}(任务版 `if(!ws||!id) continue`)
 */

const CUSTOMER_ID_RE = /^CL\d{8}-\d{3,4}$/;

function splitParts(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCustomerRefFromPath(sourceOriginalPath) {
  const parts = splitParts(sourceOriginalPath);
  const idx = parts.findIndex((part) => CUSTOMER_ID_RE.test(part));
  if (idx < 0) return null;
  return {
    workspaceKey: idx > 0 ? parts[idx - 1] : '',
    customerId: parts[idx],
  };
}

function parseCustomerRefFromTask(task = {}) {
  const parts = splitParts(task.sourceOriginalPath);
  const sourceFolderName = String(task.sourceFolderName || '').trim();
  const sourceFolderPath = String(task.sourceFolderPath || '').trim();
  const customerId = parts.find((part) => CUSTOMER_ID_RE.test(part))
    || (CUSTOMER_ID_RE.test(sourceFolderName) ? sourceFolderName : '')
    || (CUSTOMER_ID_RE.test(sourceFolderPath) ? sourceFolderPath : '');
  const idx = parts.indexOf(customerId);
  return {
    workspaceKey: idx > 0 ? parts[idx - 1] : '',
    customerId,
  };
}

module.exports = { CUSTOMER_ID_RE, parseCustomerRefFromPath, parseCustomerRefFromTask };
