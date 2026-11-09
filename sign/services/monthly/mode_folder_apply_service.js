'use strict';

const { classifyModeFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { getStoreProfile, FAMILY } = require('../../lib/store_profiles');
const { normalizeStoreFamily } = require('../../lib/validation/field_rules');

// 百货模式常量('乐天百货/新世界百货/现代百货',P4 桥接注入,恒 matched 不走团号匹配):
// 模式串含"百货"关键词 → normalizeStoreFamily 认成 dept 家族。
function isDeptModeRaw(modeRaw) {
  return getStoreProfile(normalizeStoreFamily(modeRaw)).family === FAMILY.DEPT;
}

function createModeFolderApplyService({ dailyReceiptRepo, modeFolderMappingRepo }) {
  if (!dailyReceiptRepo || !modeFolderMappingRepo) {
    throw new Error('mode_folder_apply_service: missing dependencies');
  }

  function applyToWorkspace(workspaceKey) {
    const explicitMappings = new Map();
    for (const row of modeFolderMappingRepo.listByWorkspace(workspaceKey)) {
      const modeRaw = normalizeModeRaw(row.modeRaw);
      if (modeRaw) explicitMappings.set(modeRaw, row.modeFolder || null);
    }

    const rows = dailyReceiptRepo.listForModeFolderRefresh(workspaceKey);
    const updates = [];
    let blank = 0;
    let unchanged = 0;
    let statusPromoted = 0; // skipped_mode_not_required → matched
    let statusDemoted = 0;  // matched → skipped_mode_not_required

    for (const row of rows) {
      const modeRaw = normalizeModeRaw(row.modeRaw);
      if (!modeRaw) {
        blank += 1;
        unchanged += 1;
        continue;
      }
      const nextFolder = explicitMappings.has(modeRaw)
        ? explicitMappings.get(modeRaw)
        : classifyModeFolder({ modeRaw });
      const currentFolder = row.modeFolder || null;
      const currentStatus = row.tourMatchStatus || null;

      // 清单 #5: 只有"纯模式跳过"(skipped_mode_not_required)与 matched 之间
      // 可随用户勾选互转。其余状态(待补救 agent_mismatch/date_out_of_window
      // /tour_not_found/tour_ambiguous/tour_store_mismatch/pending)不碰,避免绕过日期/代理校验。
      let nextStatus = null; // null = 不改状态
      if (nextFolder && currentStatus === 'skipped_mode_not_required') {
        nextStatus = 'matched';
      } else if (!nextFolder && currentStatus === 'matched' && !isDeptModeRaw(modeRaw)) {
        // 取消归类 → 退回"模式不参加"。
        // ⚠️百货例外(P4):百货行 matched 是桥接直标的(模式=店名常量,天然无 -本司 归类
        // 也无需 mapping),这里若不豁免,操作员任何一次"模式归类"确认都会把百货行
        // 打回 skipped —— 僵尸行换个路径复活。百货行状态不参与本互转。
        nextStatus = 'skipped_mode_not_required';
      }

      const folderChanged = currentFolder !== (nextFolder || null);
      const statusChanged = nextStatus != null && nextStatus !== currentStatus;
      if (!folderChanged && !statusChanged) {
        unchanged += 1;
        continue;
      }
      const update = { id: row.id, modeFolder: nextFolder || null };
      if (statusChanged) {
        update.tourMatchStatus = nextStatus;
        if (nextStatus === 'matched') statusPromoted += 1; else statusDemoted += 1;
      }
      updates.push(update);
    }

    const changed = updates.length
      ? dailyReceiptRepo.updateModeFolderBulk({ workspaceKey, updates })
      : 0;

    return {
      totalScanned: rows.length,
      updated: Number(changed || 0),
      unchanged,
      blank,
      statusPromoted,
      statusDemoted,
    };
  }

  return { applyToWorkspace };
}

function normalizeModeRaw(value) {
  return String(value || '').trim();
}

module.exports = { createModeFolderApplyService };
