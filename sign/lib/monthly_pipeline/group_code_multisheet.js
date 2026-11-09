'use strict';

/**
 * 多-sheet 团号表抽取(2/3 月起的新格式)。
 *
 * 老格式是单 sheet、带「团号/代理/模式」表头(见 group_code_mapper)。新格式是十几个
 * 异构 sheet(乐天团号/乐天现场登记/新罗 首尔&济州/爱宝客SG…),没有统一表头,
 * 团号靠各 sheet 的固定列、且有左右双块(一行两个团号)。
 *
 * 本模块抽「团号 + 模式标识」——模式来自各 sheet 的固定列或块级标签,归一化成渠道模式
 * (乐天SG/乐天釜山/爱宝客PKG…)写进 gc.mode。tour_match 据此把模式带给操作员;
 * 操作员在「模式归类」面板手动选模式→桶(系统不自动归桶)。验证:团号表→首尔/釜山判错 0。
 *   - 乐天:列6(乐天团号)/列4 入店公司(现场登记)归一化;号段 268=釜山兜底。
 *   - 同一团号多处出现:釜山/特殊优先,其次明确模式,最后默认 SG(避免被首尔行覆盖)。
 *   - 代理留空:团号表代理列与收票口径不一致(会误判 ~38% agent_mismatch),只做"团号存在 + 模式"。
 *
 * 解析走流式 WorkbookReader 逐行 emit(F1 2026-07-20):整本 readFile 把 9 万有值行的
 * cell 对象+styles 全载入吃 ~3.15GB heap,叠加主进程撞 pm2 4GB 内存线 → 解析被杀、
 * 批次永卡「解析中」。流式同表峰值仅 0.27GB。历史担心「WorkbookReader 对部分文件抛错」,
 * 故 stream 抛错时降级整本 readFile 兜底(parseViaReadFile),两路共用 applyRowToByTour 抽取。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const ExcelJS = require('exceljs');
const { hashFileStream } = require('./row_hasher');

// 解析子线程脚本(只按文件路径引用,不 require,避免循环依赖)。
const PARSE_WORKER_PATH = path.join(__dirname, 'group_code_parse_worker.js');

// 抽取逻辑版本:改了 SHEET_CONFIG / lotteChannelMode / 抽取规则就 +1,使旧缓存失效。
const EXTRACT_VERSION = 'v2'; // v2=2026-07-10 团号保字母(曾 digits() 剥字母,表侧存 2600041 与收票侧 26V00041 永远对不上)
// 解析结果缓存:同一份团号表(按内容 hash)只用 exceljs 整本解析一次。
// 8.8MB / 14-sheet 团号表整本载入约 18~60s 且会卡 event loop 3~10s;7 月 30 人各导一次
// 同一份月度团号表,命中缓存即跳过解析、亚秒返回。只缓存「与文件内容相关」的 tour→mode
// 提取结果;workspaceKey / importedAt / rowHash 出缓存时按调用方重建(见 buildRows)。
const PARSE_CACHE_MAX = 8; // 最多缓存 8 份不同团号表(每份约 0.5MB,FIFO 淘汰最旧)
const parseCache = new Map(); // `${EXTRACT_VERSION}:${fileHash}` → { tourModes:[{tourNo,mode}], sheetNames }
const inFlightParse = new Map(); // 同 key → Promise,30 人同时导同一份新表只解析 1 次,其余 await

// 并发解析 worker 闸:30 人各自从在线表格下载的团号表字节多半不同(时间戳变)→ 去重 miss,
// 若不限,30 人同时导 = spawn 30 个 worker,每个加载 exceljs+8.8MB ≈ 上百 MB,在 4 核/7.5G
// 服务器上会 OOM/线程打架。限并发(默认 2,与批次并发对齐),其余排队,内存/CPU 可控。
// 默认 1:exceljs 整本载入百万行 sheet 吃内存(实测单次需 ~GB),worker 默认堆小会 OOM 崩。
// 后台化后导入不等解析,串行(1 个)足够且内存安全。需要并行可调大,但要同步留够 RAM。
const MAX_PARSE_WORKERS = Math.max(1, Number.parseInt(process.env.GROUPCODE_PARSE_WORKERS || '1', 10) || 1);
// worker 堆上限:实测 8.8MB 团号表解析 heapTotal 顶到 3.04GB,10MB 文件更大 → 给 4GB 留余量。
// 单进程 7.5G 服务器 + MAX_PARSE_WORKERS=1,4GB worker 安全。超了会 OOM→reject→优雅失败不冻结。
const PARSE_WORKER_HEAP_MB = Math.max(512, Number.parseInt(process.env.GROUPCODE_PARSE_HEAP_MB || '4096', 10) || 4096);
let activeParseWorkers = 0;
let peakParseWorkers = 0; // 观测用:历史最大同时解析数,不应超过 MAX_PARSE_WORKERS
const parseSlotWaiters = [];
function acquireParseSlot() {
  if (activeParseWorkers < MAX_PARSE_WORKERS) {
    activeParseWorkers += 1;
    if (activeParseWorkers > peakParseWorkers) peakParseWorkers = activeParseWorkers;
    return Promise.resolve();
  }
  return new Promise((resolve) => parseSlotWaiters.push(resolve));
}
function releaseParseSlot() {
  const next = parseSlotWaiters.shift();
  if (next) next(); // 槽位直接转交下一个等待者(activeParseWorkers 不变)
  else activeParseWorkers -= 1;
}

const cell = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return (v.text || v.result || (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : '') || '').toString().trim();
  return String(v).trim();
};
const { normalizeGroupNo } = require('../workbench_field_normalizer');

// 每个 sheet 的抽取配置(列号 1-based)。一行多个团号块 → 多组。
//   tour/agent: 团号列 / 代理列(代理读了但不落库)
//   modeCol:    模式标识列(乐天:列6 团号表 / 列4 现场登记入店公司)→ 过 lotteChannelMode 归一化
//   modeLabel:  块/ sheet 级固定模式(无需归一化)
// 纯导游/积分卡 sheet 不在此表 → 跳过。
const SHEET_CONFIG = {
  乐天现场登记: [{ tour: 5, agent: 9, modeCol: 4 }],
  乐天团号: [{ tour: 4, agent: 5, modeCol: 6 }],
  '2月乐天SG团号': [{ tour: 4, agent: 5, modeLabel: '乐天SG' }],
  '3月乐天SG团号': [{ tour: 4, agent: 5, modeLabel: '乐天SG' }],
  爱宝客SG: [{ tour: 1, agent: 2, modeLabel: '爱宝客SG' }, { tour: 6, agent: 7, modeLabel: '爱宝客PKG' }],
  爱宝客C: [{ tour: 1, agent: 2, modeLabel: '爱宝客C' }],
  '新罗 首尔&济州': [{ tour: 1, agent: 2, modeLabel: '新罗V团' }, { tour: 8, agent: 9, modeLabel: '新罗V团' }, { tour: 13, agent: 12, modeLabel: '济州新罗V团' }],
  新世界现场: [{ tour: 5, agent: 4, modeLabel: '新世界' }],
  新世界SG团号: [{ tour: 5, agent: 6, modeLabel: '新世界' }],
  现代SG: [{ tour: 1, agent: 2, modeLabel: '现代' }, { tour: 6, agent: 7, modeLabel: '现代SG' }],
};

// 乐天模式列原文(「乐天釜山」「釜山혜신」「H团혜신」「SG조이앤」「蚕室」…)→ 渠道模式
function lotteChannelMode(rawMode, tourNo) {
  const m = String(rawMode || '').replace(/\s+/g, '');
  // 号段判定用数字投影(比较投影=A类合法):字母团号也能取到正确数字前缀。
  const pfx = String(tourNo || '').replace(/[^0-9]/g, '').slice(0, 3);
  if (/釜山.*P特殊|釜山特殊P|P特殊/.test(m)) return '乐天釜山P特殊';
  if (/釜山/.test(m) || pfx === '268') return '乐天釜山';
  if (/H团/.test(m)) return '乐天H团';
  if (/B团/.test(m)) return '乐天B团';
  if (/R团/.test(m)) return '乐天R团';
  if (/PKG/i.test(m)) return '乐天PKG';
  if (/济州/.test(m)) return '济州乐天';
  return '乐天SG'; // 蚕室/SG조이앤/261 号段默认首尔 SG
}

const isBusanMode = (m) => /釜山/.test(String(m || ''));
// 去重优先级:釜山/特殊(3) > 明确非默认模式(2) > 默认乐天SG(1)
function modePriority(m) {
  if (isBusanMode(m)) return 3;
  if (m && m !== '乐天SG') return 2;
  return 1;
}

/** 工作簿是否是新多-sheet 格式(有任一已知 sheet 名) */
function isMultisheetWorkbook(sheetNames) {
  return sheetNames.some((n) => Object.prototype.hasOwnProperty.call(SHEET_CONFIG, String(n).trim()));
}

// exceljs 整本解析 → 抽 tour→mode(纯内容,不含 workspaceKey/importedAt)。这是 18~60s 的
// 重活,按文件内容 hash 缓存。返回 { tourModes:[{tourNo,mode}], sheetNames }。
// 单行抽取(stream/readFile 两路共用,保证逐字一致):把一行按 blocks 抽出 tour→mode 落 byTour。
// exceljs 行值 1-based(vals[1]=A 列),stream 与 readFile 的 row.values 同结构。
function applyRowToByTour(byTour, blocks, vals) {
  for (const b of blocks) {
    // 团号走中央口径保字母(26V00041/R2299001);数字投影只做"像不像团号"的行过滤(A类,不落库)。
    const tourNo = normalizeGroupNo(cell(vals[b.tour]));
    const digitCore = tourNo.replace(/[^0-9]/g, '');
    if (tourNo === '无' || !digitCore || digitCore.length < 4) continue;
    const mode = b.modeLabel || lotteChannelMode(cell(vals[b.modeCol]), tourNo);
    const existing = byTour.get(tourNo);
    if (existing == null || modePriority(mode) > modePriority(existing)) {
      byTour.set(tourNo, mode);
    }
  }
}

// 权威 sheet 数(2026-07-21 复核 CRITICAL 守卫用):直接解 xlsx(=zip)的 xl/workbook.xml,
// 数 <sheet> 声明。轻量(只 inflate workbook.xml 这一个小 entry,不碰行数据),用于校验流式
// 解析有没有静默丢 sheet。解不出(非 zip / 结构异常)返回 0 → 守卫不介入,退回原行为不阻断。
function readWorkbookSheetCount(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return 0;
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdCount = buf.readUInt16LE(eocd + 10);
    let p = cdOffset;
    for (let k = 0; k < cdCount; k += 1) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'xl/workbook.xml') {
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const localOffset = buf.readUInt32LE(p + 42);
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const compData = buf.subarray(dataStart, dataStart + compSize);
        const xml = (method === 0 ? compData : zlib.inflateRawSync(compData)).toString('utf8');
        const matches = xml.match(/<(?:\w+:)?sheet\s/g); // <sheet .../> 元素,不匹配 <sheets> 容器
        return matches ? matches.length : 0;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return 0;
  } catch { return 0; }
}

// 流式逐行读(F1 2026-07-20):exceljs 整本 readFile 把 9 万有值行的 cell 对象+styles 全载入
// 吃 ~3.15GB heap(实测原版 10MB 月度表),叠加主进程撞 pm2 4GB max_memory_restart → 解析中途
// 被杀、批次永卡「解析中」。WorkbookReader 逐行 emit 内存平稳(同表实测峰值 0.27GB / 8.2s),
// 不整本驻留。styles/hyperlinks/entries 全 ignore(只要 cell 值,富文本/公式 result 仍在 row.values)。
async function parseViaStream(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit', sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore', entries: 'ignore',
  });
  const byTour = new Map(); // tourNo → mode;同团号多处出现按 modePriority 取胜
  const sheetNames = [];
  for await (const ws of reader) {
    const sheetName = String(ws.name || '').trim();
    sheetNames.push(sheetName);
    const blocks = SHEET_CONFIG[sheetName];
    // 非团号 sheet 也要把 row 迭代器消费完(否则 for-await 无法进入下一 sheet),只是不抽取。
    for await (const row of ws) {
      if (blocks) applyRowToByTour(byTour, blocks, row.values || []);
    }
  }
  const tourModes = [];
  for (const [tourNo, mode] of byTour) tourModes.push({ tourNo, mode });
  return { tourModes, sheetNames };
}

// 整本 readFile 兜底:历史注释记录 WorkbookReader 对「部分文件」解析会抛错 —— 保留原路径,
// stream 抛错时降级(内存高但兼容),不因流式改造丢掉那些文件的解析能力。
async function parseViaReadFile(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const byTour = new Map();
  const sheetNames = [];
  for (const ws of wb.worksheets) {
    const sheetName = String(ws.name || '').trim();
    sheetNames.push(sheetName);
    const blocks = SHEET_CONFIG[sheetName];
    if (!blocks) continue;
    ws.eachRow((row) => applyRowToByTour(byTour, blocks, row.values || []));
  }
  const tourModes = [];
  for (const [tourNo, mode] of byTour) tourModes.push({ tourNo, mode });
  return { tourModes, sheetNames };
}

async function parseWorkbookTourModes(filePath) {
  try {
    const result = await parseViaStream(filePath); // 低内存优先,不撞 pm2 内存线
    // 完整性守卫(2026-07-21 复核 CRITICAL):exceljs stream WorkbookReader 对某些 zip entry
    // 顺序的文件会静默丢整个 sheet(不抛错但结果残缺)——某渠道 sheet 团号会无声消失、对应小票
    // 误判 tour_not_found 送补救,且无任何线索指向"解析器丢了一个 sheet"。对照 workbook.xml 权威
    // sheet 数,流式少读了 sheet → 判定不可靠,降级整本 readFile(内存高但结果完整,数据完整性优先)。
    const expected = readWorkbookSheetCount(filePath);
    if (expected > 0 && result.sheetNames.length < expected) {
       
      console.warn(`[group_code] 流式只读到 ${result.sheetNames.length}/${expected} 个 sheet,疑似静默丢 sheet → fallback readFile`);
      return parseViaReadFile(filePath);
    }
    return result;
  } catch (streamErr) {
    // stream 抛错(旧格式/损坏)→ 降级整本 readFile。留痕:worker console 进 pm2 日志,可查。
     
    console.warn(`[group_code] stream parse failed, fallback to readFile: ${streamErr?.message || streamErr}`);
    return parseViaReadFile(filePath);
  }
}

// 缓存命中或解析后,把 tour→mode 提取结果按本次调用的 workspaceKey/importedAt 重建成
// group_code repo 可插入的完整行(rowHash 依赖 workspaceKey+tourNo,必须每次重算)。
function buildRows({ tourModes, workspaceKey, importedAt, importJobId }) {
  const at = importedAt || new Date().toISOString();
  return tourModes.map(({ tourNo, mode }) => ({
    workspaceKey,
    tourNo,
    // 模式来自团号表 → 操作员在「模式归类」手动选模式→桶(代理列口径不一致,留空)
    mode,
    modeNormalized: mode,
    agent: null,
    upstream: null,
    passportNo: null,
    name: null,
    rowHash: crypto.createHash('sha1').update(`${workspaceKey}|${tourNo}`).digest('hex'),
    importedAt: at,
    importJobId,
  }));
}

// 把 exceljs 整本解析放进 worker 子线程,主线程 event loop 不被占住。
// ⚠️ 绝不回退主线程:worker OOM/崩了一旦回主线程解析,会把整个单进程 event loop 堵死
// (实测 140 秒,还冻结所有人)。所以 worker 失败就 reject,由调用方标"解析失败"优雅处理,
// 而不是用主线程阻塞去"兜底"。worker 堆给足(PARSE_WORKER_HEAP_MB)让正常文件不 OOM。
function parseOffMainThread(filePath) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(PARSE_WORKER_PATH, {
        workerData: { filePath },
        resourceLimits: { maxOldGenerationSizeMb: PARSE_WORKER_HEAP_MB },
      });
    } catch (spawnError) {
      reject(new Error(`group code parse worker spawn failed: ${spawnError?.message || spawnError}`));
      return;
    }
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; worker.terminate(); fn(arg); } };
    worker.once('message', (msg) => {
      if (msg && msg.ok) done(resolve, { tourModes: msg.tourModes, sheetNames: msg.sheetNames });
      else done(reject, new Error(msg?.error || 'group code parse worker failed'));
    });
    // OOM / 内部崩溃 → reject(不堵主线程)。调用方(后台解析)会落 status='failed'。
    worker.once('error', (err) => done(reject, err instanceof Error ? err : new Error(String(err))));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) done(reject, new Error(`group code parse worker exited ${code}`));
    });
  });
}

// worker 解析 + 并发闸:拿到槽位才 spawn worker,跑完释放槽位给下一个等待者。
async function runGatedParse(filePath) {
  await acquireParseSlot();
  try {
    return await parseOffMainThread(filePath);
  } finally {
    releaseParseSlot();
  }
}

// 取-或-解析:缓存命中直接返回;未命中且别人正在解析同一份(in-flight)则 await 它;
// 都没有才真正解析(走 worker 子线程,且受并发闸限制)。30 人同时导同一份新表 → 只解析 1 次。
async function getOrParseTourModes(filePath) {
  let fileHash;
  try {
    fileHash = await hashFileStream(filePath);
  } catch {
    // hash 不出来(文件异常)就退回直接解析,不缓存,行为与旧版一致。
    return runGatedParse(filePath);
  }
  const key = `${EXTRACT_VERSION}:${fileHash}`;
  const cached = parseCache.get(key);
  if (cached) return cached;
  const pending = inFlightParse.get(key);
  if (pending) return pending;

  const promise = runGatedParse(filePath)
    .then((result) => {
      parseCache.set(key, result);
      while (parseCache.size > PARSE_CACHE_MAX) {
        parseCache.delete(parseCache.keys().next().value); // FIFO 淘汰最旧
      }
      return result;
    })
    .finally(() => {
      inFlightParse.delete(key);
    });
  inFlightParse.set(key, promise);
  return promise;
}

/**
 * 抽团号 + 模式标识。返回 group_code repo.insertMany 可用的行数组。
 * 解析结果按文件内容 hash 缓存,同一份团号表重复导入跳过 18~60s 的 exceljs 解析。
 * @returns {Promise<{rows: Array, sheetNames: string[]}>}
 */
async function extractMultisheetGroupCode({ filePath, workspaceKey, importJobId = null, importedAt = null }) {
  const { tourModes, sheetNames } = await getOrParseTourModes(filePath);
  const rows = buildRows({ tourModes, workspaceKey, importedAt, importJobId });
  return { rows, sheetNames };
}

module.exports = {
  extractMultisheetGroupCode,
  isMultisheetWorkbook,
  SHEET_CONFIG,
  lotteChannelMode,
  parseWorkbookTourModes, // 供 group_code_parse_worker.js 在子线程复用
  readWorkbookSheetCount, // 流式完整性守卫依据(测试用)
  // 观测/测试用:当前与峰值并发解析数(峰值不应超过 MAX_PARSE_WORKERS)。
  __getParseWorkerStats: () => ({ active: activeParseWorkers, peak: peakParseWorkers, max: MAX_PARSE_WORKERS }),
};
