'use strict';

function run({ index, probe }) {
  const matched = index.findDailyFuzzy ? (index.findDailyFuzzy(probe) || []) : [];
  return { matched, conflicts: [] };
}

module.exports = { run };
