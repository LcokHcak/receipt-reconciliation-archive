'use strict';

/**
 * merge_service — 兼容薄壳(2026-06-13 合并双实现)。
 *
 * 历史上本文件是一份**独立的 merge 实现**,与生产用的 merge_streaming_service 并存。
 * 两者曾分叉,是退货冲减 bug(d1256ea)的根源(见 AGENT_SHARED_MEMORY §5.5 模式#3「双实现」)。
 * 现已合并:本文件不再有独立逻辑,createMergeService 直接委托 createMergeStreamingService,
 * 杜绝再次分叉。仅为旧测试/脚本(10+ 调用方)保留 createMergeService 入口。
 *
 * 入参兼容:streaming 多一个可选 `db`(用于分批事务写);旧调用方不传 db 时 streaming 走
 * 非事务直写,行为与旧 merge_service 等价。**新代码请直接用 createMergeStreamingService。**
 */

const { createMergeStreamingService } = require('./merge_streaming_service');

function createMergeService(deps) {
  return createMergeStreamingService(deps);
}

module.exports = { createMergeService };
