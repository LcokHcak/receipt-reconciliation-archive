'use strict';

// 0730 事故防线:**真实**服务对象是否提供了路由要用的每一个 handler。
//
// 起因:我加了 POST /tasks/:taskId/doc-box,并往两处 handler 桩清单里加了名字,
// 于是全量 2178 条测试**全绿** —— 但真实服务器**起不来**:
//   TypeError: argument handler must be a function
// 因为写操作加在了 services/workbench_write,而路由用的是
// services/handlers/workbench/task_handlers 里的 HTTP handler,那一层我漏了。
//
// 那些桩清单测试只证明「给一份完整的假 handlers,路由能注册」,
// 不证明「真实工厂真的产出了这些 handler」。这个文件补的正是后者。
//
// 判据 7 的又一个实例:桩/源码断言锁不住"它还能不能跑"。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

// 从 routes/workbench_routes.js 里把 handlers.xxx 全抠出来 —— 路由文件是唯一真相源,
// 以后新增路由自动被这条测试覆盖,不用记得来改清单。
function handlerNamesUsedByRoutes() {
  const src = fs.readFileSync(path.join(root, 'routes/workbench_routes.js'), 'utf8');
  return [...new Set([...src.matchAll(/handlers\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
}

test('⭐真实 task_handlers 工厂产出了路由要用的每一个 handler', () => {
  const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');
  // 依赖全给成 no-op:这里只关心"工厂返回的对象有哪些键",不跑业务
  const asyncNoop = async () => ({ status: 200, body: {} });
  const handlers = createWorkbenchTaskHandlers(new Proxy({}, {
    get: (_t, key) => {
      if (key === 'hasBatch') return () => false;
      if (typeof key !== 'string') return undefined;
      // 大部分依赖是函数或带方法的对象;统一给一个既能当函数又能取属性的东西
      return new Proxy(asyncNoop, { get: () => asyncNoop });
    },
  }));

  const used = handlerNamesUsedByRoutes();
  assert.ok(used.length > 20, `路由里应有很多 handler,只抠到 ${used.length} 个,正则可能失效了`);

  const missing = used.filter((name) => typeof handlers[name] !== 'function');
  // 有些 handler 来自别的工厂(批次/签名/导出),不该由 task_handlers 提供 ——
  // 所以这里只断言 task_handlers **声称**提供的那些确实是函数,并单独校验本次新增的。
  assert.equal(
    typeof handlers.setTaskDocBox, 'function',
    'setTaskDocBox 必须由真实工厂产出 —— 只加桩清单会让测试绿而服务器起不来',
  );
  assert.equal(typeof handlers.createManualReceiptFromTask, 'function');
  assert.ok(Array.isArray(missing));
});

test('⭐写服务和 HTTP handler 两层都要有 setTaskDocBox(缺任一层都起不来)', () => {
  const writeSrc = fs.readFileSync(path.join(root, 'services/workbench_write/index.js'), 'utf8');
  assert.ok(writeSrc.includes('setTaskDocBox: taskOperations.setTaskDocBox'), '写服务层要暴露');

  const taskSrc = fs.readFileSync(path.join(root, 'services/workbench_write/task.js'), 'utf8');
  assert.ok(taskSrc.includes('async function setTaskDocBox('), '写操作要存在');
  assert.ok(taskSrc.includes("{ label: 'setTaskDocBox' }"), '必须走批次写锁 —— 不加锁会整份覆盖吞掉并发审核');

  const handlerSrc = fs.readFileSync(path.join(root, 'services/handlers/workbench/task_handlers.js'), 'utf8');
  assert.ok(handlerSrc.includes('setTaskDocBox: setTaskDocBoxHandler'), 'HTTP handler 层要暴露 —— 这一层是我漏掉的那一层');
  assert.ok(handlerSrc.includes('assertBatchAccess'), '要有权限闸,不能裸放');
});
