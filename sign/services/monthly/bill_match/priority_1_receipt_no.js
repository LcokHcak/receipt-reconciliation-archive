'use strict';

function run({ index, probe }) {
  const matched = index.findDailyByReceipt(probe.receiptNo) || [];
  return { matched, conflicts: [] };
}

module.exports = { run };
