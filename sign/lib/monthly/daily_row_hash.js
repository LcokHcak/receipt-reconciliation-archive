'use strict';

const crypto = require('node:crypto');

function computeDailyRowHash(row) {
  const src = JSON.stringify({
    ws: row.workspaceKey,
    src: 'workbench',
    receipt: row.receiptNo,
    purchaseDate: row.purchaseDate,
    shop: row.shop,
  });
  return crypto.createHash('sha1').update(src).digest('hex');
}

module.exports = { computeDailyRowHash };
