'use strict';

const MODE_FOLDERS = Object.freeze([
  '乐天首尔',
  '乐天釜山',
  '爱宝客',
  '济州新罗V团',
]);

function isModeFolder(value) {
  return MODE_FOLDERS.includes(String(value || '').trim());
}

module.exports = {
  MODE_FOLDERS,
  isModeFolder,
};
