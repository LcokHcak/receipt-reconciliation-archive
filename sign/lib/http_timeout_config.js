'use strict';

// HTTP 请求超时配置。从 workbench_server.js 抽出来,原因有两个:
//   ① 原来它埋在 1600 行的 server 文件里,唯一的测试是**源码字符串断言**
//      (断言 `server.requestTimeout = httpRequestTimeoutMs` 这行字存在)——
//      那种测试锁得住"写法有没有被删",锁不住"解析出来的值对不对";
//   ② 一测就发现真问题(见下)。
//
// ⚠️ 0729 实测的配错陷阱:原实现是 `Number.parseInt(v, 10) > 0 ? parsed : DEFAULT`,
// 而 parseInt 会**只取前缀数字**,于是这些现实中很可能出现的写法全部静默通过:
//     SIGN_HTTP_REQUEST_TIMEOUT_MS=30m            → 30 毫秒
//     SIGN_HTTP_REQUEST_TIMEOUT_MS=30min          → 30 毫秒
//     SIGN_HTTP_REQUEST_TIMEOUT_MS=30 * 60 * 1000 → 30 毫秒(直接从代码里复制的写法!)
//     SIGN_HTTP_REQUEST_TIMEOUT_MS=1e6            → 1 毫秒
// 30 毫秒的请求超时 = **每一次上传都会立刻断**,而这个系统要传 98MB 的 SMG 总账。
// 配错的人会看到"上传全都失败",却完全想不到是超时配置被解析成了毫秒级。
//
// 两道防线:
//   · 必须是**纯数字串**(不接受任何尾随字符),否则回落默认;
//   · 再设一个下限:低于 1 秒的值几乎不可能是有意的,一律当配错处理。
// 两种情况都**大声报出来**——配置错了要让人看见,不能悄悄用默认值糊过去,
// 否则运维会以为自己那行 env 生效了。

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟
const MIN_SANE_TIMEOUT_MS = 1000;                       // 低于 1 秒 = 几乎必然是单位写错

function resolveHttpRequestTimeoutMs(
  value = process.env.SIGN_HTTP_REQUEST_TIMEOUT_MS,
  { logger = console } = {},
) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return DEFAULT_HTTP_REQUEST_TIMEOUT_MS; // 没配 = 正常,不吭声

  // 纯数字串才收:parseInt('30m')=30 这种前缀解析是本模块要防的头号陷阱
  if (!/^\d+$/.test(raw)) {
    logger?.error?.(
      `[http_timeout] SIGN_HTTP_REQUEST_TIMEOUT_MS="${raw}" 不是纯毫秒数字,已回落默认 `
      + `${DEFAULT_HTTP_REQUEST_TIMEOUT_MS}ms。要 30 分钟请写 1800000,别写 30m / 30 * 60 * 1000。`,
    );
    return DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HTTP_REQUEST_TIMEOUT_MS;

  if (parsed < MIN_SANE_TIMEOUT_MS) {
    logger?.error?.(
      `[http_timeout] SIGN_HTTP_REQUEST_TIMEOUT_MS=${parsed}ms 太短(不足 1 秒),`
      + `按配错处理并回落默认 ${DEFAULT_HTTP_REQUEST_TIMEOUT_MS}ms —— 单位是**毫秒**。`,
    );
    return DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

module.exports = {
  resolveHttpRequestTimeoutMs,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  MIN_SANE_TIMEOUT_MS,
};
