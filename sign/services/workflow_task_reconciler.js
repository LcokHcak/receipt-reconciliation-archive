'use strict';

/**
 * workflow_task_reconciler — 运营任务对账补建(2026-07-12 架构体检风险#1)。
 *
 * 病理:workflow_task 是"不可丢"的运营真相,但创建走 advisory 路径(票级表态协调器,
 * 失败只记 retry 环+日志,无人消费)——完成沿上一次抛错(DB busy 等)= 该客户组的
 * 回执/回发任务**永久缺失**。读模型有 rebuild 自愈,任务表此前什么都没有。
 *
 * 对账规则(与协调器同一门槛,零副本):
 *   候选 = 读模型里「已全表态」状态(review_pending/needs_remedy/needs_confirm/passed)
 *          且挂着活动批次、且该 (workspace,customer,batch) 域内 send_upstream 一行都没有
 *          (有 pending=在办/有 done=办过/有 cancelled=重开过——都不算漏建);
 *   确认 = 加载批次真相重算票级 overlay(读模型只是线索,门槛以批次为准),
 *          全表态+有小票+非全豁免 → ensureSendUpstream(幂等,重放安全)。
 *
 * 资源边界:候选查询纯 SQL(LEFT JOIN,毫秒级);每 tick 最多加载 MAX_BATCHES_PER_TICK
 * 个批次;豁免/无小票客户进负缓存(进程内 Set),不反复重载批次。
 */

const {
  buildBatchOverlayEntries,
} = require('../lib/agent_workspace/customer_projection');
const { buildSendUpstreamContext } = require('./workflow_task_coordinator');

const ALL_STANCED_STATUSES = ['review_pending', 'needs_remedy', 'needs_confirm', 'passed'];
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_BATCHES_PER_TICK = 10;
const MAX_CANDIDATES_PER_TICK = 200;

function createWorkflowTaskReconciler({
  db,
  batchRepository,
  workflowTaskService,
  logger = null,
  intervalMs = Number(process.env.WORKFLOW_TASK_RECONCILE_INTERVAL_MS || DEFAULT_INTERVAL_MS),
} = {}) {
  if (!db) throw new Error('db is required');
  if (!batchRepository) throw new Error('batchRepository is required');
  if (!workflowTaskService) throw new Error('workflowTaskService is required');

  // 负缓存:确认过"不需要任务"(豁免/无小票)或批次已删的客户,进程生存期内不再重查。
  // 键=customerPk::batchId——客户换到新批次后必须重新评估,不能被旧批次的结论挡住。
  // 上界=当月客户量级(几万个短字符串),重启即清,安全。
  const settledPks = new Set();
  let timer = null;

  // ⭐LIMIT 必须作用在**负缓存之后**(2026-08-01 修)。
  //
  // 原来是:SQL 里 LIMIT 200 → 拿回来再用 settledPks 在 JS 里过滤。看着等价,其实会饿死:
  // 「无小票 / 全豁免」的客户**永远**满足 wt.id IS NULL(协调器根本不会给他们建任务),
  // 于是他们永久占住那 200 个名额。同一进程里跑几轮之后,这 200 个全进负缓存,
  // 每个 tick 都是"取回 200 条 → 过滤剩 0 条 → 提前 return",
  // 而排在第 201 位、**真正漏建**的那个客户永远轮不到。
  // 这张网本来就是给"任务永久缺失"兜底的,规模一到它自己先静默失效了。
  //
  // 改成分页扫,直到凑够 MAX_CANDIDATES_PER_TICK 个**未被负缓存**的候选。
  // OFFSET 分页要求排序稳定,所以显式 ORDER BY customer_pk(原来没有 ORDER BY,
  // 靠的是 SQLite 的偶然稳定,分页下会漏行/重行)。
  // 扫描页数有上界:再多也不能让一个 tick 无限扫库;撞到上界会记日志,不静默。
  const CANDIDATE_PAGE_SIZE = MAX_CANDIDATES_PER_TICK;
  const MAX_SCAN_PAGES = 25; // 25 × 200 = 每 tick 最多扫 5000 行

  function candidatePage(offset) {
    // 有任何 send_upstream 行(不论状态)都不算漏建——cancelled 表示经历过重开语义,
    // 重开后再全表态由协调器现场负责,不归对账补。
    const placeholders = ALL_STANCED_STATUSES.map(() => '?').join(', ');
    return db.prepare(`
      SELECT c.customer_pk, c.workspace_key, c.customer_id, c.batch_id, c.group_key
      FROM agent_workspace_customer c
      LEFT JOIN workflow_task wt
        ON wt.task_type = 'send_upstream'
        AND wt.workspace_key = c.workspace_key
        AND wt.customer_id = c.customer_id
        AND COALESCE(wt.batch_id, '') = COALESCE(c.batch_id, '')
      WHERE c.batch_id IS NOT NULL AND c.batch_id != ''
        AND c.review_status IN (${placeholders})
        AND wt.id IS NULL
      ORDER BY c.customer_pk
      LIMIT ${CANDIDATE_PAGE_SIZE} OFFSET ${Number(offset) || 0}
    `).all(...ALL_STANCED_STATUSES);
  }

  function findCandidates() {
    const out = [];
    let scanned = 0;
    let pages = 0;
    for (; pages < MAX_SCAN_PAGES; pages += 1) {
      const page = candidatePage(pages * CANDIDATE_PAGE_SIZE);
      if (!page.length) break; // 扫完了
      scanned += page.length;
      for (const row of page) {
        if (settledPks.has(row.customer_pk + '::' + row.batch_id)) continue;
        out.push(row);
        if (out.length >= MAX_CANDIDATES_PER_TICK) return { rows: out, scanned, exhausted: false };
      }
      if (page.length < CANDIDATE_PAGE_SIZE) break; // 最后一页
    }
    return { rows: out, scanned, exhausted: pages >= MAX_SCAN_PAGES };
  }

  async function tick() {
    const startedAt = Date.now();
    const result = { candidates: 0, created: 0, skipped: 0, staleReadModel: 0, batchesLoaded: 0, errors: 0 };
    try {
      // 负缓存已在 findCandidates 里逐页过滤(见那里的说明:过滤必须在 LIMIT 之前,
      // 否则永久候选会占满名额把真漏建的饿死)
      const { rows: candidates, scanned, exhausted } = findCandidates();
      result.candidates = candidates.length;
      result.scanned = scanned;
      if (exhausted) {
        // 撞到扫描上界:说明永久候选(无小票/全豁免)已经多到一个 tick 扫不完。
        // 不静默——真漏建的可能还排在后面,下个 tick 会接着扫,但这事得有人知道。
        result.scanExhausted = true;
        logger?.warn?.('workflow_task_reconcile_scan_capped', {
          scanned, picked: candidates.length, maxPages: MAX_SCAN_PAGES,
        });
      }
      if (!candidates.length) return result;

      const byBatch = new Map();
      for (const c of candidates) {
        if (!byBatch.has(c.batch_id)) byBatch.set(c.batch_id, []);
        byBatch.get(c.batch_id).push(c);
      }

      for (const [batchId, rows] of byBatch) {
        if (result.batchesLoaded >= MAX_BATCHES_PER_TICK) break; // 剩下的下个 tick 接着来
        if (!batchRepository.hasBatch(batchId)) {
          for (const row of rows) settledPks.add(row.customer_pk + '::' + row.batch_id); // 批次已删:读模型残影,重建时会清
          continue;
        }
        let batch;
        try {
          // 复核 MEDIUM:同步 readFileSync 在故障恢复期一个 tick 最多阻塞事件循环数百毫秒——
          // 有 loadBatchAsync 就让 I/O 让出循环(生产仓库恒有;测试 mock 可只给 loadBatch)
          batch = typeof batchRepository.loadBatchAsync === 'function'
            ? await batchRepository.loadBatchAsync(batchId)
            : batchRepository.loadBatch(batchId);
        } catch (error) {
          result.errors += 1;
          logger?.warn?.('workflow_task_reconcile_load_failed', {
            batchId, error: String(error?.message || error),
          });
          continue;
        }
        result.batchesLoaded += 1;

        const { entries } = buildBatchOverlayEntries(batch);
        const entryByPk = new Map(entries.map((e) => [e.customerPk, e]));
        for (const row of rows) {
          const entry = entryByPk.get(row.customer_pk);
          if (!entry) {
            // 批次里已没有该客户的任务(被移走/删除)→ 读模型滞后,别补
            settledPks.add(row.customer_pk + '::' + row.batch_id);
            result.staleReadModel += 1;
            continue;
          }
          const { overlay } = entry;
          if (overlay.stanceLockedCount > 0) {
            // 批次真相说还没全表态(读模型滞后)→ 不补,也不负缓存(表态完成后协调器接手)
            result.staleReadModel += 1;
            continue;
          }
          if (overlay.receiptCount <= 0 || overlay.nonExemptReceiptCount === 0) {
            settledPks.add(row.customer_pk + '::' + row.batch_id); // 无小票/全豁免:永远不需要任务
            result.skipped += 1;
            continue;
          }
          try {
            const ref = { workspaceKey: entry.workspaceKey, customerId: entry.customerId };
            const ctx = buildSendUpstreamContext(batch, ref, entry.tasks, 'reconciler');
            const sent = workflowTaskService.ensureSendUpstream({
              ...ctx,
              receiptCount: overlay.receiptCount,
              exemptOnly: overlay.nonExemptReceiptCount === 0,
              allStanced: true,
            });
            if (sent.created) {
              result.created += 1;
              logger?.info?.('workflow_task_reconciled', {
                customerPk: row.customer_pk, batchId, taskKey: sent.task?.taskKey,
              });
            } else {
              settledPks.add(row.customer_pk + '::' + row.batch_id); // 已有 pending(并发协调器刚建)也算了结
            }
          } catch (error) {
            result.errors += 1;
            logger?.warn?.('workflow_task_reconcile_failed', {
              customerPk: row.customer_pk, batchId, error: String(error?.message || error),
            });
          }
        }
      }
      return result;
    } finally {
      if (result.created || result.errors || result.staleReadModel) {
        logger?.info?.('workflow_task_reconcile_tick', { ...result, ms: Date.now() - startedAt });
      }
    }
  }

  function start() {
    if (timer || !(intervalMs > 0)) return;
    timer = setInterval(() => {
      tick().catch((error) => {
        logger?.warn?.('workflow_task_reconcile_tick_crashed', { error: String(error?.message || error) });
      });
    }, intervalMs);
    timer.unref?.(); // 不阻止进程退出
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { tick, start, stop };
}

module.exports = { createWorkflowTaskReconciler };
