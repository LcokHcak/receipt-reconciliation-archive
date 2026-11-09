'use strict';

/**
 * Import surface — every `/imports/*` endpoint uses the same multer
 * upload-and-dispatch wrapper. Adding a new import type is one line +
 * a `importService.importX` method.
 */

const fs = require('node:fs');

const { handleImport } = require('./route_utils');

// 第三列 = 守卫键:缺省 intake(admin/reviewer);'admin' = 仅管理员。
// smg-ledger 收权 admin(2026-07-21 拍板:总账收敛到管理员账户,专人上传——
// 人人可传的最大危害是旧版覆盖新版,先从权限面收掉)。
const IMPORT_TYPES = Object.freeze([
  ['group-code', 'group_code'],
  ['store-bill', 'store_bill'],
  ['missing', 'missing'],
  ['received-receipt', 'received_receipt'],
  ['daily-receipt', 'daily_receipt'],
  // SMG总账(上家):只做未收对账,替换语义,不进账单匹配四桶(2026-07-21 拍板)
  ['smg-ledger', 'smg_ledger', 'admin'],
]);

function registerImportRoutes({ app, guards, deps }) {
  const { intake, admin } = guards;
  const {
    upload, importService, workspaceService, importValidationService, derivationRecomputeService,
    agentUnreceivedService,
  } = deps;
  // 异步导入进度轮询复用现成的 GET /import-jobs/:id(job_routes.js)。

  // 导入成功后标脏(导出跟最新数据走):账单 → 从 bill_match 重跑;团号/台账/收票 →
  // 从 tour_match 重跑;missing 清单不参与派生链。
  // smg_ledger 也标 bill_match:总账行虽不进匹配四桶,但交付包 5_未收/未收导出吃
  // listUnreceived 口径,内容变了 → 宁可多提示重导出,不给陈旧未收清单。
  const DIRTY_BY_JOB = { store_bill: 'bill_match', group_code: 'tour_match', daily_receipt: 'tour_match', received_receipt: 'tour_match', smg_ledger: 'bill_match' };
  const onImported = ({ workspaceKey, jobType, result }) => {
    const stage = DIRTY_BY_JOB[jobType];
    if (stage) { try { derivationRecomputeService?.markDirty(workspaceKey, stage); } catch { /* noop */ } }
    // 拍板③(代理视图 B 页):超7天红的起算点=行第一次出现在未收清单之日,即账单导入对账时——
    // 账单导入完成立即对账盖 first_seen 锚(内部自带 try/catch,失败留日志不影响导入)。
    // 复核 HIGH#2:账单按购买月拆分时行会落到多个工作区(splitByWorkspace),逐个盖,
    // 只盖 URL 工作区会漏掉跨月行的起算点。
    // smg_ledger 同样盖锚(它就是给 B 页找未收的);不拆月,targets 只会有 URL 工作区。
    if (jobType === 'store_bill' || jobType === 'smg_ledger') {
      const targets = new Set([workspaceKey, ...Object.keys(result?.details?.splitByWorkspace || {})]);
      for (const ws of targets) {
        if (ws) { try { agentUnreceivedService?.stampWorkspace(ws); } catch { /* noop */ } }
      }
    }
  };

  // 导入前校验端点
  if (importValidationService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/imports/validate',
      ...intake,
      upload.single('file'),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { importType } = req.body;

        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        if (!importType) {
          return res.status(400).json({ error: 'importType required' });
        }

        try {
          const result = await importValidationService.validateImport({
            filePath: req.file.path,
            importType,
            workspaceKey,
          });
          res.json(result);
        } catch (error) {
          console.error('[import_validation] Validation failed:', error);
          res.status(500).json({ error: error?.message || 'Validation failed' });
        } finally {
          // 校验只读一次文件,用后即删,避免 multer 临时文件在 tmp_uploads 堆积
          try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch { /* best effort */ }
        }
      }
    );
  }

  for (const [pathSlug, jobType, guardKey] of IMPORT_TYPES) {
    const guard = guardKey === 'admin' ? admin : intake;
    app.post(
      `/api/monthly/workspaces/:workspaceKey/imports/${pathSlug}`,
      ...guard,
      upload.single('file'),
      handleImport({ importService, workspaceService, jobType, onImported })
    );
  }
}

module.exports = { registerImportRoutes, IMPORT_TYPES };
