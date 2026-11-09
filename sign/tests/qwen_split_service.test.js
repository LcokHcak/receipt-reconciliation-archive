'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { createQwenDocumentSplitService } = require('../lib/qwen_ocr/qwen_split_service');
const { readSidecar, hasSidecar } = require('../lib/qwen_ocr/sidecar');

function buildFileName(index, originalname, suffix = '') {
  const parsed = path.parse(String(originalname || 'image.png'));
  return `${String(index + 1).padStart(2, '0')}-${parsed.name}${suffix}${parsed.ext || '.png'}`;
}

async function makeTempImage(dir, name, w = 40, h = 40) {
  const p = path.join(dir, name);
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toFile(p);
  return p;
}

const analysis = (docType, extra = {}) => ({
  docTypeAuto: docType, docTypeFinal: docType, docTypeConfidence: 0.95,
  needsReview: false, reviewReasons: [], classificationSource: 'qwen',
  passportNoAuto: '', extractedNameAuto: '', receiptNoAuto: '', groupNoAuto: '',
  modelMeta: { backend: 'qwen', bbox: [0, 0, 1, 1] }, ...extra,
});

test('qwen_split: 单文档 → 不切,原图旁写 sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    const src = await makeTempImage(dir, 'cust.png');
    const backend = { extractAnalyses: async () => [analysis('passport', { passportNoAuto: 'EQ1035708' })] };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'cust.png', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, false);
    assert.equal(res.outputs.length, 0);
    assert.ok(hasSidecar(src), '原图旁应有 sidecar');
    assert.equal(readSidecar(src).passportNoAuto, 'EQ1035708');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: 多文档 → 裁子图 + 原图reference + 各自 sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    const src = await makeTempImage(dir, 'mix.png', 80, 80);
    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { passportNoAuto: 'EQ1035708', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
        analysis('receipt', { receiptNoAuto: '0326163500159', modelMeta: { backend: 'qwen', bbox: [0.5, 0, 1, 1] } }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'mix.png', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, true);
    assert.equal(res.outputs.length, 3); // original + 2 region
    assert.equal(res.outputs[0].autoSplitRole, 'original');
    assert.equal(res.outputs[1].autoSplitRole, 'region');
    // 每个 output 文件 + sidecar 都在
    for (const out of res.outputs) {
      const p = path.join(dir, out.fileName);
      assert.ok(fs.existsSync(p), `子图 ${out.fileName} 应存在`);
      assert.ok(hasSidecar(p), `子图 ${out.fileName} 应有 sidecar`);
    }
    // region sidecar 带字段
    const passportOut = res.outputs.find((o) => o.docTypeHint === 'passport');
    assert.equal(readSidecar(path.join(dir, passportOut.fileName)).passportNoAuto, 'EQ1035708');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: EXIF 竖拍照片先转正再切(坐标轴错位事故:切片横躺/框住两张票)', async () => {
  // 复现 2026-07-03 蜜蜂批:手机照片带 EXIF orientation=6(原始像素横躺,显示时转90°)。
  // 千问按"转正后"画面给 bbox;修复前直接按原始像素切 → 轴错位。
  // 构造:转正后画面 200x100,左半红右半蓝;原始文件 = 该画面逆时针转90°(100x200)+EXIF 6。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_exif_'));
  try {
    const displayed = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).composite([{
      input: await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer(),
      left: 100, top: 0,
    }]).png().toBuffer();
    const src = path.join(dir, 'phone.jpg');
    // 物理逆时针转90°(顶部=蓝),再打 EXIF orientation=6(浏览器/千问看到的又是左红右蓝)
    await sharp(displayed).rotate(270).jpeg().withMetadata({ orientation: 6 }).toFile(src);

    const backend = {
      extractAnalyses: async () => [
        analysis('receipt', { receiptNoAuto: '1111111111111', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.48, 1] } }),   // 转正画面的左半=红
        analysis('receipt', { receiptNoAuto: '2222222222222', modelMeta: { backend: 'qwen', bbox: [0.52, 0, 1, 1] } }),  // 右半=蓝
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend, paddingPct: 0 });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'phone.jpg', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, true);

    const crops = res.outputs.filter((o) => o.autoSplitRole === 'region');
    assert.equal(crops.length, 2);
    const meanRGB = async (p) => {
      const { channels } = await sharp(p).stats();
      return channels.map((c) => c.mean);
    };
    const [r1] = crops;
    const rgb1 = await meanRGB(path.join(dir, r1.fileName));
    const rgb2 = await meanRGB(path.join(dir, crops[1].fileName));
    // 修复前:切片是原始像素的横条,红蓝各一半(mean 红≈蓝);修复后左片压倒性红、右片压倒性蓝
    assert.ok(rgb1[0] > 200 && rgb1[2] < 60, `左片应为红,实际 RGB=${rgb1.map(Math.round)}`);
    assert.ok(rgb2[2] > 200 && rgb2[0] < 60, `右片应为蓝,实际 RGB=${rgb2.map(Math.round)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: 百货整图不切(乐天百货护照+小票同框"不可裁"),护照号并入同一sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_dept_'));
  try {
    const src = await makeTempImage(dir, 'lotte_dept.png', 80, 80);
    // qwen 把乐天百货同框图误判成 2 个文档(小票+打码护照)——短路必须强制不切
    const backend = {
      extractAnalyses: async () => [
        analysis('receipt', {
          receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678',
          modelMeta: { backend: 'qwen', bbox: [0, 0, 1, 0.6] },
        }),
        analysis('passport', {
          passportNoAuto: 'EG8761171', extractedNameAuto: 'QIN SHIHUANG',
          modelMeta: { backend: 'qwen', bbox: [0, 0.6, 1, 1] },
        }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'lotte_dept.png', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, false, '百货整图不切');
    assert.equal(res.outputs.length, 0);
    const sc = readSidecar(src);
    assert.equal(sc.receiptStoreAuto, 'LOTTE_DEPT');
    assert.equal(sc.receiptNoAuto, '12345678');
    assert.equal(sc.passportNoAuto, 'EG8761171', 'A图打码护照号并入(保险起见提取)');
    assert.deepEqual(sc.modelMeta.bbox, [0, 0, 1, 1], 'bbox 恢复整图');
    // ⭐0729:护照在整图里的位置必须留下来。原来这里只抄护照号和姓名,把 pp 的 bbox 扔了,
    // 而那正是乐天百货交付包打码唯一的依据 → 打码静默失效(全库 352 张 0 命中)。
    // 这个测试早就把 [0,0.6,1,1] 喂进来了,只是从没断言它被保留 —— 断言不到的地方就是黑洞。
    assert.deepEqual(sc.modelMeta.passportBbox, [0, 0.6, 1, 1], '护照区坐标必须留在合并档里');
    assert.equal(sc.modelMeta.passportBboxSource, 'ok', '拿到框 → 标 ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// L597:百货整图不切时,同框其实有 ≥2 张不同交易的百货小票 → 合并成一档会静默丢第二张。
// 安全网:数不同的百货店小票交易编号,≥2 标 dept_multi_receipt_suspect 转人工(只打红标,不改切图契约)。
test('qwen_split L597: 同框 ≥2 张不同交易的百货小票 → 合并档标 dept_multi_receipt_suspect 转人工', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_dept_multi_'));
  try {
    const src = await makeTempImage(dir, 'lotte_dept_multi.png', 80, 80);
    const backend = { extractAnalyses: async () => [
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678' }),
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '87654321' }),
      analysis('passport', { passportNoAuto: 'EG8761171' }),
    ] };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'lotte_dept_multi.png', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, false, '百货整图仍不切');
    assert.equal(res.outputs.length, 0);
    const sc = readSidecar(src);
    assert.equal(sc.needsReview, true, '≥2 张不同交易百货小票 → 转人工');
    assert.ok((sc.reviewReasons || []).includes('dept_multi_receipt_suspect'), '标 dept_multi_receipt_suspect 红标');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split L597: 同框 2 张同交易号百货小票(去重后=1)→ 不误报', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_dept_dup_'));
  try {
    const src = await makeTempImage(dir, 'lotte_dept_dup.png', 80, 80);
    const backend = { extractAnalyses: async () => [
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678' }),
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678' }),
    ] };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'lotte_dept_dup.png', startIndex: 0, buildFileName });
    const sc = readSidecar(src);
    assert.ok(!(sc.reviewReasons || []).includes('dept_multi_receipt_suspect'), '同交易号去重后=1,不误报');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split L597: 1 张百货小票 + 1 张免税/GB 混入票(店名空)→ 只数百货=1,不误报', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_dept_gb_'));
  try {
    const src = await makeTempImage(dir, 'lotte_dept_gb.png', 80, 80);
    const backend = { extractAnalyses: async () => [
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678' }),
      analysis('receipt', { receiptStoreAuto: '', receiptNoAuto: '123456' }), // GB/免税混入,isDeptStore 排除
    ] };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'lotte_dept_gb.png', startIndex: 0, buildFileName });
    const sc = readSidecar(src);
    assert.ok(!(sc.reviewReasons || []).includes('dept_multi_receipt_suspect'), '非百货店票不计入,单张百货不误报');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split L597: 1 张百货小票 + 1 本护照 → 不误报(护照非小票)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_dept_pp_'));
  try {
    const src = await makeTempImage(dir, 'lotte_dept_pp.png', 80, 80);
    const backend = { extractAnalyses: async () => [
      analysis('receipt', { receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '12345678' }),
      analysis('passport', { passportNoAuto: 'EG8761171' }),
    ] };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'lotte_dept_pp.png', startIndex: 0, buildFileName });
    const sc = readSidecar(src);
    assert.ok(!(sc.reviewReasons || []).includes('dept_multi_receipt_suspect'), '护照不算第二张小票,单张百货正常不误报');
    assert.equal(sc.passportNoAuto, 'EG8761171', '护照仍并入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: bbox 退化 → 用原图兜底 + 标记转人工', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    const src = await makeTempImage(dir, 'mix.png', 80, 80);
    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
        analysis('receipt', { modelMeta: { backend: 'qwen', bbox: [0.5, 0, 0.5001, 0.5001] } }), // 退化:几乎0宽高
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'mix.png', startIndex: 0, buildFileName });
    const receiptOut = res.outputs.find((o) => o.docTypeHint === 'receipt');
    const sc = readSidecar(path.join(dir, receiptOut.fileName));
    assert.equal(sc.needsReview, true);
    assert.ok(sc.reviewReasons.includes('qwen_crop_fallback'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 提速②(2026-07-06):切图产物写盘即压缩(与入库压缩同参:长边2400/q82),
// 大图批次拖慢审核台加载的根治。识别不受影响(API 上传前本来就压到长边1280)。
test('qwen_split: 切图产物写盘即压缩(≤2400px/.jpg/显著小于原图);小图不劣化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    // 造一张 4000x3000 噪点大图(噪点难压,贴近真实照片体积)
    const noise = Buffer.alloc(4000 * 3000 * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.floor(Math.random() * 256);
    const src = path.join(dir, 'big.jpg');
    await sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } })
      .jpeg({ quality: 95 }).toFile(src);
    const beforeBytes = fs.statSync(src).size;
    assert.ok(beforeBytes > 2 * 1024 * 1024, `测试前提:原图应为大图(实际 ${beforeBytes})`);

    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
        analysis('receipt', { modelMeta: { backend: 'qwen', bbox: [0.5, 0, 1, 1] } }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: path.join(dir, 'images'), originalFileName: 'big.jpg', startIndex: 0, buildFileName });

    assert.equal(res.splitApplied, true);
    for (const out of res.outputs) {
      const p = path.join(dir, 'images', out.fileName);
      assert.ok(out.fileName.endsWith('.jpg'), `产物应为 .jpg:${out.fileName}`);
      const meta = await sharp(p).metadata();
      assert.equal(meta.format, 'jpeg', '产物内容应为 jpeg');
      assert.ok(Math.max(meta.width, meta.height) <= 2400, `长边应≤2400:${out.fileName}=${meta.width}x${meta.height}`);
      const bytes = fs.statSync(p).size;
      assert.ok(bytes < beforeBytes * 0.5, `产物应显著小于原图:${out.fileName} ${bytes}/${beforeBytes}`);
    }

    // 小图(已在阈值内的 jpeg)原样拷贝,不重复劣化:原图 reference 字节应与源一致
    const small = path.join(dir, 'small.jpg');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } } })
      .jpeg({ quality: 90 }).toFile(small);
    const res2 = await svc.splitImage({ sourcePath: small, imagesDir: path.join(dir, 'images2'), originalFileName: 'small.jpg', startIndex: 0, buildFileName });
    const origOut = res2.outputs.find((o) => o.autoSplitRole === 'original');
    const origBytes = fs.statSync(path.join(dir, 'images2', origOut.fileName)).size;
    assert.equal(origBytes, fs.statSync(small).size, '小 jpeg 原样拷贝(不重复劣化)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 漏切二次调用(2026-07-06):嫌疑 receipt 框(像素宽高比>0.55=可能两张并排框成一张)
// 裁出重调;拆开即采纳(bbox 映射回全图),拆不开保持原判。评测43张真图零误触发。
test('qwen_split: 嫌疑框二次调用拆开 → 采纳并按新框裁片', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_retry_'));
  try {
    const src = path.join(dir, 'two_side_by_side.jpg');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .jpeg().toFile(src);
    let retryCalls = 0;
    const backend = {
      extractAnalyses: async (p) => {
        if (String(p).includes('.retry~')) {
          retryCalls += 1;
          return [
            analysis('receipt', { receiptNoAuto: '1111111111111', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
            analysis('receipt', { receiptNoAuto: '2222222222222', modelMeta: { backend: 'qwen', bbox: [0.5, 0, 1, 1] } }),
          ];
        }
        // 首调:一个"框住两张票"的宽框(800x600 上 0.9x0.9 → 像素宽高比 1.33 > 0.55)
        return [analysis('receipt', { receiptNoAuto: '9999999999999', modelMeta: { backend: 'qwen', bbox: [0.05, 0.05, 0.95, 0.95] } })];
      },
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: path.join(dir, 'images'), originalFileName: 'two.jpg', startIndex: 0, buildFileName });
    assert.equal(retryCalls, 1, '嫌疑框应触发且只触发一次二次调用');
    assert.equal(res.splitApplied, true, '拆开后应走正常切分');
    const regions = res.outputs.filter((o) => o.autoSplitRole === 'region');
    assert.equal(regions.length, 2);
    // bbox 已映射回全图坐标(左半票的框应落在全图左半)
    const left = regions[0].detectionBox;
    assert.ok(left[0] >= 0 && left[2] <= 0.55, `左票框应在全图左半: ${JSON.stringify(left)}`);
    // 二次拆出的 sidecar 带各自字段
    const sc = readSidecar(path.join(dir, 'images', regions[0].fileName));
    assert.equal(sc.receiptNoAuto, '1111111111111');
    assert.equal(sc.modelMeta.secondPassSplit, true);
    // 临时 retry 文件已清
    assert.ok(!fs.existsSync(`${src}.retry~.jpg`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: 二次调用拆不开 → 保持原判(不切)且不改结果;窄框不触发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_retry2_'));
  try {
    // 拆不开:retry 仍只回 1 张
    const src = path.join(dir, 'wide_single.jpg');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .jpeg().toFile(src);
    let retryCalls = 0;
    const backend = {
      extractAnalyses: async (p) => {
        if (String(p).includes('.retry~')) { retryCalls += 1; return [analysis('receipt', {})]; }
        return [analysis('receipt', { receiptNoAuto: '9999999999999', modelMeta: { backend: 'qwen', bbox: [0.05, 0.05, 0.95, 0.95] } })];
      },
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: path.join(dir, 'images'), originalFileName: 'w.jpg', startIndex: 0, buildFileName });
    assert.equal(retryCalls, 1);
    assert.equal(res.splitApplied, false, '拆不开保持单文档不切');
    assert.equal(readSidecar(src).receiptNoAuto, '9999999999999');

    // 窄框(正常长条票)不触发二次调用
    const src2 = path.join(dir, 'narrow.jpg');
    await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .jpeg().toFile(src2);
    let calls2 = 0;
    const backend2 = {
      extractAnalyses: async (p) => {
        if (String(p).includes('.retry~')) { calls2 += 1; return []; }
        return [analysis('receipt', { modelMeta: { backend: 'qwen', bbox: [0.3, 0.05, 0.7, 0.95] } })]; // 像素宽高比 0.33
      },
    };
    const svc2 = createQwenDocumentSplitService({ qwenBackend: backend2 });
    await svc2.splitImage({ sourcePath: src2, imagesDir: path.join(dir, 'images2'), originalFileName: 'n.jpg', startIndex: 0, buildFileName });
    assert.equal(calls2, 0, '窄框零触发(评测43张真图无误触发)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── P2d 改店重切:storeFamilyOverride + forceRefresh ──────────────────────

test('qwen_split: storeFamilyOverride=百货 → 人工店优先,整图不切且sidecar带override店', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_ovr_'));
  try {
    const src = await makeTempImage(dir, 'dept.png', 80, 80);
    // qwen 自判免税店(LOTTE)+ 两文档:不 override 时会走裁切
    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { passportNoAuto: 'EQ1035708', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
        analysis('receipt', { receiptNoAuto: '12345678', receiptStoreAuto: 'LOTTE', modelMeta: { backend: 'qwen', bbox: [0.5, 0, 1, 1] } }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({
      sourcePath: src, imagesDir: dir, originalFileName: 'dept.png', startIndex: 0, buildFileName,
      storeFamilyOverride: 'LOTTE_DEPT',
    });
    assert.equal(res.splitApplied, false, '人工判百货 → 整图不切');
    assert.equal(res.outputs.length, 0);
    const sc = readSidecar(src);
    assert.equal(sc.receiptStoreAuto, 'LOTTE_DEPT', 'sidecar 店家=人工override,批处理不得翻案');
    assert.equal(sc.passportNoAuto, 'EQ1035708', '同框护照信息并入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: storeFamilyOverride=免税店 → 推翻qwen百货自判,照常裁切', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_ovr2_'));
  try {
    const src = await makeTempImage(dir, 'df.png', 80, 80);
    // qwen 自判百货(LOTTE_DEPT):不 override 时会整图短路不切
    const backend = {
      extractAnalyses: async () => [
        analysis('receipt', { receiptNoAuto: '1111111111111', receiptStoreAuto: 'LOTTE_DEPT', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.48, 1] } }),
        analysis('receipt', { receiptNoAuto: '2222222222222', receiptStoreAuto: 'LOTTE_DEPT', modelMeta: { backend: 'qwen', bbox: [0.52, 0, 1, 1] } }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({
      sourcePath: src, imagesDir: path.join(dir, 'images'), originalFileName: 'df.png', startIndex: 0, buildFileName,
      storeFamilyOverride: 'LOTTE',
    });
    assert.equal(res.splitApplied, true, '人工判免税店 → 百货短路不触发,照常裁切');
    assert.equal(res.outputs.length, 3); // original + 2 region
    const regionOuts = res.outputs.filter((o) => o.autoSplitRole === 'region');
    for (const out of regionOuts) {
      assert.equal(readSidecar(path.join(dir, 'images', out.fileName)).receiptStoreAuto, 'LOTTE',
        'region sidecar 店家=override');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: forceRefresh=true → useCache:false 强制重调;默认不带 false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_fr_'));
  try {
    const src = await makeTempImage(dir, 'fr.png');
    const seen = [];
    const backend = {
      extractAnalyses: async (p, opts = {}) => { seen.push(opts.useCache); return [analysis('passport')]; },
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'fr.png', startIndex: 0, buildFileName, forceRefresh: true });
    assert.equal(seen[0], false, 'forceRefresh → useCache:false(绕进程内缓存,毒缓存不得回放)');
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'fr.png', startIndex: 0, buildFileName });
    assert.notEqual(seen[1], false, '默认走缓存(建档主流程行为不变)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: 嫌疑重试拆开后 override 不丢——子调用自判百货也不得翻案人工店', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_ovr3_'));
  try {
    // 宽图+单张过宽 receipt 框 → 触发嫌疑重试;子调用拆出两张"自判百货"的票。
    const src = path.join(dir, 'wide.jpg');
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .jpeg().toFile(src);
    const backend = {
      extractAnalyses: async (p) => {
        if (String(p).includes('.retry~')) {
          return [
            analysis('receipt', { receiptNoAuto: '1111111111111', receiptStoreAuto: 'LOTTE_DEPT', modelMeta: { backend: 'qwen', bbox: [0, 0, 0.48, 1] } }),
            analysis('receipt', { receiptNoAuto: '2222222222222', receiptStoreAuto: 'LOTTE_DEPT', modelMeta: { backend: 'qwen', bbox: [0.52, 0, 1, 1] } }),
          ];
        }
        return [analysis('receipt', { receiptStoreAuto: 'LOTTE', modelMeta: { backend: 'qwen', bbox: [0.02, 0.02, 0.98, 0.98] } })];
      },
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({
      sourcePath: src, imagesDir: path.join(dir, 'images'), originalFileName: 'wide.jpg', startIndex: 0, buildFileName,
      storeFamilyOverride: 'LOTTE',
    });
    // 人工店=免税店 → 子结果的百货自判被 override 压住,不触发整图短路,照常裁两张
    assert.equal(res.splitApplied, true, '重试拆开后按免税店裁切,百货短路不得被子调用自判触发');
    const regions = res.outputs.filter((o) => o.autoSplitRole === 'region');
    assert.equal(regions.length, 2);
    for (const out of regions) {
      assert.equal(readSidecar(path.join(dir, 'images', out.fileName)).receiptStoreAuto, 'LOTTE');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: other 区不再静默丢——多文档切图时一并裁出 _other_N,强制待人工(2026-07-14 审计#7)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    const src = await makeTempImage(dir, 'trio.png', 120, 120);
    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { modelMeta: { backend: 'qwen', bbox: [0, 0, 0.33, 1] } }),
        analysis('receipt', { modelMeta: { backend: 'qwen', bbox: [0.33, 0, 0.66, 1] } }),
        // 真票被误判成 other 的场景:以前这块区域直接消失(零任务零标红)
        analysis('other', { modelMeta: { backend: 'qwen', bbox: [0.66, 0, 1, 1] } }),
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'trio.png', startIndex: 0, buildFileName });
    assert.equal(res.splitApplied, true);
    assert.equal(res.outputs.length, 4, 'original + passport + receipt + other');
    const otherOut = res.outputs.find((o) => /_other_\d+\./.test(o.fileName));
    assert.ok(otherOut, 'other 区必须产出 _other_N 切片');
    const sc = readSidecar(path.join(dir, otherOut.fileName));
    assert.equal(sc.docTypeFinal, 'other');
    assert.equal(sc.needsReview, true, 'other 切片强制人工看一眼');
    assert.ok((sc.reviewReasons || []).includes('qwen_other_region'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('qwen_split: other 区 bbox 退化(噪声)→ 跳过不产片,不做原图兜底刷屏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsplit_'));
  try {
    const src = await makeTempImage(dir, 'noise.png', 120, 120);
    const backend = {
      extractAnalyses: async () => [
        analysis('passport', { modelMeta: { backend: 'qwen', bbox: [0, 0, 0.5, 1] } }),
        analysis('receipt', { modelMeta: { backend: 'qwen', bbox: [0.5, 0, 1, 1] } }),
        analysis('other', { modelMeta: { backend: 'qwen', bbox: [0.98, 0.98, 1, 1] } }), // 极小噪声框
      ],
    };
    const svc = createQwenDocumentSplitService({ qwenBackend: backend });
    const res = await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'noise.png', startIndex: 0, buildFileName });
    assert.equal(res.outputs.length, 3, 'original + 2 张真票;退化 other 不产片');
    assert.ok(!res.outputs.some((o) => /_other_/.test(o.fileName)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 0729:方案甲的命中率取决于「模型是否为同框图单独输出护照档」。存量数据测不出来
// (合并把证据抹了),所以从今天起自己记 —— 下一个真实百货批次跑完就能数出占比,
// 据此决定要不要上方案乙(打包时补检测救存量)。
test('qwen_split 诊断:同框图拿不到护照框时,合并档要标明原因(no_doc / no_bbox)', async () => {
  const mk = async (name, analysesFn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
    const src = await makeTempImage(dir, 'd.png', 80, 80);
    const svc = createQwenDocumentSplitService({ qwenBackend: { extractAnalyses: analysesFn } });
    await svc.splitImage({ sourcePath: src, imagesDir: dir, originalFileName: 'd.png', startIndex: 0, buildFileName });
    const sc = readSidecar(src);
    fs.rmSync(dir, { recursive: true, force: true });
    return sc;
  };
  // ① 没有独立护照档(护照号可能是从小票字段带出来的)
  const noDoc = await mk('qsplit_nodoc_', async () => [
    analysis('receipt', {
      receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '11112222', passportNoAuto: 'E12345678',
      modelMeta: { backend: 'qwen', bbox: [0, 0, 1, 1] },
    }),
  ]);
  assert.equal(noDoc.modelMeta.passportBboxSource, 'no_doc');
  assert.equal(noDoc.modelMeta.passportBbox, undefined, '没框就别塞假框');

  // ② 有护照档但模型没给坐标
  const noBox = await mk('qsplit_nobox_', async () => [
    analysis('receipt', {
      receiptStoreAuto: 'LOTTE_DEPT', receiptNoAuto: '33334444',
      modelMeta: { backend: 'qwen', bbox: [0, 0, 1, 0.6] },
    }),
    analysis('passport', { passportNoAuto: 'E99999999', modelMeta: { backend: 'qwen' } }),
  ]);
  assert.equal(noBox.modelMeta.passportBboxSource, 'no_bbox');
  assert.equal(noBox.modelMeta.passportBbox, undefined);
});
