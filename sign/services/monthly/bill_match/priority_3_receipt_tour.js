'use strict';

function run({ index, probe }) {
  const matched = index.findDailyByReceiptTour(probe.receiptNo, probe.tourNo) || [];
  return { matched, conflicts: [] };
}

module.exports = { run };
