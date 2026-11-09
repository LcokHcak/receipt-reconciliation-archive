'use strict';

// 千问 OCR 后端 —— 统一出口。
// P0:骨架,默认不被装配根启用(SIGN_OCR_BACKEND=paddle)。
// P1:在 workbench_server.js 装配根按 SIGN_OCR_BACKEND=qwen 接线。

const { createQwenOcrBackend } = require('./qwen_ocr_adapter');
const { createQwenDocumentSplitService } = require('./qwen_split_service');
const { resolvePassportNo, parseTd3 } = require('./mrz_parser');
const { resolveCustomerPassport } = require('./passport_resolver');
const { reconcileCustomerPassport } = require('./customer_reconcile');

module.exports = {
  createQwenOcrBackend,
  createQwenDocumentSplitService,
  resolvePassportNo,
  parseTd3,
  resolveCustomerPassport,
  reconcileCustomerPassport,
};
