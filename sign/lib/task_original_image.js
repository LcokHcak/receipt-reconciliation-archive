'use strict';

/**
 * task_original_image —— 「这条任务对应的整张原图在盘上哪儿」。
 *
 * 为什么单独成文件:原来这段只长在 HTTP handler 里(getTaskOriginalImage,供图给前端看)。
 * P2 引导式补票要在**写路径**上问同一个问题(新任务得指向原图,否则画不了框),
 * 于是必须共用同一份答案。复制第二份的后果是静默的 —— 供图那边好好的、补票这边指到别处,
 * 谁也不报错,等到交付时才发现出的是别人的图。
 *
 * 约定:task.sourceOriginalPath 形如 `<workspaceKey>/<customerId>/<fileName>`,
 * 切分前的完整原图留在客户库(`<NN>-<base>_original.*`,被刻意排除在批次外),
 * 按切片名回溯供图;没切过的图本身即原图。
 */

const fs = require('node:fs');
const path = require('node:path');

const { SLICE_SUFFIX_RE, LIBRARY_SLICE_RE } = require('./slice_file_name');

// 0731 收敛:这两个判据原来在四个文件里各写一份,其中 delivery_render 和
// review_doc_regions **同名 SPLIT_FILE_RE 却是两个不同的正则**(一个要 NN- 前缀、
// 一个不要)。真数据 230 个文件名里有 7 个两者结论相反 —— 今天各自用在对的字段上,
// 所以还不是活 bug,但 import 错一个不会有任何报错。单一真相源:lib/slice_file_name。
// 那边保留了两条来之不易的注记:四种角色都要认、以及锚开头误拦 29% 那次事故。

// 客户库切片名(能反解出原图 base)
const SPLIT_NAME_RE = LIBRARY_SLICE_RE;
// "是不是切片"(批次内名带 task_NNNN__ 前缀,只能按后缀认)
const SPLIT_NAME_SUFFIX_RE = SLICE_SUFFIX_RE;

/**
 * @param {object} task 至少要有 sourceOriginalPath
 * @param {(workspaceKey: string, customerId: string) => string} customerDir
 * @param {{readdirSync: Function, existsSync: Function}} fsImpl 便于测试注入
 * @returns {{path: string, isOriginal: boolean, error: string}}
 *   path 为空表示解析失败,error 是给人看的话(会直接进 400 响应)。
 */
function resolveTaskOriginalImagePath(task, customerDir, fsImpl = fs) {
  const src = String(task?.sourceOriginalPath || '').trim();
  const parts = src.split('/');
  if (parts.length !== 3) {
    return { path: '', isOriginal: false, error: '这条任务没有客户库来源图,找不到整张原图' };
  }
  // 纵深防御:sourceOriginalPath 虽是服务端落盘值(写入方已 basename 化),
  // 但这个值最终会被 sendFile / 文件拷贝使用,自己必须再锁一道。
  // 任何一段含路径分隔 / ".." 即拒,防未来写入方改口径引入逃逸。
  if (parts.some((p) => !p || p === '..' || p !== path.basename(p) || p.includes('\\'))) {
    return { path: '', isOriginal: false, error: '这条任务的来源图路径不合法' };
  }
  const [workspaceKey, customerId, fileName] = parts;
  const imagesDir = path.join(customerDir(workspaceKey, customerId), 'images');

  let target = path.join(imagesDir, fileName);
  let isOriginal = !SPLIT_NAME_RE.test(fileName); // 没切过的图本身即原图
  const splitMatch = fileName.match(SPLIT_NAME_RE);
  if (splitMatch) {
    let candidate = '';
    try {
      candidate = fsImpl.readdirSync(imagesDir)
        .find((f) => f.includes(`-${splitMatch[1]}_original.`)) || '';
    } catch { /* 目录读失败 → 走切片自身兜底 */ }
    if (candidate) {
      target = path.join(imagesDir, candidate);
      isOriginal = true;
    }
    // 回溯不到就退回切片自身,但 isOriginal 保持 false —— 调用方据此知道
    // 「这不是整张原图」,不该在它上面按原图坐标画框。
  }

  // 最后收口:目标必须仍在该客户 images 目录内(与 customer_image_review_service 同款约定)
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${path.resolve(imagesDir)}${path.sep}`)) {
    return { path: '', isOriginal: false, error: '这条任务的来源图路径不合法' };
  }
  if (!fsImpl.existsSync(resolved)) {
    return { path: '', isOriginal: false, error: '客户库里的原图已经不在了(可能被清理或重传过)' };
  }
  return { path: resolved, isOriginal, error: '' };
}

// 「这条任务的**图片文件**是整张照片(不是切片)」。
//
// ⚠️⚠️ 别和 frontend/src/lib/reviewDisplay.isOriginalLikeTask、
// lib/agent_workspace/customer_projection.isOriginalLikeTask 合并 —— 那两个是**另一件事**:
//   它们判的是「这条任务是切图时额外产的**整图参考件**」(autoSplitRole==='original',
//   docType=OTHER、needsReview=false、sidecar 里 note:'original_reference'),
//   用途是**把它排除出审核流**(不计数、不参与批量通过、排序殿后)。
// 本函数判的是「文件是不是切片」,用途是**能不能画框 / 要不要给 originalImageUrl**。
//
// 两者在"一图一单据"的真实数据上**结论相反**:那种任务文件是整图(本函数 true),
// 但它就是要审的那张票(参考件判定 false)。合并 = 把绝大多数真任务当成参考件
// 整体踢出审核流,而且不会报错。2026-07-31 差点合并,靠这段注释拦下。
//
// ⚠️ 首要判据是**它指向的文件是不是切片**,不是有没有标记。
// 2026-07-30 金标全量实跑(20 客户 / 83 张真实图)实测:83/83 的 autoSplitRole 和
// preprocessMessage **都是空字符串** —— 只看标记会把这批(真实业务里的绝大多数)
// 全判成"不是整图",于是 buildOriginalImageUrl 给它们发端点 URL,
// imageUrl 就绕过 1600px 预览直出原图,重演 0727#11「图片缓冲不出来」。
//
// 用文件名判还有一个好处:和 lib/manual_doc_box.canAcceptManualBox 依据同一个事实,
// 「能不能画框」和「是不是整图」不会两处漂。标记只作为存量数据的补充。
function isWholeImageTask(task = {}) {
  const fileName = String(task?.sourceImagePath || '').split('\\').join('/').split('/').pop() || '';
  if (fileName) return !SPLIT_NAME_SUFFIX_RE.test(fileName);
  const role = String(task?.autoSplitRole || '').trim().toLowerCase();
  const message = String(task?.preprocessMessage || '').trim().toLowerCase();
  return role === 'original'
    || message.includes('keep_original')
    || message.includes('no_split_detected');
}

// 「这两条任务来自同一张照片吗」的键 —— **和 review_doc_regions.originalGroupKeyOf 不同**,
// 差别只有一处:这里连 `<NN>-<base>_original.<ext>` 也解析出 base。
//
// 为什么不直接复用它:originalGroupKeyOf 是给**文档框分组**用的,整图参考任务不该
// 被当成同组的一份单据(它会影响交付侧的 siblings 和 sharesImageFile 判定)。
// 而这里问的是另一个问题——「哪条任务持有这张照片的整图」,必须认得 _original。
// 口径与 task_resplit_service.parseSliceBase 一致(那边也是两个正则都试)。
function photoFamilyKeyOf(task = {}) {
  const rel = String(task?.sourceOriginalPath || task?.sourceImagePath || '').trim();
  if (!rel) return '';
  const parts = rel.split('/');
  const fileName = parts.pop() || '';
  const dir = parts.join('/');
  const matched = fileName.match(SPLIT_NAME_RE) || fileName.match(/^\d+-(.+?)_original\.\w+$/);
  return matched ? `${dir}/${matched[1]}` : rel;
}

/**
 * 这条任务要看整张原图时,该去哪个 URL 拿。
 *
 * 为什么挪到后端算(0730):前端原来自己回溯,用的是**客户级**键
 * (sourceGroupKey/sourceFolderPath),而同一个客户底下可能有多张照片 ——
 * 于是会回溯到**别的照片**。人在照片 X 上画框、坐标存到照片 Y 的任务上,
 * 交付按错框裁 Y,全程零报错。正确口径是每张**照片**级的键,即本文件的
 * photoFamilyKeyOf ——(2026-08-01 更正:这里原本写的是 review_doc_regions
 * 的 originalGroupKeyOf,而上面 photoFamilyKeyOf 的注释刚说过两者**不是**
 * 一个东西:那个不认 `_original`。照原注释去改,恰好会踩回它自己警告的那个坑。)
 *
 * ⚠️ 纯路径逻辑,**不碰 fs** —— 这是每条任务都跑的热路径。
 * 盘上到底在不在,由 /original-image 端点在真正取图时回答。
 *
 * @returns {string} '' 表示「没有另一张原图可看」(它自己就是整图,或没有客户库引用)
 */
function buildOriginalImageUrl(batch, task, toStorageUrl) {
  // 它自己就是整张照片 —— 不需要"另一张原图"。
  // 前端据此走 isOriginalImage 那条门,而不是拿这个 URL 去换图
  //(换了会让整图任务从 1600px 预览变成 /storage 直出 5-12MB,重演 0727#11)。
  if (isWholeImageTask(task)) return '';

  const key = photoFamilyKeyOf(task);
  if (!key) return '';

  // ① 同一张照片切出来的整图兄弟就在批次里 → 直接用它的图
  const sibling = (batch?.tasks || []).find((other) => (
    other !== task && isWholeImageTask(other) && photoFamilyKeyOf(other) === key
  ));
  if (sibling?.sourceImagePath) return toStorageUrl(batch.id, sibling.sourceImagePath);

  // ② 批次里没有 → 按任务去客户库回溯取图(端点自己做逃逸防护和存在性判断)
  const parts = String(task?.sourceOriginalPath || '').trim().split('/');
  if (parts.length === 3 && parts.every(Boolean)) {
    return `/api/batches/${encodeURIComponent(batch.id)}/tasks/${encodeURIComponent(task.id)}/original-image`;
  }
  return '';
}

module.exports = {
  resolveTaskOriginalImagePath,
  buildOriginalImageUrl,
  isWholeImageTask,
  SPLIT_NAME_RE,
};
