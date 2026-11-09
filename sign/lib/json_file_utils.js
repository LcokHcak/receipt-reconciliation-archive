const fs = require('node:fs');

function stripUtf8Bom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function readJsonFile(filePath) {
  return JSON.parse(stripUtf8Bom(fs.readFileSync(filePath, 'utf8')));
}

module.exports = {
  readJsonFile,
  stripUtf8Bom,
};
