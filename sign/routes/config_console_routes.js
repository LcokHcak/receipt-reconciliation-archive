'use strict';

/**
 * config_console_routes — 配置台 P1 管理 API(admin only,2026-07-14)。
 *
 * 端点(全部 /api/admin/config/*):
 *   GET  /api/admin/config/modes                 总览:出厂∪已配置 + 团号表覆盖率
 *   GET  /api/admin/config/modes/:name/versions  版本流水(修改日志)
 *   POST /api/admin/config/modes/:name           保存新版本(保存即生效;乐观锁 409)
 *   POST /api/admin/config/modes/:name/activate  激活历史版本(一键回滚)
 *   POST /api/admin/config/modes/:name/deactivate 停用(回落出厂,历史保留)
 *
 * 语义(docs/配置台架构设计_2026-07-14.md):
 *   - 保存=INSERT 新版本,修改日志=版本流水;删除=停用(软删);
 *   - 硬校验不过(validateModeConfig)→ 400 拒存;软警告随响应返回,不拦;
 *   - 名称一律 normalizeModeName 归一(团号表拼写漂移的前科);
 *   - 所有写操作进 audit_log(操作人/动作/详情)。
 */

const { authenticateToken: createAuthenticateToken } = require('../lib/auth/jwt_middleware');
const { MATRIX, normalizeModeName, resolveCanonicalModeName } = require('../lib/mode_record_matrix');
const { validateModeConfig } = require('../services/mode_config_resolver');
const {
  validateExportPlan,
  resolveExportPlan,
  buildCustomerGroups,
  listTemplateTokens,
  tokenRequirement,
  EXCEL_COLUMN_DEFS,
} = require('../lib/export_plan_engine');
const {
  validateReviewBase,
  validateStoreFields,
  validateBranchOptions,
  BASE_FIELD_KEYS,
  DEPT_FIELD_VOCAB,
} = require('../services/review_config_resolver');
const { DOC_TYPE_FIELD_RULES: FACTORY_FIELD_RULES } = require('../lib/workbench_definition');
const { validateStoreFamily } = require('../lib/validation/field_rules');
const { getStoreProfile, FAMILY } = require('../lib/store_profiles');
const { FIELD_REGISTRY } = require('../lib/field_registry');
const {
  planRowsForList: registryPlanRows,
  activePlanPayload: registryActivePlanPayload,
} = require('../lib/export_plan_registry');
const { PROFILES: FACTORY_PROFILES } = require('../lib/store_profiles');
const fsForPreview = require('node:fs');
const pathPosix = require('node:path').posix;

function resolveTokenMiddleware(auth = {}) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  return null;
}

const DEPT_MODE_NAMES = Object.freeze(['乐天百货', '新世界百货', '现代百货']);

/**
 * 软警告(P1 冲突检查 v1):不拦保存,提醒配置的坑。
 * 硬冲突(导出字段审核台产不出)要等 P3 审核字段接配置后才有完整判据。
 */
function buildModeConfigWarnings(name, payload = {}) {
  const warnings = [];
  const columns = payload.columns || {};
  if (columns.receiptNo === false && String(payload.receiptNoForm || '')) {
    warnings.push('配了小票号形态但不记「小票号」列——形态不会生效,请勾选小票号列或清掉形态');
  }
  if (DEPT_MODE_NAMES.includes(name) && columns.groupNo === true) {
    warnings.push('百货模式无团号:「团号」列会导出为空(新世界/现代由导出借位在该列填金额)');
  }
  if (columns.recordDate === false && columns.agent === false) {
    warnings.push('收票日期与代理都不记:台账行将难以溯源,确认是上家要求再保存');
  }
  return warnings;
}

function factoryPayloadOf(row) {
  return {
    modeLabel: row.mode,
    columns: { ...row.columns },
    receiptNoForm: row.receiptNoForm || '',
    actions: [...(row.actions || [])],
    note: row.note || '',
    groupNoLiteral: row.groupNoLiteral || '',
  };
}

function createConfigConsoleRoutes({ modeConfigRepository, auditLogRepo = null, auth, listGroupCodeModes = null, previewDeps = null }) {
  if (!modeConfigRepository) throw new Error('config_console_routes: modeConfigRepository required');

  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware ? [tokenMiddleware] : [];

  function requireAdmin(req, res) {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '仅管理员可用配置台' });
      return false;
    }
    return true;
  }

  function audit(req, action, resourceId, details) {
    if (!auditLogRepo) return;
    try {
      auditLogRepo.log({
        userId: req.user?.username || req.user?.id || 'admin',
        action,
        resourceType: 'mode_config',
        resourceId,
        details,
      });
    } catch {
      // 审计失败不拦业务(与全局口径一致);配置本身的版本流水仍是完整日志
    }
  }

  // 乐观锁基版闸(审计 HIGH line 514):HTTP 写路径此前省略 expectBaseVersion 就把
  // saveNewVersion 的乐观锁整段跳过(expectBaseVersion=null=不检查),直接新版+激活,
  // 并发编辑静默互相覆盖。修:已有版本(base>0)却不带基版=覆盖风险→409 逼刷新;全新
  // 创建(base=0,无可覆盖)放行并以 0 作基版——0 仍会被 saveNewVersion 校验(并发创建时
  // 第二个 base 已=1≠0→409),故创建也受保护。seed 脚本直调 repo 传 null 不走这里,不受影响。
  // 返回:要用的基版数字;若已发出错误响应则返回 null(调用方据此提前 return)。
  function resolveWriteBaseVersion(req, res, kind, name) {
    const raw = req.body?.expectBaseVersion;
    if (raw === undefined || raw === null || raw === '') {
      const base = modeConfigRepository.currentMaxVersion(kind, name);
      if (base > 0) {
        res.status(409).json({
          error: `该配置已有 v${base},保存必须带 expectBaseVersion(乐观锁基版),请刷新后重试`,
          currentVersion: base,
        });
        return null;
      }
      return 0; // 全新创建:以 0 作基版
    }
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 0) {
      res.status(400).json({ error: 'expectBaseVersion 必须是非负整数' });
      return null;
    }
    return num;
  }

  function register(app) {
    // ── 总览:出厂 ∪ 已配置 + 团号表覆盖率 ────────────────────────────────
    app.get('/api/admin/config/modes', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const configured = new Map(
        modeConfigRepository.getAllActive('mode').map((row) => [row.name, row])
      );
      const factoryNames = new Set();
      const modes = MATRIX.map((row) => {
        const name = normalizeModeName(row.mode);
        factoryNames.add(name);
        const config = configured.get(name) || null;
        return {
          name,
          label: row.mode,
          source: config ? 'db' : 'factory',
          factory: factoryPayloadOf(row),
          config: config ? {
            version: config.version,
            payload: config.payload,
            createdAt: config.createdAt,
            createdBy: config.createdBy,
            note: config.note,
          } : null,
          warnings: config && config.payload ? buildModeConfigWarnings(name, config.payload) : [],
        };
      });
      // 配置台新建的、矩阵里没有的模式(纯 DB 模式)
      for (const [name, config] of configured) {
        if (factoryNames.has(name)) continue;
        modes.push({
          name,
          label: config.payload?.modeLabel || name,
          source: 'db',
          factory: null,
          config: {
            version: config.version,
            payload: config.payload,
            createdAt: config.createdAt,
            createdBy: config.createdBy,
            note: config.note,
          },
          warnings: config.payload ? buildModeConfigWarnings(name, config.payload) : [],
        });
      }
      // 覆盖率:团号表 distinct 模式串,归一后既不在出厂也没配置 → 走默认全记(要看得见)
      let unconfigured = [];
      if (typeof listGroupCodeModes === 'function') {
        try {
          const seen = new Set();
          for (const rawMode of listGroupCodeModes()) {
            const base = resolveCanonicalModeName(rawMode);
            if (!base || factoryNames.has(base) || configured.has(base) || seen.has(base)) continue;
            seen.add(base);
            unconfigured.push({ name: base, raw: String(rawMode) });
          }
        } catch {
          unconfigured = []; // 团号表不可读不拦配置台
        }
      }
      return res.json({ modes, unconfigured });
    });

    // ── 版本流水(修改日志)──────────────────────────────────────────────
    app.get('/api/admin/config/modes/:name/versions', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = resolveCanonicalModeName(req.params.name);
      return res.json({ name, versions: modeConfigRepository.listVersions('mode', name) });
    });

    // ── 保存新版本(保存即生效)──────────────────────────────────────────
    app.post('/api/admin/config/modes/:name', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = resolveCanonicalModeName(req.params.name);
      if (!name) return res.status(400).json({ error: '模式名不能为空' });
      const payload = req.body?.payload;
      const verdict = validateModeConfig(payload);
      if (!verdict.ok) {
        return res.status(400).json({ error: `配置不合法:${verdict.reason}` });
      }
      const expectBaseVersion = resolveWriteBaseVersion(req, res, 'mode', name);
      if (expectBaseVersion === null) return;
      try {
        const saved = modeConfigRepository.saveNewVersion({
          kind: 'mode',
          name,
          payload,
          createdBy: req.user?.username || req.user?.id || '',
          note: String(req.body?.note || ''),
          expectBaseVersion,
        });
        const warnings = buildModeConfigWarnings(name, payload);
        audit(req, 'config_save', name, { version: saved.version, note: req.body?.note || '', warnings });
        return res.json({ ok: true, name, version: saved.version, warnings });
      } catch (error) {
        if (error?.code === 'CONFIG_STALE') {
          return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
        }
        throw error;
      }
    });

    // ── 一键回滚(激活历史版本)──────────────────────────────────────────
    app.post('/api/admin/config/modes/:name/activate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = resolveCanonicalModeName(req.params.name);
      const version = Number(req.body?.version);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: 'version 必须是正整数' });
      }
      try {
        modeConfigRepository.activateVersion('mode', name, version);
      } catch (error) {
        if (error?.code === 'CONFIG_VERSION_NOT_FOUND') {
          return res.status(404).json({ error: error.message });
        }
        throw error;
      }
      audit(req, 'config_rollback', name, { version });
      return res.json({ ok: true, name, version });
    });

    // ── 停用=回落出厂(历史全保留)───────────────────────────────────────
    app.post('/api/admin/config/modes/:name/deactivate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = resolveCanonicalModeName(req.params.name);
      modeConfigRepository.deactivate('mode', name);
      audit(req, 'config_deactivate', name, {});
      return res.json({ ok: true, name, fallback: 'factory' });
    });
  }

  // ── P2:导出计划(kind='export_plan')────────────────────────────────
  // 内置=老 planner/导出服务引用(防第二真相源);DSL 计划走 lib/export_plan_engine。
  // 2026-07-16 资料库P0:清单实现抽到 lib/export_plan_registry(资料库交付页同源引用)。
  function extOfPath(value) {
    const m = String(value || '').match(/\.[A-Za-z0-9]+$/);
    return m ? m[0].toLowerCase() : '.jpg';
  }

  function planRowsForList() {
    return registryPlanRows(modeConfigRepository);
  }

  function activePlanPayload(name) {
    return registryActivePlanPayload(modeConfigRepository, name);
  }

  // 预览允许吃草稿(最新版本):硬冲突存成草稿后,修配置的人必须能预览验证;
  // **执行仍只认已启用**(activePlanPayload)——草稿永远不落盘。
  function previewPlanPayload(name) {
    const active = activePlanPayload(name);
    if (active) return active;
    const versions = modeConfigRepository.listVersions('export_plan', name);
    return versions[0]?.payload || null;
  }

  // ── 冲突检查 v2(P3b,硬判)─────────────────────────────────────────
  // 有效审核集:百货模式=店档案字段(配置优先);其他=小票基线 ∖ relax ∪ require + 护照基线。
  function effectiveSetsForMode(modeName) {
    const deptEntry = Object.entries(FACTORY_PROFILES)
      .find(([, profile]) => profile.family === 'dept' && profile.mode === modeName);
    const reviewResolver = previewDeps && previewDeps.reviewConfigResolver;
    if (deptEntry) {
      const [family, profile] = deptEntry;
      let fields;
      try { fields = reviewResolver?.getDeptFields?.(family) || null; } catch { fields = null; }
      const row = modeConfigRepository.getActive('store', family);
      return {
        isDept: true,
        deptFields: new Set(fields || profile.fields),
        passportFree: Boolean(row?.payload?.passportFree ?? profile.passportFree),
      };
    }
    let overlay;
    try { overlay = reviewResolver?.getModeReviewOverlay?.(modeName) || null; } catch { overlay = null; }
    const receipt = new Set(effectiveBaseKeys('receipt'));
    for (const key of overlay?.relax || []) receipt.delete(key);
    for (const key of overlay?.require || []) receipt.add(key);
    return { isDept: false, receipt, passport: new Set(effectiveBaseKeys('passport')) };
  }

  // 单个来源要求 vs 某模式有效集 → null(满足)| { severity, message, suggestion }
  function checkRequirement(requirement, sets, modeName) {
    if (requirement === 'system') return null;
    const [kind, key] = requirement.split(':');
    if (kind === 'dept') {
      if (!sets.isDept) return { severity: 'hard', message: `「${key}」仅百货有来源,模式「${modeName}」不是百货`, suggestion: '把计划范围限定到百货模式,或去掉该字段' };
      if (!sets.deptFields.has(key)) return { severity: 'hard', message: `店档案未勾「${key}」,审核台不产此值`, suggestion: '在该店档案勾选此字段' };
      return null;
    }
    if (kind === 'receipt-base') {
      if (sets.isDept) {
        const deptEquivalent = { receiptStoreFinal: 'ok', receiptNoFinal: 'receiptNo', purchaseDateFinal: 'purchaseDate' }[key];
        if (deptEquivalent === 'ok') return null;
        if (deptEquivalent) {
          return sets.deptFields.has(deptEquivalent) ? null
            : { severity: 'hard', message: `店档案未勾「${deptEquivalent}」`, suggestion: '在该店档案勾选此字段' };
        }
        return { severity: 'hard', message: `百货无「${key.replace('Final', '')}」(无团号/无出境日期)`, suggestion: '去掉该字段或限定到免税店模式' };
      }
      return sets.receipt.has(key) ? null
        : { severity: 'hard', message: `小票审核集未含「${key}」(基线或模式微调把它放宽了)`, suggestion: '在审核基线/模式微调里勾回该字段' };
    }
    if (kind === 'passport') {
      if (sets.isDept) {
        // 免护照店(新世界/现代,2026-07-17 拍板出厂去掉票级护照两项):票面本无护照,
        // 身份来自随行护照任务(组级传播)——不再按"店档案未勾"判硬,软提示即可;
        // 乐天百货(同框票,身份必须落票上)保持硬闸不变。
        if (sets.passportFree) {
          return { severity: 'soft', message: '该店免护照(passportFree),身份来自随行护照任务,票级字段可能为空', suggestion: '接受空值或要求随行护照' };
        }
        const deptKey = key === 'extractedNameFinal' ? 'extractedName' : 'passportNo';
        if (!sets.deptFields.has(deptKey)) return { severity: 'hard', message: `店档案未勾「${deptKey}」`, suggestion: '在该店档案勾选身份字段' };
        return null;
      }
      return sets.passport.has(key) ? null
        : { severity: 'hard', message: `护照基线未含「${key}」`, suggestion: '在审核基线(护照)勾回该字段' };
    }
    return null;
  }

  function planRequirements(plan) {
    if (plan.excel) return plan.excel.columns.map((key) => ({ field: EXCEL_COLUMN_DEFS[key].header, requirement: EXCEL_COLUMN_DEFS[key].need }));
    const tokens = new Set();
    for (const level of plan.levels || []) for (const token of listTemplateTokens(level.template)) tokens.add(token);
    for (const token of listTemplateTokens(plan.naming?.template || '')) tokens.add(token);
    return [...tokens].map((token) => ({ field: `{${token}}`, requirement: tokenRequirement(token) }));
  }

  /** 计划级冲突(保存/启用闸):对 scope 每个模式逐字段判;scope 空=按"非百货通用"判。 */
  function computePlanConflicts(plan) {
    if (plan.builtin) return [];
    const modes = (plan.scope?.modes || []).map((m) => resolveCanonicalModeName(m)).filter(Boolean);
    const targets = modes.length ? modes : ['(全部模式)'];
    const rows = [];
    for (const modeName of targets) {
      const sets = modes.length ? effectiveSetsForMode(modeName)
        : { isDept: false, receipt: new Set(effectiveBaseKeys('receipt')), passport: new Set(effectiveBaseKeys('passport')) };
      for (const { field, requirement } of planRequirements(plan)) {
        const hit = checkRequirement(requirement, sets, modeName);
        if (hit) rows.push({ mode: modeName, field, ...hit, type: hit.severity === 'hard' ? '导出缺少审核字段' : '字段可能为空' });
      }
      if (!modes.length) {
        // 通用计划用了百货字段:提示限定范围(dept 检查在上面已按非百货判成 hard)
      }
    }
    return rows;
  }

  // B6(2026-07-16 同步一致性审计):基线/店档案改动会漂移已启用计划的判据(冲突检查只在计划
  // save/activate 时跑,时序可绕过"硬冲突禁启用"闸;skip_log 策略的计划漂移后会静默跳票)。
  // 保存成功后只读复查全部 active 非内置计划,把硬冲突作为警告附在响应里(不拦保存)。
  function activePlanConflictWarnings() {
    const warnings = [];
    try {
      for (const row of modeConfigRepository.getAllActive('export_plan')) {
        const plan = row.payload;
        if (!plan || plan.builtin) continue;
        const hard = computePlanConflicts(plan).filter((c) => c.severity === 'hard');
        if (hard.length) {
          warnings.push({
            plan: row.name,
            hardConflicts: hard.length,
            sample: `${hard[0].mode}:${hard[0].field} ${hard[0].message}`,
          });
        }
      }
    } catch (err) {
      // 只读警告,失败不拦配置保存——但要留痕,否则这功能坏了永远没人发现
      try { require('../lib/request_logger').logger.warn('plan_conflict_warning_failed', { err: err?.message }); } catch { /* noop */ }
    }
    return warnings;
  }

  function registerExportPlans(app) {
    app.get('/api/admin/config/export-plans', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      return res.json({
        plans: planRowsForList(),
        vocab: {
          excelColumns: Object.entries(EXCEL_COLUMN_DEFS).map(([key, def]) => ({ key, header: def.header })),
          dslTokens: [
            { token: 'groupNo', label: '团号' }, { token: 'name', label: '姓名' },
            { token: 'passportNo', label: '护照号' }, { token: 'receiptNo', label: '小票号/交易编号' },
            { token: 'mode', label: '渠道模式' }, { token: 'purchaseDate', label: '购买日期' },
            { token: 'departureDate', label: '出境日期' }, { token: 'receiptAmount', label: '金额(百货)' },
            { token: 'branch', label: '门店(百货)' }, { token: 'brand', label: '品牌(百货)' },
            { token: 'upstream', label: '上家(百货)' }, { token: 'customerId', label: '客户号' },
            { token: 'docLabel', label: '件类(小票/护照)' }, { token: 'i', label: '序号' },
          ],
        },
      });
    });

    app.get('/api/admin/config/export-plans/:name/versions', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      return res.json({ name, versions: modeConfigRepository.listVersions('export_plan', name) });
    });

    app.post('/api/admin/config/export-plans/:name', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      if (!name) return res.status(400).json({ error: '计划名不能为空' });
      const payload = req.body && req.body.payload;
      const verdict = validateExportPlan(payload);
      if (!verdict.ok) return res.status(400).json({ error: `导出计划不合法:${verdict.reason}` });
      const expectBaseVersion = resolveWriteBaseVersion(req, res, 'export_plan', name);
      if (expectBaseVersion === null) return;
      // 冲突检查v2(拍板:硬冲突=禁启用,可存草稿)
      const conflicts = computePlanConflicts(payload);
      const hasHard = conflicts.some((c) => c.severity === 'hard');
      try {
        const saved = modeConfigRepository.saveNewVersion({
          kind: 'export_plan', name, payload,
          createdBy: (req.user && (req.user.username || req.user.id)) || '',
          note: String((req.body && req.body.note) || ''),
          expectBaseVersion,
          activate: !hasHard,
        });
        audit(req, 'export_plan_save', name, { version: saved.version, kindType: verdict.kind, savedAsDraft: hasHard });
        return res.json({ ok: true, name, version: saved.version, kindType: verdict.kind, savedAsDraft: hasHard, conflicts });
      } catch (error) {
        if (error && error.code === 'CONFIG_STALE') {
          return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
        }
        throw error;
      }
    });

    app.post('/api/admin/config/export-plans/:name/activate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      const version = Number(req.body && req.body.version);
      if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'version 必须是正整数' });
      // 启用前复查硬冲突(草稿修好审核勾选后才能启用)
      const targetRow = modeConfigRepository.listVersions('export_plan', name).find((v) => v.version === version);
      if (targetRow?.payload) {
        const conflicts = computePlanConflicts(targetRow.payload);
        if (conflicts.some((c) => c.severity === 'hard')) {
          return res.status(409).json({ error: '存在硬冲突,先按处理建议改审核勾选/计划字段再启用', conflicts });
        }
      }
      try {
        modeConfigRepository.activateVersion('export_plan', name, version);
      } catch (error) {
        if (error && error.code === 'CONFIG_VERSION_NOT_FOUND') return res.status(404).json({ error: error.message });
        throw error;
      }
      audit(req, 'export_plan_rollback', name, { version });
      return res.json({ ok: true, name, version });
    });

    app.post('/api/admin/config/export-plans/:name/deactivate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      modeConfigRepository.deactivate('export_plan', name);
      audit(req, 'export_plan_deactivate', name, {});
      return res.json({ ok: true, name });
    });

    // 冲突检查v2(模式视角):该模式**自定义**导出计划的逐字段体检。
    //
    // ⚠️ 2026-08-01 更正这行注释:原文写的是「该模式所有启用导出(**含内置**Excel列语义提示)」,
    // 而下面第一句就是 `if (plan.builtin) continue` —— 注释与代码说的是相反的事。
    // 而且就算删掉那句过滤也遍历不到内置:getAllActive 是纯 DB 查询,
    // 5 个内置计划是**代码里的出厂常量**(lib/export_plan_registry BUILTIN_PLANS),压根不在结果集里。
    //
    // 后果不在这一行,在界面上:绝大多数普通模式走的**就是**内置计划
    // (兜底规则③:「你团号表里没有专门导出计划的普通模式,交付时就落这条」),
    // 于是配置台那张表既不列出任何行、冲突区又永远渲染「…无冲突」——
    // 管理员把"根本没查"当成"查了没事"。
    //
    // 内置计划要不要真的参与检查,是**待拍板项**(见
    // ../系统交付修改/0801-你二十分钟能清掉的拍板清单.md 的 A3),这里先不改行为。
    // 但注释必须说实话:下一个人读到"含内置"会以为已经覆盖了,连查都不会去查。
    app.get('/api/admin/config/modes/:name/conflicts', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const modeName = resolveCanonicalModeName(req.params.name);
      const rows = [];
      for (const row of modeConfigRepository.getAllActive('export_plan')) {
        const plan = row.payload;
        if (!plan || plan.builtin) continue;
        const scoped = (plan.scope?.modes || []).map((m) => resolveCanonicalModeName(m));
        if (scoped.length && !scoped.includes(modeName)) continue;
        for (const c of computePlanConflicts({ ...plan, scope: { modes: [modeName] } })) {
          rows.push({ plan: row.name, ...c });
        }
      }
      return res.json({ ok: true, mode: modeName, conflicts: rows, hard: rows.filter((r) => r.severity === 'hard').length });
    });

    // P2.1 真落盘:DSL→zip / Excel→xlsx;单并发闸(导出重活,防并点)
    let executing = false;
    app.post('/api/admin/config/export-plans/:name/execute', ...protect, async (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      const plan = activePlanPayload(name);
      if (!plan) {
        const draft = previewPlanPayload(name);
        if (draft) return res.status(409).json({ error: '该计划还是草稿(有硬冲突或未启用),修好并启用后才能导出' });
        return res.status(404).json({ error: `计划不存在:${name}` });
      }
      if (plan.builtin) return res.status(400).json({ error: '内置计划请用资料库原有导出按钮(老规则承载)' });
      if (!previewDeps || !previewDeps.executeService) return res.status(501).json({ error: '落盘执行器未装配' });
      if (executing) return res.status(429).json({ error: '有导出正在进行,稍后再试' });
      executing = true;
      let handedToDownload = false;
      try {
        let result;
        if (plan.excel) {
          result = await previewDeps.executeService.executeExcelPlan({
            plan, workspaceKey: String(req.body?.workspaceKey || '').trim(),
          });
        } else {
          const batchId = String(req.body?.batchId || '').trim();
          const batch = previewDeps.loadBatch?.(batchId);
          if (!batch) return res.status(404).json({ error: `批次不存在:${batchId}` });
          result = await previewDeps.executeService.executeDslPlan({ plan, batch });
        }
        audit(req, 'export_plan_execute', name, { stats: result.stats });
        // 复核HIGH-1:闸与 staging 清理都挂在下载完成回调(batch_handlers 四先例同款)——
        // res.download 是异步流,finally 放闸=下载还在传第二单已能进来叠加重活;不清理=tmp 攒整批图副本。
        handedToDownload = true;
        return res.download(result.zipPath, result.downloadName, (downloadErr) => {
          try { result.cleanup?.(); } catch { /* 清理失败不致命 */ }
          executing = false;
          // 复核HIGH-A:传了回调=Express 关闭默认错误响应,头未发出的失败必须自己答——
          // 否则客户端这次请求永远挂着且零日志(四先例 batch_handlers 同款兜底)
          if (downloadErr && !res.headersSent) {
            res.status(500).json({ error: '下载失败,请重试' });
          }
        });
      } catch (error) {
        if (['EXPORT_PLAN_BLOCKED', 'EXPORT_PLAN_COLLISION', 'EXPORT_PLAN_EMPTY', 'EXPORT_PLAN_WORKSPACE_REQUIRED', 'EXPORT_PLAN_INVALID', 'EXPORT_PLAN_COPY_ALL_FAILED'].includes(error?.code)) {
          return res.status(422).json({ error: error.message, code: error.code, blocked: error.blocked || [], collisions: error.collisions || [], skipped: error.skipped || [], copyFailed: error.copyFailed || [] });
        }
        // 打包器/依赖缺失(2026-07-16 探针E3抓到):此前漏出 next(error)——H2 尾部处理器上线后
        // 被兜成不透明 "Internal error",操作员看不到"缺 zip/python3"的真原因 → 结构化 503 带真话。
        if (['EXPORT_PLAN_ZIP_FAILED', 'EXPORT_PLAN_DEPS_MISSING'].includes(error?.code)) {
          return res.status(503).json({ error: error.message, code: error.code });
        }
        return next(error);
      } finally {
        if (!handedToDownload) executing = false;
      }
    });

    // dry-run 预览(拍板'预览要'):跑计划不落盘,返回路径清单+阻断名单。
    app.post('/api/admin/config/export-plans/:name/preview', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const name = String(req.params.name || '').trim();
      const plan = previewPlanPayload(name); // 草稿也可预览(执行不行)
      if (!plan) return res.status(404).json({ error: `计划不存在:${name}` });

      // Excel 明细表计划:按工作区预览台账行(前200)
      if (plan.excel) {
        const workspaceKey = String((req.body && req.body.workspaceKey) || '').trim();
        if (!workspaceKey) return res.status(400).json({ error: '明细表预览需要 workspaceKey' });
        if (!previewDeps || typeof previewDeps.queryLedgerRows !== 'function') {
          return res.status(501).json({ error: '预览依赖未装配(queryLedgerRows)' });
        }
        const rows = previewDeps.queryLedgerRows({ workspaceKey, modes: plan.scope?.modes || [] });
        const headers = plan.excel.columns.map((key) => EXCEL_COLUMN_DEFS[key].header);
        return res.json({
          ok: true, name, kindType: 'excel',
          stats: { rows: rows.length, columns: plan.excel.columns.length },
          headers,
          rows: rows.slice(0, 200).map((row) => plan.excel.columns.map((key) => row[key] ?? '')),
          truncated: rows.length > 200,
          conflicts: computePlanConflicts(plan),
        });
      }

      const batchId = String((req.body && req.body.batchId) || '').trim();
      const batch = previewDeps && previewDeps.loadBatch ? previewDeps.loadBatch(batchId) : null;
      if (!batch) return res.status(404).json({ error: `批次不存在:${batchId}` });

      let paths;
      let blocked;
      let skipped;
      let missingSource = []; // 任务图缺失/路径解析失败(审计MEDIUM):出包前可见,与 blocked 分列
      if (plan.builtin === 'mode_delivery') {
        const svc = previewDeps && previewDeps.modeDeliveryExportService;
        if (!svc || !svc.planModeDelivery) return res.status(501).json({ error: '预览依赖未装配(mode_delivery planner)' });
        const built = svc.planModeDelivery(batch);
        paths = built.files.map((f) => pathPosix.join(f.dir, `${f.baseName}${extOfPath(f.sourcePath)}`));
        blocked = [
          ...[...built.missingSActivityReceiptNo, ...built.missingHyundaiReceiptNo].map((x) => `缺小票号:${x}`),
          // 规则5(2026-07-20):新世界/现代百货缺交易编码(夹/图都按它命名)同属阻断类
          ...(built.missingDeptTransNo || []).map((x) => `缺交易编码:${x}`),
        ];
        skipped = built.skippedUnreviewed.map((cid) => ({ customerId: cid, reason: '整组未审核完' }));
      } else if (plan.builtin === 'lotte_dept') {
        const svc = previewDeps && previewDeps.lotteDeptDeliveryExportService;
        if (!svc || !svc.planDelivery) return res.status(501).json({ error: '预览依赖未装配(lotte_dept planner)' });
        const built = svc.planDelivery(batch);
        paths = built.entries.map((e) => pathPosix.join(e.branch, e.customerDir, `${e.baseName}${extOfPath(e.sourcePath)}`));
        // 2026-07-20 拍板a:无独立护照不再阻断(planDelivery 已无 missingPassport,
        // 同框整图兜底进 passportFallback 信息名单,预览不列为阻断——与资料库 readiness 同口径)
        blocked = [
          ...built.missingReceiptNo.map((x) => `缺交易编号:${x}`),
          ...built.missingBranch.map((x) => `缺门店:${x}`),
        ];
        skipped = built.skippedUnreviewed.map((cid) => ({ customerId: cid, reason: '整组未审核完' }));
      } else if (plan.builtin) {
        // 收编的三个老出口(现代三池/客户文件夹/客户数据Excel):配置台不做路径预览,
        // 预检/导出在资料库交付页(library_delivery_routes readiness 承载)。
        return res.status(400).json({ error: '该内置计划请在资料库交付页预检/导出(配置台仅展示规则)', kindType: 'builtin' });
      } else {
        // DSL:按客户组喂引擎;sourcePath 用交付链同款解析(文件不存在=不进清单)
        const resolveTaskFile = (task) => {
          const rel = String((task && task.sourceImagePath) || '').trim();
          if (!rel || !previewDeps || !previewDeps.resolveBatchRelativePath) return '';
          try {
            const abs = previewDeps.resolveBatchRelativePath(batch.id, rel);
            return abs && fsForPreview.statSync(abs).isFile() ? abs : '';
          } catch { return ''; }
        };
        // 分组=引擎唯一分组器(客户库ID粒度;复核HIGH教训单源化,预览/落盘同一份)
        const resolved = resolveExportPlan(plan, buildCustomerGroups(batch, resolveTaskFile));
        paths = resolved.entries.map((e) => e.destPath);
        blocked = resolved.blocked.map((b) => `${b.customerId}/${b.taskId}:${b.reason}${b.suggested ? `(建议:${b.suggested})` : ''}`);
        blocked.push(...resolved.collisions.map((c) => `跨客户重名:${c.destBase}(${c.customers.join('、')})——${c.reason}`));
        skipped = resolved.skipped;
        missingSource = (resolved.missingSource || []).map((m) => `${m.customerId}/${m.taskId}(${m.docType})——${m.reason}`);
      }

      const truncated = paths.length > 2000;
      return res.json({
        ok: true, name, kindType: plan.builtin ? 'builtin' : 'dsl',
        stats: { entries: paths.length, blocked: blocked.length, skipped: skipped.length, missingSource: missingSource.length },
        paths: paths.slice(0, 2000).sort(),
        blocked: blocked.slice(0, 200),
        skipped: skipped.slice(0, 200),
        missingSource: missingSource.slice(0, 200),
        truncated,
      });
    });
  }

  // ── P3a:审核基线 + 店家档案字段(C类勾选的存储面)────────────────
  const REVIEW_BASE_DOCS = ['passport', 'receipt'];

  function factoryBaseKeys(docType) {
    return (FACTORY_FIELD_RULES[docType]?.fields || []).map((f) => f.finalKey);
  }

  function effectiveBaseKeys(docType) {
    const row = modeConfigRepository.getActive('review_base', docType);
    if (row?.payload && validateReviewBase(row.payload, docType).ok) return [...row.payload.fields];
    return factoryBaseKeys(docType);
  }

  function registerReviewConfig(app) {
    app.get('/api/admin/config/review-base', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const bases = REVIEW_BASE_DOCS.map((docType) => {
        const row = modeConfigRepository.getActive('review_base', docType);
        return {
          docType,
          source: row ? 'db' : 'factory',
          fields: effectiveBaseKeys(docType),
          factoryFields: factoryBaseKeys(docType),
          vocabulary: BASE_FIELD_KEYS[docType] || [],
          config: row ? { version: row.version, createdAt: row.createdAt, createdBy: row.createdBy, note: row.note } : null,
        };
      });
      return res.json({ bases });
    });

    // 影响面预检(拍板:预检+二次确认,不加硬门):只读不落盘。
    // 口径=最近批次里该类型**未审完**的票,按新基线会新增哪些必改(final/auto 都空)。
    app.post('/api/admin/config/review-base/:docType/impact', ...protect, async (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      try {
      const docType = String(req.params.docType || '').trim();
      if (!REVIEW_BASE_DOCS.includes(docType)) return res.status(400).json({ error: `不支持的 docType:${docType}` });
      const payload = req.body?.payload;
      const verdict = validateReviewBase(payload, docType);
      if (!verdict.ok) return res.status(400).json({ error: `基线不合法:${verdict.reason}` });
      const current = new Set(effectiveBaseKeys(docType));
      const added = payload.fields.filter((k) => !current.has(k));
      const removed = [...current].filter((k) => !payload.fields.includes(k));
      let affectedTasks = 0;
      let batchesChecked = 0;
      const sample = [];
      // ⭐链路探针实锤(2026-07-15):生产装配的 listBatches=batchRepository.listBatchesAsync 返回 Promise,
      // 同步 .slice 必 500;单测桩曾给同步数组=假绿(桩抄实现不抄真实契约,老教训第二例)。
      let batchList = await Promise.resolve(previewDeps?.listBatches?.() || []).catch(() => []);
      if (!Array.isArray(batchList)) batchList = Array.isArray(batchList?.batches) ? batchList.batches : [];
      const batches = batchList.slice(0, 8);
      for (const meta of batches) {
        const batch = previewDeps?.loadBatch?.(meta.id);
        if (!batch) continue;
        batchesChecked += 1;
        for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
          const taskDoc = String(task?.docTypeFinal || task?.docTypeAuto || '');
          if (taskDoc !== docType || task?.reviewed || task?.rephotoRequested) continue;
          // 免税店小票口径:百货票走档案通道,不吃基线,排除。
          // 判定=task_flow 同一条单源链(复核M2:别再长"猜店家"的正则副本——小票号四份副本事故同款病理)
          if (docType === 'receipt') {
            const storeRaw = String(task?.receiptStoreFinal || task?.receiptStoreAuto || '');
            const canonical = validateStoreFamily(storeRaw).canonical || '';
            if (getStoreProfile(canonical).family === FAMILY.DEPT) continue;
          }
          const missing = added.filter((finalKey) => {
            const autoKey = finalKey.replace(/Final$/, 'Auto');
            return !String(task?.[finalKey] || '').trim() && !String(task?.[autoKey] || '').trim();
          });
          if (missing.length) {
            affectedTasks += 1;
            if (sample.length < 10) sample.push({ batchId: batch.id, taskId: task.id, missing });
          }
        }
      }
      return res.json({ ok: true, docType, added, removed, affectedTasks, batchesChecked, sample });
      } catch (error) { return next(error); }
    });

    app.post('/api/admin/config/review-base/:docType', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const docType = String(req.params.docType || '').trim();
      if (!REVIEW_BASE_DOCS.includes(docType)) return res.status(400).json({ error: `不支持的 docType:${docType}` });
      const payload = req.body?.payload;
      const verdict = validateReviewBase(payload, docType);
      if (!verdict.ok) return res.status(400).json({ error: `基线不合法:${verdict.reason}` });
      const expectBaseVersion = resolveWriteBaseVersion(req, res, 'review_base', docType);
      if (expectBaseVersion === null) return;
      try {
        const saved = modeConfigRepository.saveNewVersion({
          kind: 'review_base', name: docType, payload,
          createdBy: req.user?.username || req.user?.id || '',
          note: String(req.body?.note || ''),
          expectBaseVersion,
        });
        audit(req, 'review_base_save', docType, { version: saved.version, fields: payload.fields });
        // B6:基线变了 → 复查已启用计划是否被漂移出硬冲突(警告不拦)
        return res.json({ ok: true, docType, version: saved.version, activePlanConflicts: activePlanConflictWarnings() });
      } catch (error) {
        if (error?.code === 'CONFIG_STALE') return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
        throw error;
      }
    });

    app.get('/api/admin/config/review-base/:docType/versions', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const docType = String(req.params.docType || '').trim();
      return res.json({ docType, versions: modeConfigRepository.listVersions('review_base', docType) });
    });

    app.post('/api/admin/config/review-base/:docType/activate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const docType = String(req.params.docType || '').trim();
      const version = Number(req.body?.version);
      if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'version 必须是正整数' });
      try {
        modeConfigRepository.activateVersion('review_base', docType, version);
      } catch (error) {
        if (error?.code === 'CONFIG_VERSION_NOT_FOUND') return res.status(404).json({ error: error.message });
        throw error;
      }
      audit(req, 'review_base_rollback', docType, { version });
      return res.json({ ok: true, docType, version });
    });

    app.post('/api/admin/config/review-base/:docType/deactivate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const docType = String(req.params.docType || '').trim();
      modeConfigRepository.deactivate('review_base', docType);
      audit(req, 'review_base_deactivate', docType, {});
      return res.json({ ok: true, docType, fallback: 'factory' });
    });

    // 店档案有效字段(配置命中且合法→配置;否则出厂)。admin stores 与公开 review-config 共用此口径。
    function effectiveStoreRow(family, profile) {
      const row = modeConfigRepository.getActive('store', family);
      const fields = (row?.payload?.fields && validateStoreFields(row.payload.fields).ok)
        ? [...row.payload.fields] : [...profile.fields];
      return { row, fields };
    }

    // 门店码点选清单(0727反馈#6):配置命中且合法→配置;否则出厂(rules.branch 码 + branchNames 店名)。
    // 只有出厂档案带门店概念的店(rules.branch,现=乐天百货)才有清单;其余返回 null。
    // ⚠️生效边界(断点①同款如实口径):清单喂**审核台点选与店名提示**;台账/交付的
    // 码→店名映射运行时仍读 lib/store_profiles 出厂表,配置新增码在那边显示码原样。
    function effectiveBranchOptions(profile, row) {
      if (!Array.isArray(profile.rules?.branch)) return null;
      const configured = row?.payload?.branchOptions;
      if (configured && validateBranchOptions(configured).ok) {
        return configured.map((o) => ({ code: String(o.code).trim(), name: String(o.name || '').trim() }));
      }
      return profile.rules.branch.map((code) => ({
        code: String(code),
        name: String(profile.rules?.branchNames?.[code] || ''),
      }));
    }

    // ── P3c:审核台运行时拉取(登录即可,**非 admin**)──
    // 前端百货面板用它过滤字段格(只在店真配置过 configVersion>0 时才过滤,出厂路径逐字节不动);
    // 拉不到/超时前端回落内置常量——系统永不因配置挂(P0 手法)。只读端点,不暴露任何写口。
    app.get('/api/review-config', ...protect, (req, res) => {
      // 本文件唯一"仅登录、非admin"端点:别的端点都有 requireAdmin 兜底,这里必须自带一道显式闸
      // (防未来此路由文件被复用到没有 JWT_SECRET 启动硬闸的装配场景时变成完全公开)。
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const stores = {};
      for (const [family, profile] of Object.entries(FACTORY_PROFILES)) {
        if (profile.family !== 'dept') continue;
        const { row, fields } = effectiveStoreRow(family, profile);
        stores[family] = {
          fields,
          passportFree: Boolean(row?.payload?.passportFree ?? profile.passportFree),
          configVersion: row?.version || 0, // 0=出厂(前端见 0 不过滤)
          // 门店码点选清单(0727#6):出厂或配置的有效清单;无门店概念的店不带此键
          ...(effectiveBranchOptions(profile, row) ? { branchOptions: effectiveBranchOptions(profile, row) } : {}),
        };
      }
      return res.json({
        stamp: modeConfigRepository.maxStamp(),
        stores,
        receiptBaseFields: effectiveBaseKeys('receipt'),
        passportBaseFields: effectiveBaseKeys('passport'),
        // T4(2026-07-21):全模式有效免审映射(显式relax∪「记哪些列」派生,已减require补回)。
        // 前端据此折叠免审字段+validateForSubmit 同源豁免;拉不到=空映射,行为退回全审(安全方向)。
        modeRelax: previewDeps?.reviewConfigResolver?.listModeRelaxMap?.() || {},
      });
    });

    // ── P3c:字段管理页(注册表只读——"新增字段只能引用注册表"的可视面)──
    app.get('/api/admin/config/field-registry', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      return res.json({
        fields: FIELD_REGISTRY.map((f) => ({
          key: f.key,
          label: f.label,
          source: f.source,
          exportable: Boolean(f.exportable),
          docTypes: f.docTypes,
          guarded: Boolean(f.contract), // 有契约=进字段契约守卫(persisted/clearOnSwitch)
        })),
      });
    });

    // ── P3c:配置日志页(全 kind 版本流水聚合分页)──
    app.get('/api/admin/config/changelog', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { total, rows } = modeConfigRepository.listChangelog({
        offset: req.query.offset,
        limit: req.query.limit,
      });
      return res.json({ total, rows });
    });

    // 店家档案字段(C类勾选):只改 fields 清单;passportFree 等安全闸字段只读(冻结区)
    app.get('/api/admin/config/stores', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const families = Object.entries(FACTORY_PROFILES)
        .filter(([, profile]) => profile.family === 'dept')
        .map(([family, profile]) => {
          const { row, fields } = effectiveStoreRow(family, profile);
          return {
            family,
            label: profile.label,
            source: row ? 'db' : 'factory',
            fields,
            factoryFields: [...profile.fields],
            vocabulary: [...DEPT_FIELD_VOCAB], // C类勾选可选全集(UI 渲染用,单源=resolver 词汇)
            readonly: { passportFree: Boolean(row?.payload?.passportFree ?? profile.passportFree), combined: Boolean(profile.combined) },
            // 断点①明示(2026-07-20 行为三合一):店档案里 fields 之外的规则(票号形态/门店映射/
            // 品牌/上家/借位/交付链)运行时全读 lib/store_profiles 硬编码,配置台改不了——
            // 如实展示为"出厂规则(只读,改代码)",杜绝"存进 config_entries 就以为可配"的错觉。
            factoryRules: {
              receiptNo: profile.rules?.receiptNo || null,
              branchNames: profile.rules?.branchNames || null,
              brand: profile.rules?.brand || null,
              upstream: profile.rules?.upstream || null,
              upstreamDefault: profile.defaults?.upstream || '',
              delivery: profile.delivery || '',
            },
            config: row ? { version: row.version, createdBy: row.createdBy, createdAt: row.createdAt } : null,
            // 门店码清单(0727#6):branchConfigurable=有门店概念(现=乐天百货)。
            // 有效清单+出厂清单都给,前端编辑器据此渲染与「回到出厂」。
            branchConfigurable: Array.isArray(profile.rules?.branch),
            branchOptions: effectiveBranchOptions(profile, row),
            factoryBranchOptions: Array.isArray(profile.rules?.branch)
              ? profile.rules.branch.map((code) => ({ code: String(code), name: String(profile.rules?.branchNames?.[code] || '') }))
              : null,
          };
        });
      return res.json({ stores: families });
    });

    // 门店码清单保存(0727反馈#6):与 /fields 同一套版本/审计/陈旧闸。
    // 生效边界如实告知(effectiveBranchOptions 注释同款):喂审核台点选;台账/交付映射走出厂表。
    app.post('/api/admin/config/stores/:family/branch-options', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const family = String(req.params.family || '').trim();
      const profile = FACTORY_PROFILES[family];
      if (!profile || profile.family !== 'dept') return res.status(400).json({ error: `不是百货店档案:${family}` });
      if (!Array.isArray(profile.rules?.branch)) return res.status(400).json({ error: `该店没有门店码概念:${family}` });
      const options = req.body?.branchOptions;
      const verdict = validateBranchOptions(options);
      if (!verdict.ok) return res.status(400).json({ error: `门店码清单不合法:${verdict.reason}` });
      const row = modeConfigRepository.getActive('store', family);
      const basePayload = row?.payload ? { ...row.payload } : {
        family: profile.family, label: profile.label, mode: profile.mode, split: profile.split,
        combined: Boolean(profile.combined), tourMatch: Boolean(profile.tourMatch),
        passportFree: Boolean(profile.passportFree), fields: [...profile.fields],
        rules: JSON.parse(JSON.stringify(profile.rules || {})),
        defaults: JSON.parse(JSON.stringify(profile.defaults || {})),
        delivery: profile.delivery || '', storeFamily: family,
      };
      basePayload.branchOptions = options.map((o) => ({ code: String(o.code).trim(), name: String(o.name || '').trim() }));
      const expectBaseVersion = resolveWriteBaseVersion(req, res, 'store', family);
      if (expectBaseVersion === null) return;
      try {
        const saved = modeConfigRepository.saveNewVersion({
          kind: 'store', name: family, payload: basePayload,
          createdBy: req.user?.username || req.user?.id || '',
          note: String(req.body?.note || ''),
          expectBaseVersion,
        });
        audit(req, 'store_branch_options_save', family, { version: saved.version, count: basePayload.branchOptions.length });
        return res.json({ ok: true, family, version: saved.version, branchOptions: basePayload.branchOptions });
      } catch (error) {
        if (error?.code === 'CONFIG_STALE') return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
        throw error;
      }
    });

    app.post('/api/admin/config/stores/:family/fields', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const family = String(req.params.family || '').trim();
      const profile = FACTORY_PROFILES[family];
      if (!profile || profile.family !== 'dept') return res.status(400).json({ error: `不是百货店档案:${family}` });
      const fields = req.body?.fields;
      const verdict = validateStoreFields(fields);
      if (!verdict.ok) return res.status(400).json({ error: `档案字段不合法:${verdict.reason}` });
      const row = modeConfigRepository.getActive('store', family);
      // 基底=现 active 配置或出厂档案;只替换 fields,passportFree 等原样保留(只读冻结区)
      const basePayload = row?.payload ? { ...row.payload } : {
        family: profile.family, label: profile.label, mode: profile.mode, split: profile.split,
        combined: Boolean(profile.combined), tourMatch: Boolean(profile.tourMatch),
        passportFree: Boolean(profile.passportFree), fields: [...profile.fields],
        rules: JSON.parse(JSON.stringify(profile.rules || {})),
        defaults: JSON.parse(JSON.stringify(profile.defaults || {})),
        delivery: profile.delivery || '', storeFamily: family,
      };
      basePayload.fields = [...fields];
      const expectBaseVersion = resolveWriteBaseVersion(req, res, 'store', family);
      if (expectBaseVersion === null) return;
      try {
        const saved = modeConfigRepository.saveNewVersion({
          kind: 'store', name: family, payload: basePayload,
          createdBy: req.user?.username || req.user?.id || '',
          note: String(req.body?.note || ''),
          expectBaseVersion,
        });
        audit(req, 'store_fields_save', family, { version: saved.version, fields });
        // B6:店档案变了 → 同款漂移复查
        return res.json({ ok: true, family, version: saved.version, activePlanConflicts: activePlanConflictWarnings() });
      } catch (error) {
        if (error?.code === 'CONFIG_STALE') return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
        throw error;
      }
    });

    // 店档案回落出厂(链路探针实锤缺口:此前四类实体唯独店档案没有回落口,
    // UI 无按钮、探针 404,配置残留让"出厂"前提失真)
    app.post('/api/admin/config/stores/:family/deactivate', ...protect, (req, res) => {
      if (!requireAdmin(req, res)) return;
      const family = String(req.params.family || '').trim().toUpperCase();
      if (!FACTORY_PROFILES[family] || FACTORY_PROFILES[family].family !== 'dept') {
        return res.status(400).json({ error: `不是可配置的百货店:${family}` });
      }
      modeConfigRepository.deactivate('store', family);
      audit(req, 'store_fields_deactivate', family, {});
      return res.json({ ok: true, family, fallback: 'factory' });
    });

  }

  const registerBase = register;
  function registerAll(app) {
    registerBase(app);
    registerExportPlans(app);
    registerReviewConfig(app);
  }

  return { register: registerAll };
}

module.exports = { createConfigConsoleRoutes, buildModeConfigWarnings };
