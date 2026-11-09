const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTourConfirmLogRepository } = require('../repositories/tour_confirm_log_repository');
const { createSendbackQueueRepository } = require('../repositories/sendback_queue_repository');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tour-confirm-'));
}

test('tour_confirm_log:按日追加,先验按引用组数倒序,含前一天,按收票员过滤', async () => {
  const root = tmpDir();
  try {
    const repo = createTourConfirmLogRepository({ storageRoot: root });
    const day = '2026-07-10';
    const prev = '2026-07-09';
    await repo.append({ workspaceKey: 'ws-a', tourNo: '71203', mode: 'M1', confirmedAt: `${day}T01:00:00.000Z` });
    await repo.append({ workspaceKey: 'ws-a', tourNo: '71203', mode: 'M1', confirmedAt: `${day}T02:00:00.000Z` });
    await repo.append({ workspaceKey: 'ws-a', tourNo: '70455', mode: 'M2', confirmedAt: `${prev}T23:00:00.000Z` });
    await repo.append({ workspaceKey: 'ws-b', tourNo: '99999', mode: 'M3', confirmedAt: `${day}T01:30:00.000Z` });

    const prior = await repo.listPrior({ workspaceKey: 'ws-a', date: day });
    assert.deepEqual(prior.map((p) => p.tourNo), ['71203', '70455']);
    assert.equal(prior[0].count, 2);
    // 其他收票员的确认不串台
    const priorB = await repo.listPrior({ workspaceKey: 'ws-b', date: day });
    assert.deepEqual(priorB.map((p) => p.tourNo), ['99999']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sendback_queue:入队幂等/已发盖章/按组作废/超时红签', async () => {
  const root = tmpDir();
  try {
    let clock = new Date('2026-07-10T01:00:00.000Z');
    const repo = createSendbackQueueRepository({ storageRoot: root, dueHours: 4, now: () => clock });

    const a = await repo.enqueue({ batchId: 'b1', groupKey: 'g1', workspaceKey: 'ws-a', action: 'send_12', mode: 'M(发12号)', tourNo: '111' });
    const dup = await repo.enqueue({ batchId: 'b1', groupKey: 'g1', workspaceKey: 'ws-a', action: 'send_12' });
    assert.equal(dup.id, a.id, '同组同动作未完成不重复入队');

    await repo.enqueue({ batchId: 'b1', groupKey: 'g2', workspaceKey: 'ws-a', action: 's_activity' });
    const done = await repo.markDone(a.id, { operator: '小票06', note: '已发群' });
    assert.equal(done.status, 'done');
    assert.equal(done.sentBy, '小票06');

    // 作废 g2 的 pending
    const n = await repo.cancelByGroup('b1', 'g2', { note: '撤销' });
    assert.equal(n, 1);

    // 超时红签:时钟拨过 dueAt
    const c = await repo.enqueue({ batchId: 'b2', groupKey: 'g3', workspaceKey: 'ws-a', action: 'send_17' });
    clock = new Date('2026-07-10T06:00:00.000Z'); // +5h > 4h
    const items = await repo.list({ workspaceKey: 'ws-a' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    assert.equal(byId[c.id].overdue, true);
    assert.equal(byId[a.id].overdue, false, 'done 不算超时');
    assert.equal(byId[a.id].status, 'done');

    // markDone 不存在 → null
    assert.equal(await repo.markDone('sb_nope', {}), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
