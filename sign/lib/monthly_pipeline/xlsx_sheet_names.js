'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

/**
 * 从 xlsx(=zip)的 xl/workbook.xml 读权威 **worksheet** 名列表,不解压任何行数据。
 *
 * 与 group_code_multisheet.readWorkbookSheetCount 同一思路(2026-07-21 完整性守卫),
 * 区别:①返回名字不止数量(导入前"有没有目标 sheet"预检要靠名字给清晰报错);
 * ②fd 定点读(EOCD→中央目录→workbook.xml entry),98MB 总账也只读几十 KB,
 *   不像 readFileSync 把整个大文件拉进内存。
 *
 * 解不出(非 zip / zip64 / 结构异常)返回 [] → 调用方自行降级,不阻断导入。
 *
 * ⚠️ 2026-08-01 收窄到 worksheet:workbook.xml 的 <sheets> 里,**图表页
 * (chartsheet)和数据页长得一模一样**,都是 `<sheet name=… r:id=…/>`,
 * 类型只写在 xl/_rels/workbook.xml.rels 的 Relationship Type 上。
 *
 * 不区分的后果实测过(手工造了一份「1 数据页 + 1 图表页」的 xlsx):
 *   readWorkbookSheetNames → 2 张,exceljs WorkbookReader → 1 张
 * 而 xlsx_reader 的完整性守卫判的是 `streamed.sheets.length < expected.length`,
 * 于是**只要源文件里有一张图表页,守卫就恒成立**:
 *   ① 每次导入都白跑一遍整本 workbook.readFile(该文件自己的注释记着实测
 *      内存放大约 360 倍,8.8MB → 3.15GB heap);
 *   ② 超过 WORKBOOK_FALLBACK_MAX_MB(默认 20MB)直接抛 413 ——
 *      本来能成功的大账单/总账导入**变成失败**。
 * 五条导入路径(老版团号表 / 店铺账单 / 未收清单 / 收票台账迁移 / received_receipt)
 * 全走这个守卫。测试夹具都是 exceljs 现场生成、不含图表页,所以两边都测不出来。
 *
 * 读不到 rels(老结构/异常)时**保持原行为返回全部** —— 宁可多跑一次兜底,
 * 也不能因为解析失败把真实的 sheet 丢失漏过去。
 */
function readWorkbookSheetNames(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 22) return [];
    // ① EOCD:固定 22 字节 + 最长 64KB zip 注释,从文件尾部找签名
    const tailLen = Math.min(size, 22 + 65536);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    // zip64(offset/size 打 0xFFFFFFFF 哨兵)不支持 → 空数组降级
    if (!cdSize || cdOffset === 0xFFFFFFFF || cdOffset + cdSize > size) return [];
    // ② 中央目录里找 xl/workbook.xml 条目
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const readEntry = (wanted) => readZipEntryText(fd, cd, cdCount, cdSize, wanted);

    const workbookXml = readEntry('xl/workbook.xml');
    if (!workbookXml) return [];

    // <sheet name="…" r:id="rIdN"/> —— 名字和它的关系 id 一起取出来
    const sheets = [];
    const re = /<(?:\w+:)?sheet\s([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(workbookXml)) !== null) {
      const attrs = m[1];
      const nameM = attrs.match(/\bname="([^"]*)"/);
      if (!nameM) continue;
      const ridM = attrs.match(/\b(?:\w+:)?id="([^"]*)"/);
      sheets.push({ name: decodeXmlEntities(nameM[1]), rid: ridM ? ridM[1] : '' });
    }
    if (!sheets.length) return [];

    // 类型只写在 rels 里:Type 以 /worksheet 结尾的才是能读出数据的表,
    // 图表页(/chartsheet)、对话页(/dialogsheet)、宏表都不是。
    const relsXml = readEntry('xl/_rels/workbook.xml.rels');
    if (!relsXml) return sheets.map((s) => s.name); // 读不到 rels 就保持原行为

    const worksheetRids = new Set();
    const relRe = /<Relationship\s([^>]*?)\/?>/g;
    let r;
    while ((r = relRe.exec(relsXml)) !== null) {
      const attrs = r[1];
      const idM = attrs.match(/\bId="([^"]*)"/);
      const typeM = attrs.match(/\bType="([^"]*)"/);
      if (!idM || !typeM) continue;
      if (/\/worksheet$/.test(typeM[1])) worksheetRids.add(idM[1]);
    }
    // rels 里一个 worksheet 都没认出来 = 解析口径可能不对,别把所有表都判没
    if (!worksheetRids.size) return sheets.map((s) => s.name);

    return sheets.filter((s) => !s.rid || worksheetRids.has(s.rid)).map((s) => s.name);
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * 从已读进内存的中央目录里定位一个条目,定点解压出它的文本。
 * 抽出来是因为现在要读两个条目(workbook.xml + 它的 rels),原来内联在循环里没法复用。
 * 找不到 / 结构异常 / 声明体积离谱 → 返回 null,调用方降级。
 */
function readZipEntryText(fd, cd, cdCount, cdSize, wantedName) {
  let p = 0;
  for (let k = 0; k < cdCount; k += 1) {
    if (p + 46 > cdSize || cd.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wantedName) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const localOffset = cd.readUInt32LE(p + 42);
      // 这两个部件实际永远只有几 KB;畸形文件声明超大 compSize 不给它分配的机会
      if (!compSize || compSize > 8 * 1024 * 1024) return null;
      // local header 30 字节定长 + 变长名/extra,其后才是数据区
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) return null;
      const dataStart = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      fs.readSync(fd, data, 0, compSize, dataStart);
      return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// workbook.xml 属性值里的 XML 实体(sheet 名含 &、<、引号时 Excel 会转义)
function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

module.exports = { readWorkbookSheetNames };
