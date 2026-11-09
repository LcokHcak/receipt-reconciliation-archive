'use strict';

const { MODE_FOLDERS, isModeFolder } = require('../../lib/monthly/mode_folder_constants');

class MergeBlockedError extends Error {
  constructor({ reason, message, details = {} }) {
    super(message || reason);
    this.name = 'MergeBlockedError';
    this.code = 'MERGE_BLOCKED';
    this.reason = reason;
    this.details = details;
    this.statusCode = 400;
  }
}

function createModeConfigService({
  workspaceService,
  workspaceRepo,
  modeDeductConfigRepo,
  modeFolderMappingRepo,
  modeFolderApplyService = null,
}) {
  if (!workspaceService || !workspaceRepo || !modeDeductConfigRepo || !modeFolderMappingRepo) {
    throw new Error('mode_config_service: missing dependencies');
  }

  function normalizeKey(workspaceKey) {
    return workspaceService.parseKey(workspaceKey).key;
  }

  function getWorkspace(workspaceKey) {
    return workspaceService.getOrThrow(normalizeKey(workspaceKey));
  }

  function getDeductConfig(workspaceKey) {
    const workspace = getWorkspace(workspaceKey);
    const rowsByFolder = new Map(
      modeDeductConfigRepo.listByWorkspace(workspace.workspaceKey)
        .map((row) => [row.modeFolder, row])
    );
    return {
      workspaceKey: workspace.workspaceKey,
      isTestMode: workspaceService.isTestWorkspace(workspace.workspaceKey),
      confirmedAt: workspace.deductConfigConfirmedAt,
      rows: MODE_FOLDERS.map((folder) => rowsByFolder.get(folder) || {
        workspaceKey: workspace.workspaceKey,
        modeFolder: folder,
        deductValue: null,
        confirmedAt: null,
        updatedBy: null,
        updatedAt: null,
      }),
    };
  }

  function updateDeductConfig({ workspaceKey, rows, confirm = false, operator = null }) {
    const workspace = getWorkspace(workspaceKey);
    const normalizedRows = normalizeDeductRows(rows);
    const now = new Date().toISOString();
    modeDeductConfigRepo.upsertRows({
      workspaceKey: workspace.workspaceKey,
      rows: normalizedRows,
      updatedBy: operator,
      updatedAt: now,
    });
    workspaceRepo.updateDeductConfigConfirmedAt({
      workspaceKey: workspace.workspaceKey,
      confirmedAt: null,
      updatedAt: now,
    });
    if (confirm) {
      const missing = listMissingDeductFolders(workspace.workspaceKey);
      if (missing.length > 0) {
        throw createConfigError({
          reason: 'deduct_value_missing',
          message: `扣点表 [${missing.join(', ')}] 未填写,无法确认`,
          details: { missing_folders: missing },
        });
      }
      workspaceRepo.updateDeductConfigConfirmedAt({
        workspaceKey: workspace.workspaceKey,
        confirmedAt: now,
        updatedAt: now,
      });
    }
    return getDeductConfig(workspace.workspaceKey);
  }

  function copyDeductFromPrevious({ workspaceKey, operator = null }) {
    const workspace = getWorkspace(workspaceKey);
    const previousKey = previousWorkspaceKey(workspace.workspaceKey);
    const prevRows = modeDeductConfigRepo.listByWorkspace(previousKey)
      .filter((row) => row.deductValue != null)
      .map((row) => ({ modeFolder: row.modeFolder, deductValue: row.deductValue }));
    const now = new Date().toISOString();
    if (prevRows.length > 0) {
      modeDeductConfigRepo.upsertRows({
        workspaceKey: workspace.workspaceKey,
        rows: prevRows,
        updatedBy: operator,
        updatedAt: now,
      });
    }
    workspaceRepo.updateDeductConfigConfirmedAt({
      workspaceKey: workspace.workspaceKey,
      confirmedAt: null,
      updatedAt: now,
    });
    return { ...getDeductConfig(workspace.workspaceKey), copied: prevRows.length };
  }

  function getModeMapping(workspaceKey) {
    const workspace = getWorkspace(workspaceKey);
    return {
      workspaceKey: workspace.workspaceKey,
      isTestMode: workspaceService.isTestWorkspace(workspace.workspaceKey),
      confirmedAt: workspace.modeMappingConfirmedAt,
      items: modeFolderMappingRepo.listByWorkspace(workspace.workspaceKey),
      unmapped: modeFolderMappingRepo.listUnmapped(workspace.workspaceKey),
    };
  }

  function updateModeMapping({ workspaceKey, mappings, confirm = false, operator = null }) {
    const workspace = getWorkspace(workspaceKey);
    const rows = normalizeMappingRows(mappings);
    const now = new Date().toISOString();
    modeFolderMappingRepo.upsertRows({
      workspaceKey: workspace.workspaceKey,
      rows,
      updatedBy: operator,
      updatedAt: now,
    });
    workspaceRepo.updateModeMappingConfirmedAt({
      workspaceKey: workspace.workspaceKey,
      confirmedAt: null,
      updatedAt: now,
    });
    if (confirm) {
      const unmapped = modeFolderMappingRepo.listUnmapped(workspace.workspaceKey);
      if (unmapped.length === 0) {
        workspaceRepo.updateModeMappingConfirmedAt({
          workspaceKey: workspace.workspaceKey,
          confirmedAt: now,
          updatedAt: now,
        });
      }
    }
    const refreshStats = refreshDailyModeFolders(workspace.workspaceKey);
    return {
      ...getModeMapping(workspace.workspaceKey),
      dailyRowsRefreshed: refreshStats.updated,
      dailyRowsRefreshStats: refreshStats,
    };
  }

  function copyModeMappingFromPrevious({ workspaceKey, operator = null }) {
    const workspace = getWorkspace(workspaceKey);
    const previousKey = previousWorkspaceKey(workspace.workspaceKey);
    const prevRows = modeFolderMappingRepo.listByWorkspace(previousKey)
      .map((row) => ({ modeRaw: row.modeRaw, modeFolder: row.modeFolder }));
    const now = new Date().toISOString();
    if (prevRows.length > 0) {
      modeFolderMappingRepo.upsertRows({
        workspaceKey: workspace.workspaceKey,
        rows: prevRows,
        updatedBy: operator,
        updatedAt: now,
      });
    }
    workspaceRepo.updateModeMappingConfirmedAt({
      workspaceKey: workspace.workspaceKey,
      confirmedAt: null,
      updatedAt: now,
    });
    const refreshStats = refreshDailyModeFolders(workspace.workspaceKey);
    return {
      ...getModeMapping(workspace.workspaceKey),
      copied: prevRows.length,
      dailyRowsRefreshed: refreshStats.updated,
      dailyRowsRefreshStats: refreshStats,
    };
  }

  function validateMergeReady(workspaceKey) {
    const workspace = getWorkspace(workspaceKey);
    if (!workspace.deductConfigConfirmedAt) {
      throw new MergeBlockedError({
        reason: 'deduct_config_not_confirmed',
        message: '扣点表未确认,无法 merge',
      });
    }
    const missing = listMissingDeductFolders(workspace.workspaceKey);
    if (missing.length > 0) {
      throw new MergeBlockedError({
        reason: 'deduct_value_missing',
        message: `扣点表 [${missing.join(', ')}] 未填写,无法 merge`,
        details: { missing_folders: missing },
      });
    }
    if (!workspace.modeMappingConfirmedAt) {
      throw new MergeBlockedError({
        reason: 'mode_mapping_not_confirmed',
        message: '模式归类未确认,无法 merge',
      });
    }
    const unmapped = modeFolderMappingRepo.listUnmapped(workspace.workspaceKey);
    if (unmapped.length > 0) {
      throw new MergeBlockedError({
        reason: 'mode_mapping_incomplete',
        message: `仍有 ${unmapped.length} 个模式未归类,无法 merge`,
        details: { unmapped_modes: unmapped },
      });
    }
  }

  function listMissingDeductFolders(workspaceKey) {
    const rows = new Map(
      modeDeductConfigRepo.listByWorkspace(workspaceKey)
        .map((row) => [row.modeFolder, row])
    );
    return MODE_FOLDERS.filter((folder) => rows.get(folder)?.deductValue == null);
  }

  function refreshDailyModeFolders(workspaceKey) {
    if (!modeFolderApplyService) {
      return { totalScanned: 0, updated: 0, unchanged: 0, blank: 0 };
    }
    return modeFolderApplyService.applyToWorkspace(workspaceKey);
  }

  return {
    getDeductConfig,
    updateDeductConfig,
    copyDeductFromPrevious,
    getModeMapping,
    updateModeMapping,
    copyModeMappingFromPrevious,
    validateMergeReady,
  };
}

function normalizeDeductRows(rows) {
  if (!Array.isArray(rows)) {
    throw createConfigError({ reason: 'invalid_payload', message: 'rows must be an array' });
  }
  return rows.map((row) => {
    const modeFolder = String(row?.mode_folder ?? row?.modeFolder ?? '').trim();
    if (!isModeFolder(modeFolder)) {
      throw createConfigError({ reason: 'invalid_mode_folder', message: `invalid mode_folder: ${modeFolder}` });
    }
    const rawValue = row?.deduct_value ?? row?.deductValue;
    if (rawValue == null || rawValue === '') {
      return { modeFolder, deductValue: null };
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw createConfigError({ reason: 'invalid_deduct_value', message: `invalid deduct_value: ${rawValue}` });
    }
    return { modeFolder, deductValue: Number(value.toFixed(4)) };
  });
}

function normalizeMappingRows(rows) {
  if (!Array.isArray(rows)) {
    throw createConfigError({ reason: 'invalid_payload', message: 'mappings must be an array' });
  }
  return rows.map((row) => {
    const modeRaw = String(row?.mode_raw ?? row?.modeRaw ?? '').trim();
    if (!modeRaw) {
      throw createConfigError({ reason: 'invalid_mode_raw', message: 'mode_raw is required' });
    }
    const rawFolder = row?.mode_folder ?? row?.modeFolder;
    if (rawFolder == null || rawFolder === '') return { modeRaw, modeFolder: null };
    const modeFolder = String(rawFolder).trim();
    if (!isModeFolder(modeFolder)) {
      throw createConfigError({ reason: 'invalid_mode_folder', message: `invalid mode_folder: ${modeFolder}` });
    }
    return { modeRaw, modeFolder };
  });
}

function previousWorkspaceKey(workspaceKey) {
  const m = /^(demo-)?(\d{4})-(\d{2})$/.exec(String(workspaceKey || '').trim());
  if (!m) throw new Error(`invalid workspaceKey: ${workspaceKey}`);
  let year = Number(m[2]);
  let month = Number(m[3]) - 1;
  if (month < 1) {
    year -= 1;
    month = 12;
  }
  return `${m[1] || ''}${year}-${String(month).padStart(2, '0')}`;
}

function createConfigError({ reason, message, details = {} }) {
  const error = new Error(message || reason);
  error.code = 'MODE_CONFIG_INVALID';
  error.reason = reason;
  error.details = details;
  error.statusCode = 400;
  return error;
}

module.exports = {
  createModeConfigService,
  MergeBlockedError,
  previousWorkspaceKey,
};
