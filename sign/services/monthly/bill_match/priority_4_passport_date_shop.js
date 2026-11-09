'use strict';

function run({ index, probe }) {
  const matched = index.findDailyByPassportDateShop(probe.passportNo, probe.purchaseDate, probe.shop) || [];
  return { matched, conflicts: [] };
}

module.exports = { run };
