'use strict';

// 图片抽取器：可插拔接口。理解层的入口。统一签名 extractImage(imagePath)。
//   - createMockExtractor: 测试/无 key 时用，按 fixture(键=imagePath) 返回固定结果
//   - createQwenExtractor: 真实多模态抽取（阿里云百炼 OpenAI 兼容模式），内部读图编码
// 统一输出契约（见 docs/03 LLM 调用规范：强 schema + 置信度）：
//   { type, passportNo, flightNo, name, fields, confidence }
//   type ∈ passport | receipt | flight | other

const fs = require('node:fs');
const path = require('node:path');

const EXTRACTION_FIELDS = [
  'type',
  'passportNo',
  'flightNo',
  'name',
  'store',
  'purchaseDate',
  'receiptNo',
  'brand',
  'amount',
  'confidence',
];

function normalizeResult(raw = {}) {
  return {
    type: raw.type || 'other',
    passportNo: raw.passportNo || '',
    flightNo: raw.flightNo || '',
    name: raw.name || '',
    departureDate: raw.departureDate || '', // 离境日期(对航班图)，区别于购买日期
    fields: raw.fields || {
      store: raw.store || '',
      purchaseDate: raw.purchaseDate || '',
      departureTime: raw.departureTime || '',
      departureAirport: raw.departureAirport || '',
      receiptNo: raw.receiptNo || '',
      groupNo: raw.groupNo || '',
      brand: raw.brand || '',
      amount: raw.amount ?? null,
    },
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
  };
}

// fixtureMap: { [imagePath]: rawResult }
function createMockExtractor(fixtureMap = {}) {
  async function extractImage(imagePath) {
    const raw = fixtureMap[imagePath];
    if (!raw) {
      return normalizeResult({ type: 'other', confidence: 0 });
    }
    return normalizeResult(raw);
  }
  return { extractImage };
}

// 真实实现：在 Phase 0 跑 385 文件夹时使用，需 DASHSCOPE_API_KEY。
// 单元测试不触达此分支（无 key 时 createQwenExtractor 调用即抛错）。
function createQwenExtractor({
  apiKey = process.env.DASHSCOPE_API_KEY,
  baseUrl = process.env.QWEN_BASE_URL,
  model = process.env.QWEN_EXTRACT_MODEL || 'qwen-vl-max',
  buildPrompt,
  fetchImpl = globalThis.fetch,
  compress = true,
  compressOptions = {},
} = {}) {
  if (!apiKey) {
    throw new Error('createQwenExtractor: 缺少 DASHSCOPE_API_KEY（见 .env.example / docs/04 护照不出境约束）');
  }
  const promptBuilder = buildPrompt || defaultPromptBuilder;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  const maxAttempts = 3;

  async function postWithRetry(body) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000), // 防连接挂起导致整跑卡死
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${detail.slice(0, 160)}`);
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error(`Qwen 抽取失败(重试 ${maxAttempts} 次): ${lastErr.message}`);
  }

  async function extractImage(imagePath) {
    const imageBase64Url = compress
      ? await toCompressedBase64Url(imagePath, compressOptions)
      : toBase64Url(imagePath);
    const body = {
      model,
      messages: [
        { role: 'system', content: promptBuilder() },
        {
          role: 'user',
          content: [
            { type: 'text', text: '提取该图片信息，仅输出 JSON。' },
            { type: 'image_url', image_url: { url: imageBase64Url } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    };
    const json = await postWithRetry(body);
    if (json?.usage) {
      usage.promptTokens += json.usage.prompt_tokens || 0;
      usage.completionTokens += json.usage.completion_tokens || 0;
      usage.totalTokens += json.usage.total_tokens || 0;
      usage.calls += 1;
    }
    const content = json?.choices?.[0]?.message?.content || '{}';
    return normalizeResult(parseJsonLoose(content));
  }

  function getUsage() {
    return { ...usage, model };
  }

  return { extractImage, getUsage };
}

// 模型有时会用 ```json 包裹或带前后说明，做宽松解析
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
}

function toBase64Url(imagePath) {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
}

// 压缩：超过 thresholdBytes 的图等比缩到长边 maxEdge、JPEG 质量 quality，
// 控制上传体积与图像 token。返回 data URL。sharp 失败则回退原图。
async function toCompressedBase64Url(imagePath, { maxEdge = 1600, quality = 80, thresholdBytes = 400 * 1024 } = {}) {
  try {
    const stat = fs.statSync(imagePath);
    if (stat.size <= thresholdBytes) return toBase64Url(imagePath);
    const sharp = require('sharp');
    const buf = await sharp(imagePath)
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return toBase64Url(imagePath);
  }
}

function defaultPromptBuilder() {
  return [
    '你是免税购物单据识别器。判断图片类型并抽取字段，只输出 JSON，不要解释。',
    'type: passport(护照) | receipt(小票) | flight(行程/航班截图) | other。',
    '字段：passportNo(护照号), flightNo(航班号), name(拼音姓名), store(门店),',
    'groupNo(团号，小票上的 G 号), receiptNo(小票号), brand(品牌), amount(金额数字)。',
    '日期要分清两个：purchaseDate=购买/SALE DATE(YYYY-MM-DD)；',
    'departureDate=离境日期 Date of Departure(YYYY-MM-DD)，departureTime=离境时间(HH:MM)，',
    'departureAirport=出发机场。航班截图也要给出 departureDate/departureTime/flightNo。',
    'confidence: 0~1 置信度，看不清/不确定就给低分。缺失字段留空字符串或 null。',
  ].join(' ');
}

module.exports = {
  EXTRACTION_FIELDS,
  normalizeResult,
  toBase64Url,
  toCompressedBase64Url,
  createMockExtractor,
  createQwenExtractor,
};
