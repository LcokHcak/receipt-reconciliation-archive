'use strict';

function run({ index, probe }) {
  const matched = index.findDailyByReceiptDate(probe.receiptNo, probe.purchaseDate) || [];
  return { matched, conflicts: [] };
}

module.exports = { run };
