'use strict';

const { STANDARD_MODES } = require('../mode_normalizer');

const RULE_ID = {
  GC_DATE_WINDOW: 'GC_DATE_WINDOW',
  GC_RECEIPT_LEN: 'GC_RECEIPT_LEN',
  GC_TOUR_LEN: 'GC_TOUR_LEN',
  BILL_MODE_ENUM: 'BILL_MODE_ENUM',
  BILL_SHOP_ENUM: 'BILL_SHOP_ENUM',
  CC_DEPARTURE_SYNC: 'CC_DEPARTURE_SYNC',
  CC_NAME_PASSPORT: 'CC_NAME_PASSPORT',
};

const STORE_FAMILIES = Object.freeze(['乐天', '新罗', '爱宝客']);

const RECEIPT_LEN_BY_FAMILY = Object.freeze({
  '乐天': 14,
  '新罗': 13,
  '爱宝客': 13,
});

const TOUR_LEN_BY_FAMILY = Object.freeze({
  '乐天': 8,
  '新罗': 5,
  '爱宝客': 5,
});

module.exports = {
  RULE_ID,
  STORE_FAMILIES,
  RECEIPT_LEN_BY_FAMILY,
  TOUR_LEN_BY_FAMILY,
  STANDARD_MODES,
};
