/**
 * 一次性:为项目报告合成"演示用"的小票 / 护照图。
 *
 * 为什么要合成而不是拿真图:报告是给外部看的,真图上是真实客户的护照号、姓名、
 * 票号 —— 那是不能出现在报告里的。合成图长得像真单据(字段位置、票号位数都按
 * 业务规则来),但每一个值都是编的,并且盖 DEMO 水印,任何人一眼能看出不是真件。
 *
 * 输出:tmp_report_shots/docs/*.png
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'tmp_report_shots', 'docs');
fs.mkdirSync(OUT, { recursive: true });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 纸张质感:淡灰底 + 细纹,免得纯白看起来像截图不像照片 */
function paper(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#f4f4f2"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#pg)"/>
    ${inner}
    <text x="${w / 2}" y="${h * 0.55}" font-family="Arial" font-size="${w * 0.11}" fill="#d92d20"
          opacity="0.16" text-anchor="middle" transform="rotate(-28 ${w / 2} ${h * 0.55})"
          font-weight="bold">DEMO SAMPLE</text>
    <text x="${w / 2}" y="${h * 0.55 + w * 0.075}" font-family="Arial" font-size="${w * 0.037}" fill="#d92d20"
          opacity="0.16" text-anchor="middle" transform="rotate(-28 ${w / 2} ${h * 0.55})">
      NOT REAL CUSTOMER DATA</text>
  </svg>`;
}

// 注意:这串会插进 SVG 的 font-family="…" 属性里,字体名只能用单引号 ——
// 用双引号会把属性提前闭合,librsvg 直接报 "Opening and ending tag mismatch"。
const mono = "Consolas, 'Courier New', monospace";

/** 免税店小票(按乐天版式:票号 14 位纯数字、团号 8 位) */
function receiptSvg({
  store = 'LOTTE DUTY FREE', branch = 'MYEONGDONG MAIN', receiptNo = '90800626004856',
  tourNo = '26802035', date = '2026-07-10', name = 'HUANG YING', passport = 'ER4848769',
  items = [['CHANEL  N5 EDP 100ML', '1', '138.00'], ['SULWHASOO  SET', '2', '196.00']],
  total = '334.00',
}) {
  const w = 760; const h = 700;
  let y = 290;   // 首个商品行要落在 250 那条分隔线下面,否则压住 DATE 行
  const lines = items.map(([n, q, p]) => {
    const row = `<text x="56" y="${y}" font-family="${mono}" font-size="21" fill="#1a1a1a">${esc(n)}</text>
      <text x="560" y="${y}" font-family="${mono}" font-size="21" fill="#1a1a1a">${q}</text>
      <text x="640" y="${y}" font-family="${mono}" font-size="21" fill="#1a1a1a" text-anchor="start">${p}</text>`;
    y += 38;
    return row;
  }).join('');

  const inner = `
    <text x="${w / 2}" y="76" font-family="Arial" font-size="34" font-weight="bold" fill="#111" text-anchor="middle">${esc(store)}</text>
    <text x="${w / 2}" y="110" font-family="Arial" font-size="20" fill="#444" text-anchor="middle">${esc(branch)}</text>
    <line x1="48" y1="132" x2="${w - 48}" y2="132" stroke="#999" stroke-dasharray="5 5"/>
    <text x="56" y="168" font-family="${mono}" font-size="22" fill="#111">RECEIPT NO : ${receiptNo}</text>
    <text x="56" y="200" font-family="${mono}" font-size="22" fill="#111">GROUP  NO  : ${tourNo}</text>
    <text x="56" y="232" font-family="${mono}" font-size="22" fill="#111">DATE       : ${date}</text>
    <line x1="48" y1="250" x2="${w - 48}" y2="250" stroke="#999" stroke-dasharray="5 5"/>
    ${lines}
    <line x1="48" y1="${y + 6}" x2="${w - 48}" y2="${y + 6}" stroke="#999" stroke-dasharray="5 5"/>
    <text x="56" y="${y + 48}" font-family="${mono}" font-size="26" font-weight="bold" fill="#111">TOTAL  USD ${total}</text>
    <text x="56" y="${y + 96}" font-family="${mono}" font-size="21" fill="#111">NAME     : ${esc(name)}</text>
    <text x="56" y="${y + 128}" font-family="${mono}" font-size="21" fill="#111">PASSPORT : ${passport}</text>
    <g transform="translate(56 ${y + 168})">
      ${Array.from({ length: 46 }, (_, i) => {
    const bw = (i % 4) + 1; const x = i * 14;
    return `<rect x="${x}" y="0" width="${bw}" height="72" fill="#111"/>`;
  }).join('')}
    </g>
    <text x="56" y="${y + 268}" font-family="${mono}" font-size="19" fill="#333">${receiptNo}</text>`;
  return paper(w, h, inner);
}

/** 护照资料页(含 MRZ 两行,位数按真实规格排,但内容是编的) */
function passportSvg({
  type = 'P', country = 'CHN', passportNo = 'EG2451188', surname = 'WANG', given = 'XIAO MING',
  nationality = 'CHINESE', birth = '15 MAR 1988', sex = 'F', expiry = '20 SEP 2032',
}) {
  const w = 1080; const h = 760;
  const mrz1 = `P<${country}${surname}<<${given.replace(/ /g, '<')}`.padEnd(44, '<').slice(0, 44);
  const mrz2 = `${passportNo}<8${country}8803152F3209201<<<<<<<<<<<<<<02`.padEnd(44, '<').slice(0, 44);
  const inner = `
    <rect x="0" y="0" width="${w}" height="118" fill="#123c6b"/>
    <text x="44" y="76" font-family="Arial" font-size="40" font-weight="bold" fill="#fff">PASSPORT</text>
    <text x="${w - 44}" y="76" font-family="Arial" font-size="26" fill="#cddcf0" text-anchor="end">PEOPLE'S REPUBLIC (DEMO)</text>
    <rect x="44" y="160" width="200" height="250" fill="#dfe3e8" stroke="#b7bec7"/>
    <text x="144" y="295" font-family="Arial" font-size="20" fill="#7a828c" text-anchor="middle">PHOTO</text>
    ${[
    ['Type / 类型', type, 300, 200], ['Country code', country, 520, 200],
    ['Passport No.', passportNo, 740, 200],
    ['Surname', surname, 300, 268], ['Given names', given, 520, 268],
    ['Nationality', nationality, 300, 336], ['Date of birth', birth, 520, 336],
    ['Sex', sex, 740, 336], ['Date of expiry', expiry, 300, 404],
  ].map(([label, value, x, yy]) => `
      <text x="${x}" y="${yy}" font-family="Arial" font-size="15" fill="#6b7480">${esc(label)}</text>
      <text x="${x}" y="${yy + 28}" font-family="${mono}" font-size="24" fill="#111">${esc(value)}</text>`).join('')}
    <rect x="0" y="${h - 150}" width="${w}" height="150" fill="#f7f7f5"/>
    <line x1="0" y1="${h - 150}" x2="${w}" y2="${h - 150}" stroke="#c8ccd2"/>
    <text x="44" y="${h - 92}" font-family="${mono}" font-size="27" fill="#111" letter-spacing="2">${esc(mrz1)}</text>
    <text x="44" y="${h - 44}" font-family="${mono}" font-size="27" fill="#111" letter-spacing="2">${esc(mrz2)}</text>`;
  return paper(w, h, inner);
}

// 每个演示客户一套自洽的单据:票面上的票号/团号/姓名/护照号,必须和审核台右侧
// 字段面板里的值一一对上 —— 图文对不上的截图,懂行的人一眼就看出是拼的。
const jobs = [
  ['receipt_lotte.png', receiptSvg({})],
  ['receipt_shilla.png', receiptSvg({
    store: 'THE SHILLA DUTY FREE', branch: 'SEOUL', receiptNo: '3120451160872',
    tourNo: '58021', date: '2026-07-11', name: 'LI MENG', passport: 'EH7712043',
    items: [['LANEIGE  WATER BANK', '3', '84.00'], ['HERA  UV PROTECTOR', '1', '52.00']], total: '136.00',
  })],
  ['passport_huang.png', passportSvg({ passportNo: 'ER4848769', surname: 'HUANG', given: 'YING', birth: '02 JUN 1985', sex: 'F', expiry: '11 APR 2031' })],
  ['passport_li.png', passportSvg({ passportNo: 'EH7712043', surname: 'LI', given: 'MENG', birth: '19 NOV 1990', sex: 'F', expiry: '30 JAN 2033' })],
  ['passport_wang.png', passportSvg({ passportNo: 'EG2451188', surname: 'WANG', given: 'XIAO MING', birth: '15 MAR 1988', sex: 'M', expiry: '20 SEP 2032' })],
];

for (const [file, svg] of jobs) {
  const out = path.join(OUT, file);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`  ✓ ${file}  ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
}
console.log(`\n→ ${OUT}`);
