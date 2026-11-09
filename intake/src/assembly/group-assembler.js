'use strict';

// 客户组完整性装配引擎："自动收图 → 收全客户组"的大脑。
//   1. 内容归组：护照号 / 航班+离境日 / 姓名(复用 grouping-engine)
//   2. 发送上下文兜底：内容归不上的图(主要是共享航班图)，按"同发送者 + 时间窗内
//      唯一匹配某客户"挂上去——解决挂团共享航班的歧义
//   3. 完整性追踪：每个客户组维护 护照/小票/航班 是否到齐，输出"齐了的"和"缺件的"
//
// 输入事件(每张图一条)：
//   { id, type, passportNo, flightNo, departureDate, name, sender, ts, confidence }
//   type ∈ passport | receipt | flight | other；sender=发送者；ts=毫秒时间戳
// 纯函数式，便于离线用合成流测试；不依赖任何真实采集源。

const { group } = require('../grouping/grouping-engine');

const REQUIRED_TYPES = ['passport', 'receipt', 'flight'];
const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 同发送者 5 分钟内算同一提交批次

function createGroupAssembler({ windowMs = DEFAULT_WINDOW_MS, grouping = {} } = {}) {
  const groupingOpts = {
    rejectInvalid: true,
    fuzzy: true,
    maxDistance: 2,
    bridgeFlights: true,
    ...grouping,
  };

  function assemble(events = []) {
    const byId = new Map(events.map((e) => [e.id, e]));
    const { clusters, unassigned } = group(events, groupingOpts);

    // 给每个内容簇挂上成员事件(带 sender/ts)，供发送上下文判断
    const built = clusters.map((c) => ({
      key: c.key,
      name: c.name,
      recordIds: c.recordIds.slice(),
      members: c.recordIds.map((id) => byId.get(id)).filter(Boolean),
    }));

    const stillUnassigned = attachBySendContext(built, unassigned, byId, windowMs);

    const groups = built.map(toGroupView);
    return {
      groups,
      complete: groups.filter((g) => g.complete),
      incomplete: groups.filter((g) => !g.complete),
      unassigned: stillUnassigned,
    };
  }

  return { assemble };
}

// 发送上下文兜底：未归事件，若"同发送者 + 时间窗内"唯一命中某簇，则挂上；否则留人工
function attachBySendContext(built, unassigned, byId, windowMs) {
  const stillUnassigned = [];
  for (const id of unassigned) {
    const e = byId.get(id);
    // 只对单据类(护照/小票/航班)做发送上下文兜底；噪音(other/闲聊)永不挂入客户组
    if (!e || !e.sender || !REQUIRED_TYPES.includes(e.type)) {
      stillUnassigned.push(id);
      continue;
    }
    const candidates = built.filter((c) =>
      c.members.some((m) => m.sender === e.sender && withinWindow(m.ts, e.ts, windowMs))
    );
    if (candidates.length === 1) {
      candidates[0].recordIds.push(id);
      candidates[0].members.push(e);
    } else {
      stillUnassigned.push(id); // 0 个或多个(同发送者同窗多客户)→ 歧义，留人工
    }
  }
  return stillUnassigned;
}

function withinWindow(a, b, windowMs) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= windowMs;
}

function toGroupView(c) {
  const types = new Set(c.members.map((m) => m.type));
  const missing = REQUIRED_TYPES.filter((t) => !types.has(t));
  return {
    key: c.key,
    name: c.name,
    sender: pickSender(c.members),
    recordIds: c.recordIds.slice(),
    has: {
      passport: types.has('passport'),
      receipt: types.has('receipt'),
      flight: types.has('flight'),
    },
    complete: missing.length === 0,
    missing,
  };
}

// 取该组的主要发送者(出现最多的)，用于"缺件催谁补"
function pickSender(members) {
  const count = new Map();
  for (const m of members) {
    if (m.sender) count.set(m.sender, (count.get(m.sender) || 0) + 1);
  }
  let best = '';
  let max = 0;
  for (const [s, n] of count) {
    if (n > max) {
      max = n;
      best = s;
    }
  }
  return best;
}

module.exports = { createGroupAssembler, REQUIRED_TYPES };
