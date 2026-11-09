'use strict';

function run({ index, probe }) {
  const matched = index.findDailyByNameDateShop(probe.name, probe.purchaseDate, probe.shop) || [];
  return { matched, conflicts: [] };
}

module.exports = { run };
