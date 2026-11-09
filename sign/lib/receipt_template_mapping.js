const RECEIPT_TEMPLATE_MAPPING = Object.freeze({
  worksheetName: '수령증',
  fields: Object.freeze({
    travelerName: 'F7',
    passportNumber: 'F8',
    contactPhone: 'F9',
    receiptAmount: 'F10',
    approvalYear: 'C16',
    approvalMonth: 'E16',
    approvalDay: 'F16',
  }),
  signatureImage: Object.freeze({
    tl: Object.freeze({ col: 3.9, row: 18.05 }),
    ext: Object.freeze({ width: 180, height: 60 }),
  }),
});

module.exports = {
  RECEIPT_TEMPLATE_MAPPING,
};
