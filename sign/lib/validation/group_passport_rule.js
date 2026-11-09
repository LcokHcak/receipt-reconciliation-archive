'use strict';

/**
 * 客户组"护照数量"校验的单一真相源(2026-07-13 百货同框护照 bug)。
 *
 * 背景:结算/台账导入/自动确认三处各写一遍「护照必须恰好 1 本」,但**乐天百货是护照+小票
 * 同框(combined:true,整图不切)**——护照信息直接落在小票任务上(passportNoFinal/英文名),
 * 一个百货组常见 0 独立护照任务 → 三处校验全部误报「本组护照不是 1 本」把百货组卡死结算。
 *
 * 口径:
 *   - 普通(免税店)组:必须恰好 1 个独立护照任务(0 填不了护照字段;2 会取错)。
 *   - 百货组(任一小票 store 为 *_DEPT):护照可落在百货小票任务上——
 *       0 独立护照 + 百货小票自带 passportNo/英文名 → 合格;
 *       1 独立护照 → 合格;2+ 独立护照 → 仍拦(取错)。
 *
 * 台账桥(workbench_ledger_bridge_service)写库时本就 fallback 到小票任务的 passportNoFinal,
 * 数据路径早已正确,只差这道闸放行。
 */

const { isDeptStore, isPassportFreeDeptStore } = require('../store_profiles');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function storeOf(task) {
  return clean(task && (task.receiptStoreFinal || task.receiptStoreAuto));
}

function receiptCarriesPassport(task) {
  return Boolean(clean(task && (task.passportNoFinal || task.passportNoAuto))
    || clean(task && (task.extractedNameFinal || task.extractedNameAuto)));
}

// 传入已按 docType 过滤且已剔除重拍的护照/小票任务数组。
// 返回 '' = 合格;'invalid_passport_count' = 护照数量不合规。
function groupPassportIssue({ passportTasks = [], receiptTasks = [] } = {}) {
  const passports = Array.isArray(passportTasks) ? passportTasks : [];
  const receipts = Array.isArray(receiptTasks) ? receiptTasks : [];
  const isDeptGroup = receipts.some((t) => isDeptStore(storeOf(t)));

  if (isDeptGroup) {
    if (passports.length > 1) return 'invalid_passport_count'; // 2+ 独立护照仍会取错
    if (passports.length === 1) return '';
    // 0 独立护照(2026-07-14 用户拍板 + 复核HIGH#1细化到店):
    //   纯百货组 & 全是免护照店(新世界/现代,票面本就无护照,档案旗标 passportFree)→ 整组放行;
    //   乐天百货在场:同框票身份必须兜底(有一张带身份即可,桥接 donor 向兄弟票传播)——
    //   否则乐天交付包双图(护照图)导不出,一个客户会堵死整批次交付 zip。
    const pureDept = receipts.length > 0 && receipts.every((t) => isDeptStore(storeOf(t)));
    if (pureDept) {
      if (receipts.every((t) => isPassportFreeDeptStore(storeOf(t)))) return '';
      return receipts.some((t) => receiptCarriesPassport(t)) ? '' : 'invalid_passport_count';
    }
    //   混合组(百货+免税小票同组):免税部分离不开护照,仍要求百货票自带护照信息兜底
    return receipts.some((t) => isDeptStore(storeOf(t)) && receiptCarriesPassport(t))
      ? ''
      : 'invalid_passport_count';
  }

  return passports.length === 1 ? '' : 'invalid_passport_count';
}

// 前端/展示层用:该组的护照是否"齐"(独立护照任务 或 百货小票自带)。
function groupHasPassport({ passportTasks = [], receiptTasks = [] } = {}) {
  return groupPassportIssue({ passportTasks, receiptTasks }) === '';
}

// 百货同框护照的"身份捐赠者"(2026-07-13,修 reviewer HIGH):
// 组内无独立护照任务时,护照身份可能只落在其中一张百货小票上(另一张没读到护照角)。
// 从整组任务里找**另一张**带护照信息的百货小票,给当前票补全空身份字段——
// 与 groupPassportIssue"组内有一张即合格"口径对齐,防兄弟票静默落库空身份。
// 传入整组任务(护照+小票混合均可):护照任务无 receiptStore→isDeptStore false 自然排除;
// 只命中"店家为百货 且 自带 passportNo/英文名"的小票。excludeTask 排除当前票自身。
function findDeptPassportDonor(tasks = [], excludeTask = null) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.find((t) => t && t !== excludeTask
    && isDeptStore(storeOf(t)) && receiptCarriesPassport(t)) || null;
}

module.exports = { groupPassportIssue, groupHasPassport, findDeptPassportDonor };
