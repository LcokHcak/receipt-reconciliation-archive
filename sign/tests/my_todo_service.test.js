const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMyTodos,
  createMyTodoService,
  ROLE_TODO_KEYS,
} = require('../services/my_todo_service');

const SAMPLE_BATCHES = [
  {
    id: 'b-001',
    name: '批次 A',
    updatedAt: '2026-05-07T10:00:00Z',
    counts: { total: 20, classification: 3, fields: 4, signature: 0, finalReview: 1, approved: 12 },
  },
  {
    id: 'b-002',
    name: '批次 B',
    updatedAt: '2026-05-06T10:00:00Z',
    counts: { total: 10, classification: 0, fields: 0, signature: 0, finalReview: 0, approved: 10 },
  },
  {
    id: 'b-003',
    name: '批次 C',
    updatedAt: '2026-05-05T10:00:00Z',
    counts: { total: 5, classification: 0, fields: 2, signature: 1, finalReview: 0, approved: 0 },
  },
];

test('buildMyTodos returns empty list for unknown roles', () => {
  const result = buildMyTodos({ batches: SAMPLE_BATCHES, role: 'viewer' });
  assert.equal(result.role, 'viewer');
  assert.equal(result.totalPending, 0);
  assert.deepEqual(result.todos, []);
  assert.deepEqual(result.stages, []);
});

test('buildMyTodos aggregates reviewer review stages (含 finalReview,2026-07-19 审计修复)', () => {
  const result = buildMyTodos({ batches: SAMPLE_BATCHES, role: 'reviewer' });
  assert.equal(result.role, 'reviewer');
  assert.equal(result.totalPending, 11, 'b-001 的 finalReview 1 也算 reviewer 待办');
  assert.equal(result.todos.length, 2);
  assert.equal(result.todos[0].batchId, 'b-001');
  assert.equal(result.todos[0].pendingCount, 8);
  assert.equal(result.todos[0].primaryStage, 'classification');
  assert.equal(result.todos[0].route, undefined, 'route 死字段已删(全仓无消费方,2026-07-20 清理)');
  assert.equal(result.todos[1].batchId, 'b-003');
  assert.equal(result.todos[1].pendingCount, 3);
  const fieldStage = result.stages.find((entry) => entry.stage === 'fields');
  assert.equal(fieldStage.count, 6);
});

test('reviewer:只剩 finalReview 的批次必须出现在待办(否则首页两个列表同时消失)', () => {
  const result = buildMyTodos({
    batches: [{
      id: 'b-final-only',
      name: '只剩终审',
      counts: { total: 10, classification: 0, fields: 0, signature: 0, finalReview: 4, approved: 6 },
    }],
    role: 'reviewer',
  });
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].pendingCount, 4);
  assert.equal(result.todos[0].primaryStage, 'finalReview');
});

test('buildMyTodos picks finalReview stage for finance', () => {
  const result = buildMyTodos({ batches: SAMPLE_BATCHES, role: 'finance' });
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].batchId, 'b-001');
  assert.equal(result.todos[0].primaryStage, 'finalReview');
});

test('buildMyTodos covers admin with every stage', () => {
  const result = buildMyTodos({ batches: SAMPLE_BATCHES, role: 'admin' });
  assert.equal(result.todos.length, 2, 'batches with any pending work appear');
  assert.equal(result.totalPending, 11);
  const stageKeys = result.stages.map((entry) => entry.stage);
  assert.deepEqual(stageKeys, ROLE_TODO_KEYS.admin);
});

test('createMyTodoService wraps listBatches and returns role payload', async () => {
  let callCount = 0;
  const service = createMyTodoService({
    listBatches: async () => {
      callCount += 1;
      return SAMPLE_BATCHES;
    },
  });
  const payload = await service.getMyTodos({ role: 'reviewer' });
  assert.equal(callCount, 1);
  assert.equal(payload.role, 'reviewer');
  assert.equal(payload.totalPending, 11);
});

test('createMyTodoService filters todos by operator scope', async () => {
  const service = createMyTodoService({
    listBatches: async () => [
      {
        id: 'alice-batch',
        ownerUsername: 'alice',
        counts: { total: 3, fields: 2, classification: 1, signature: 0, finalReview: 0, approved: 0 },
      },
      {
        id: 'bob-batch',
        ownerUsername: 'bob',
        counts: { total: 2, fields: 2, classification: 0, signature: 0, finalReview: 0, approved: 0 },
      },
    ],
  });

  const reviewerPayload = await service.getMyTodos({
    role: 'reviewer',
    operatorUser: { username: 'alice', role: 'reviewer' },
  });
  assert.deepEqual(reviewerPayload.todos.map((todo) => todo.batchId), ['alice-batch']);
  assert.equal(reviewerPayload.totalPending, 3);

  const financePayload = await service.getMyTodos({
    role: 'finance',
    operatorUser: { username: 'finance', role: 'finance' },
  });
  assert.deepEqual(financePayload.todos.map((todo) => todo.batchId), []);

  const adminPayload = await service.getMyTodos({
    role: 'admin',
    operatorUser: { username: 'admin', role: 'admin' },
  });
  assert.deepEqual(adminPayload.todos.map((todo) => todo.batchId), ['alice-batch', 'bob-batch']);
  assert.equal(adminPayload.totalPending, 5);
});

test('createMyTodoService refuses to build without listBatches', () => {
  assert.throws(() => createMyTodoService({}), /listBatches/);
});
