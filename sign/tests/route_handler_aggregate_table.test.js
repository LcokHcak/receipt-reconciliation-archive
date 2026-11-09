'use strict';

/**
 * taskHandlers 里被路由用到的每一个 handler,都必须显式出现在
 * workbench_server.js 的聚合表里。
 *
 * 0731 实锤:加 P2-b 的 /reread-box 路由时漏了这张表,结果 **服务启动即炸**
 * (TypeError: argument handler must be a function),而全量 2284 条测试**全绿**。
 *
 * 为什么全绿:装配根用例(workbench_app_factory / workbench_upload_limits)
 * 是拿一份**桩 handler 名单**造出假 handlers 再去注册路由的。我看到它俩红了,
 * 就把新名字加进那两份名单 —— 测试变绿了,真实组装照样是空的。
 * 那两份名单验的是"注册路由这段代码本身能跑",不是"生产真的有这个 handler"。
 * **把测试改绿,不等于把问题改好** —— 这次是从"服务起不来"倒查回来的。
 *
 * 聚合表旁边其实早就写着警告:
 *   resplitTask: taskHandlers.resplitTask, // ⚠️新 handler 必须同步进这张聚合表,漏了=启动即炸
 * 写给人看的警告拦不住人。这条把它变成机器检查。
 *
 * 判据只管 taskHandlers 这一支:聚合表开头是 `...stateHandlers, ...batchHandlers`
 * 两个整体展开,那两支不可能漏(加了就自动带上)。会漏的恰恰是**必须一个个手抄**
 * 的这一支 —— 判据对着病来,不硬扩到扫不准的地方。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

// 剥注释:路由和聚合表的说明里都会提到 handler 名,不剥会把注释里的名字当成真引用
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('⭐taskHandlers 新增的 handler 必须同步进聚合表(漏了=启动即炸,而测试会全绿)', () => {
  const factory = stripComments(read('services/handlers/workbench/task_handlers.js'));
  const routes = stripComments(read('routes/workbench_routes.js'));
  const server = stripComments(read('workbench_server.js'));

  // 1) taskHandlers 工厂**返回**了哪些 handler
  const returnBlock = (factory.match(/\n  return \{([\s\S]*?)\n  \};?\n/) || [])[1] || '';
  assert.ok(returnBlock, 'task_handlers.js 的 return 块没解析到 —— 结构变了?判据要跟着改');
  const exported = [...new Set(
    [...returnBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[,:]/gm)].map((m) => m[1]),
  )];
  assert.ok(exported.length > 10, `taskHandlers 应导出一批 handler,实际只解析到 ${exported.length} 个`);

  // 2) 路由里真正用到的
  const referenced = new Set(
    [...routes.matchAll(/\bhandlers\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  const needed = exported.filter((n) => referenced.has(n));
  assert.ok(needed.length > 5, `应有一批 taskHandlers 被路由使用,实际 ${needed.length} 个`);

  // 3) 聚合表里显式抄了哪些(这一支必须一个个手抄,漏抄就是这次的 bug)
  const provided = new Set(
    [...server.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*taskHandlers\.[A-Za-z_$][\w$]*\s*,/gm)]
      .map((m) => m[1]),
  );

  const missing = needed.filter((n) => !provided.has(n));
  assert.deepEqual(missing, [],
    '这些 handler 路由在用、taskHandlers 也导出了,但 workbench_server.js 的聚合表里没有 ——\n'
    + '生产**启动即炸**,而装配根用例用桩名单会照样绿:\n  '
    + missing.join('\n  ')
    + '\n修法:在聚合表里补 `名字: taskHandlers.名字,`');
});
