const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPassportFieldsFromOcr } = require('../lib/paddle_passport_parser');

function line(text, top) {
  return {
    text,
    box: { top, left: 10 },
  };
}

test('extractPassportFieldsFromOcr parses labelled passport lines', () => {
  const result = extractPassportFieldsFromOcr({
    lines: [
      line('PASSPORT', 10),
      line("PEOPLE'S REPUBLIC OF CHINA", 20),
      line('Surname', 30),
      line('ZHANG', 40),
      line('Given Names', 50),
      line('SAN', 60),
      line('姓名', 70),
      line('张三', 80),
      line('Passport No EJ1234567', 90),
      line('P<CHNZHANG<<SAN<<<<<<<<<<<<<<<<<<<<<<', 100),
      line('EJ1234567CHN9001011M3001012<<<<<<<<<<', 110),
    ],
  });

  assert.equal(result.englishName, 'ZHANG SAN');
  assert.equal(result.chineseName, '张三');
  assert.equal(result.passportNo, 'EJ1234567');
});

test('extractPassportFieldsFromOcr falls back to MRZ when labels are missing', () => {
  const result = extractPassportFieldsFromOcr({
    lines: [
      line('P<CHNLI<<SI<<<<<<<<<<<<<<<<<<<<<<<<<<', 10),
      line('EA1234567CHN9001011M3001012<<<<<<<<<<', 20),
    ],
  });

  assert.equal(result.englishName, 'LI SI');
  assert.equal(result.passportNo, 'EA1234567');
});

test('extractPassportFieldsFromOcr rejects non-passport MRZ2 helper text', () => {
  const result = extractPassportFieldsFromOcr({
    lines: [
      line('P<CHNYAN<<LI<<<<<<<<<<<<<<<<<<<<<<<<', 10),
      line('POCHNYAN<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 20),
    ],
  });

  assert.equal(result.englishName, 'YAN LI');
  assert.equal(result.passportNo, '');
});

test('extractPassportFieldsFromOcr strips English-name region helper prefixes', () => {
  const result = extractPassportFieldsFromOcr({
    lines: [
      line('English Name', 10),
      line('POCHNXUE YUCHEN', 20),
      line('Passport No EG8761171', 30),
    ],
  });

  assert.equal(result.englishName, 'XUE YUCHEN');
  assert.equal(result.passportNo, 'EG8761171');
});
