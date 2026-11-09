const crypto = require('node:crypto');
const path = require('node:path');

const ROOT_SOURCE_GROUP_KEY = '__root__';
const ROOT_SOURCE_GROUP_LABEL = '根目录';

function normalizeUploadRelativePath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..');

  return normalized.join('/');
}

function splitUploadRelativePath(value) {
  const normalizedPath = normalizeUploadRelativePath(value);
  if (!normalizedPath) {
    return {
      normalizedPath: '',
      folderPath: '',
      fileName: '',
    };
  }

  const parsed = path.posix.parse(normalizedPath);
  return {
    normalizedPath,
    folderPath: parsed.dir || '',
    fileName: parsed.base || '',
  };
}

function normalizeUploadManifestEntries(value) {
  let parsedValue = value;
  if (Array.isArray(parsedValue) && parsedValue.length === 1 && typeof parsedValue[0] === 'string') {
    [parsedValue] = parsedValue;
  }

  if (typeof parsedValue === 'string') {
    try {
      parsedValue = JSON.parse(parsedValue);
    } catch (_error) {
      return [];
    }
  }

  if (!Array.isArray(parsedValue)) {
    return [];
  }

  return parsedValue.map((entry) => ({
    relativePath: normalizeUploadRelativePath(entry?.relativePath || ''),
    fileName: String(entry?.fileName || entry?.name || '').trim(),
  }));
}

function resolveUploadedRelativePath(file, manifestEntries = [], index = -1) {
  const manifestEntry = Number.isInteger(index) && index >= 0 ? manifestEntries[index] : null;
  const manifestPath = normalizeUploadRelativePath(manifestEntry?.relativePath || '');
  if (manifestPath) {
    return manifestPath;
  }

  return normalizeUploadRelativePath(file?.originalname || '');
}

function detectImportRootFolder(values) {
  const normalizedPaths = Array.isArray(values)
    ? values.map(normalizeUploadRelativePath).filter(Boolean)
    : [];

  if (!normalizedPaths.length) {
    return '';
  }

  const segmentsList = normalizedPaths.map((item) => item.split('/'));
  const hasNestedGroupFolder = segmentsList.some((segments) => segments.length >= 3);
  if (!hasNestedGroupFolder) {
    return '';
  }

  const [firstSegment = ''] = segmentsList[0];
  if (!firstSegment) {
    return '';
  }

  return segmentsList.every((segments) => segments[0] === firstSegment) ? firstSegment : '';
}

function deriveSourceGroupFolderPath(value, importRootFolder = '') {
  const { folderPath } = splitUploadRelativePath(value);
  if (!folderPath) {
    return '';
  }

  const folderSegments = folderPath.split('/').filter(Boolean);
  if (!folderSegments.length) {
    return '';
  }

  const rootSegments = normalizeUploadRelativePath(importRootFolder)
    .split('/')
    .filter(Boolean);

  const hasRootPrefix = rootSegments.length > 0
    && rootSegments.every((segment, index) => folderSegments[index] === segment);

  const groupSegments = hasRootPrefix
    ? folderSegments.slice(rootSegments.length)
    : folderSegments;

  return groupSegments[0] || '';
}

function buildSourceGroupKey(folderPath) {
  const normalizedFolder = normalizeUploadRelativePath(folderPath);
  if (!normalizedFolder) {
    return ROOT_SOURCE_GROUP_KEY;
  }

  return `group_${crypto.createHash('sha1').update(normalizedFolder).digest('hex').slice(0, 12)}`;
}

function buildSourceGroupLabel(folderPath) {
  const normalizedFolder = normalizeUploadRelativePath(folderPath);
  if (!normalizedFolder) {
    return ROOT_SOURCE_GROUP_LABEL;
  }

  const segments = normalizedFolder.split('/');
  return segments[segments.length - 1] || ROOT_SOURCE_GROUP_LABEL;
}

// 组级团号确认(确认站,2026-07-10):人工确认的团号+模式,是后续回执/分车道审核的真相源。
// status: ''(未确认)/confirmed/exempt(百货/机场/无小票豁免)/deferred(送补救)/mixed(真多团)/pending_table(表外待核)
// source: majority(多数票)/single_matched(单票命中)/prior(当日先验)/fuzzy(近似采用)/manual(手填)
function normalizeTourConfirm(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    status: String(value.status || ''),
    tourNo: String(value.tourNo || ''),
    mode: String(value.mode || ''),
    source: String(value.source || ''),
    // basis:确认依据快照(候选清单/票数/先验命中/代理比对),审计用,结构自由。
    basis: value.basis && typeof value.basis === 'object' ? value.basis : null,
    confirmedBy: String(value.confirmedBy || ''),
    confirmedAt: String(value.confirmedAt || ''),
    respondedAt: String(value.respondedAt || ''),
    // 修订史:每次撤销/更正把旧确认推进来,留痕。
    revisions: Array.isArray(value.revisions) ? value.revisions : [],
  };
}

function createSourceGroup(overrides = {}) {
  const folderPath = normalizeUploadRelativePath(overrides.folderPath || '');
  return {
    key: overrides.key || buildSourceGroupKey(folderPath),
    folderPath,
    label: String(overrides.label || buildSourceGroupLabel(folderPath)).trim() || ROOT_SOURCE_GROUP_LABEL,
    attachmentFiles: Array.isArray(overrides.attachmentFiles)
      ? overrides.attachmentFiles.map((item) => ({
          id: String(item?.id || '').trim(),
          originalFileName: String(item?.originalFileName || '').trim(),
          storedRelativePath: String(item?.storedRelativePath || '').trim(),
          extension: String(item?.extension || '').trim().toLowerCase(),
        }))
      : [],
    // 组级结算状态(P2 实时队列/代理视图):结算成功/确认模式时盖章,刷新不丢。
    // ⚠️铁律:sourceGroups 加字段必须同步进这张白名单——normalizeSourceGroups 只保留这里列的字段,
    // 漏了则存盘即抹(2026-07 批次 owner 隐形 bug 同款教训)。
    settledAt: String(overrides.settledAt || ''),
    settlementStatus: String(overrides.settlementStatus || ''),
    // 组级团号确认(确认站):进白名单,刷新/存盘不丢。无确认=null。
    tourConfirm: normalizeTourConfirm(overrides.tourConfirm),
    // 台账订正留痕(2026-07-21 订正通道;8模块审计 HIGH:漏白名单=存盘即抹,证据链断):
    // 只保结构化字段,快照按原样保留(admin 操作低频,体积可控)。
    ledgerCorrections: Array.isArray(overrides.ledgerCorrections)
      ? overrides.ledgerCorrections.map((c) => ({
          at: String(c?.at || ''),
          by: String(c?.by || ''),
          reason: String(c?.reason || ''),
          removedRows: Number(c?.removedRows || 0),
          workspaces: Array.isArray(c?.workspaces) ? c.workspaces.map(String) : [],
          snapshot: Array.isArray(c?.snapshot) ? c.snapshot : [],
        }))
      : [],
  };
}

// 组级结算状态盖章:结算/确认模式成功后,给 batch.sourceGroups 里对应组写 settledAt+settlementStatus。
// 返回是否命中(未找到组=历史批次无 sourceGroups,静默跳过不报错)。
function stampGroupSettlement(batch, groupKey, { settlementStatus = '', settledAt = '' } = {}) {
  const key = String(groupKey || '').trim();
  if (!key || !Array.isArray(batch?.sourceGroups)) return false;
  const group = batch.sourceGroups.find((g) => String(g?.key || '').trim() === key);
  if (!group) return false;
  const status = String(settlementStatus || '');
  group.settlementStatus = status;
  // no_receipts(纯护照/0小票组结算=零台账行,deriveSettlementStatus 唯一来源):记状态供 UI,
  // 但绝不盖 settledAt——settledAt 一旦有值,删票/删组/删批次守卫全 409 锁死,而台账订正
  // correctGroupLedger 又因零行拒绝(LEDGER_CORRECTION_NO_ROWS)→ 组永久卡死无清理通道
  // (8模块审计 MEDIUM)。零台账行本就没有台账证据要保护,应可正常删/订正。
  group.settledAt = status === 'no_receipts' ? '' : (settledAt || new Date().toISOString());
  return true;
}

// 台账侧订正(2026-07-21 交付修改#10「删不掉」):撤销组级结算盖章,组回到可编辑/可删状态。
// stampGroupSettlement 的空 settledAt 会被 || new Date() 顶回去,清章必须走这里。
// correction 留痕(who/when/why/删了几行台账)直接落组 meta——审计日志之外的第二证据链;
// 历史订正推进 ledgerCorrections 数组,多次订正不互相覆盖。
function clearGroupSettlement(batch, groupKey, correction = null) {
  const key = String(groupKey || '').trim();
  if (!key || !Array.isArray(batch?.sourceGroups)) return false;
  const group = batch.sourceGroups.find((g) => String(g?.key || '').trim() === key);
  if (!group) return false;
  group.settlementStatus = '';
  group.settledAt = '';
  if (correction && typeof correction === 'object') {
    const history = Array.isArray(group.ledgerCorrections) ? group.ledgerCorrections : [];
    group.ledgerCorrections = [...history, { ...correction, at: correction.at || new Date().toISOString() }];
  }
  return true;
}

// 组级团号确认盖章(确认站):照 stampGroupSettlement 先例。keepRevisions=true 时把当前确认
// 推进 revisions 再覆盖(撤销/更正用),否则沿用旧修订史。返回是否命中组。
function stampGroupTourConfirm(batch, groupKey, tourConfirm, { keepRevisions = true } = {}) {
  const key = String(groupKey || '').trim();
  if (!key || !Array.isArray(batch?.sourceGroups)) return false;
  const group = batch.sourceGroups.find((g) => String(g?.key || '').trim() === key);
  if (!group) return false;
  const previous = normalizeTourConfirm(group.tourConfirm);
  const next = normalizeTourConfirm(tourConfirm) || null;
  if (next && keepRevisions && previous && previous.status) {
    const history = Array.isArray(previous.revisions) ? previous.revisions : [];
    next.revisions = [...history, { ...previous, revisions: undefined }];
  }
  group.tourConfirm = next;
  return true;
}

function normalizeSourceGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }

  return groups.map((group) => createSourceGroup(group));
}

function upsertSourceGroup(batch, folderPath) {
  const normalizedFolder = normalizeUploadRelativePath(folderPath);
  const groups = normalizeSourceGroups(batch.sourceGroups || []);
  const existing = groups.find((group) => group.folderPath === normalizedFolder);
  if (existing) {
    batch.sourceGroups = groups;
    return existing;
  }

  const created = createSourceGroup({ folderPath: normalizedFolder });
  groups.push(created);
  batch.sourceGroups = groups;
  return created;
}

module.exports = {
  ROOT_SOURCE_GROUP_KEY,
  ROOT_SOURCE_GROUP_LABEL,
  buildSourceGroupKey,
  buildSourceGroupLabel,
  createSourceGroup,
  deriveSourceGroupFolderPath,
  detectImportRootFolder,
  normalizeUploadManifestEntries,
  normalizeSourceGroups,
  normalizeUploadRelativePath,
  resolveUploadedRelativePath,
  splitUploadRelativePath,
  stampGroupSettlement,
  clearGroupSettlement,
  stampGroupTourConfirm,
  normalizeTourConfirm,
  upsertSourceGroup,
};
