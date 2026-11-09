const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '../frontend/src/views/CustomerLibraryView.vue');

// 只取 <template> 段:禁词断言查的是"用户看得见的字",<script> 里的注释讲清来龙去脉是好事,
// 不该被误判成违规(否则会逼着后人删掉解释性注释)。
test('customer library shows durable upload and preprocess progress states', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /preprocessProgressState/);
  assert.match(source, /preprocessProgressTitle/);
  assert.match(source, /preprocessProgressStatusClass/);
  assert.match(source, /uploadProgressStatusLabel/);
  assert.match(source, /uploadProgressStatusClass/);
  assert.match(source, /customer\.uploadProgress\.active/);
  assert.match(source, /warningImages/);
  assert.match(source, /preprocessWarning/);
});

test('customer intake merges create and preprocess into one workspace table', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /客户建档/);
  assert.match(source, /收图建档/);
  assert.match(source, /客户目录/);
  assert.match(source, /uploadStatusInfo/);
  assert.match(source, /deleteCustomerById/);
  // 团号表后台上传改版后:「导入为新审核批次」按钮 → 顶部「当前审核批次」条 + 「新建批次」(秒建空批次绑团号表)
  assert.match(source, /当前审核批次/);
  assert.match(source, /新建批次/);
  // 2026-07-26 信息架构重排:左=选当前批次(主)/右=新建(辅助,点开才出表单);
  // 兜底按钮:「追加整个工作区」→「补进当前批次(兜底)」。2026-07-27 用户拍板界面不出现
  // 「同步」二字(那是全自动的内部管道,操作员既不用管也点不动),故按钮也改用业务说法。
  assert.match(source, /showNewBatch/, '新建表单默认收起,点按钮才展开');
  // 2026-07-29 方案B 融合:工作区行与批次行并成一张「当前工作上下文」卡,
  // 两级用缩进+↓表达从属;新建入口全页唯一(+ 新建 ▾ 含 工作区/批次 两项)。
  assert.match(source, /cl-context/, '融合卡容器');
  assert.match(source, /当前工作上下文/, '卡标题');
  assert.match(source, /cl-ctx-row--child/, '批次是工作区的下一级(缩进)');
  assert.match(source, /openNewPanel\('workspace'\)[\s\S]{0,300}openNewPanel\('batch'\)/, '唯一新建菜单含两项');
  assert.ok(!source.includes('cl-bb-main'), '旧两条横条布局已下线');
  assert.ok(source.includes('补进当前批次(兜底)'), '兜底按钮存在(功能保留,只换说法)');
  assert.doesNotMatch(source, /手动同步本工作区/, '旧命名(带「同步」)已下线');
  assert.doesNotMatch(source, /追加整个工作区/, '旧命名已下线(易被当成常规操作)');
  // 「可同步」口径纠正:旧计数把已进审核的也算成可同步(266客户/266可同步)= 误导,
  // 拆成 已进审核 / 待同步(真待办,健康态 0)。
  assert.match(source, /pendingSync/);
  assert.match(source, /已进审核/);
  assert.doesNotMatch(source, /}} 可同步/, '误导性的「N 可同步」概览已拆开');
  // 复核修复①:「取消新建」必须真重置表单(否则残留的团号表会被下次新建静默复用 → 误绑)
  assert.match(source, /function toggleNewBatch/);
  assert.match(source, /newBatchGroupCodeInput\.value\.value = ''/, '取消时清原生 file input');
  assert.doesNotMatch(source, /@click="showNewBatch = !showNewBatch"/, '取消不得只翻标志位');
  // 复核修复②:已进审核判定与行内徽章同源(hasReviewBatch 认 lastBatchId 或 lastSourceGroupId),
  // 否则部分拷贝失败的客户会「行显示已进审核、汇总算待同步」自相矛盾。
  assert.match(source, /inReview: hasReviewBatch\(record\)/);
  assert.doesNotMatch(source, /row\.reviewBatchId\)\.length/, '汇总不得只认 lastBatchId');

  assert.doesNotMatch(source, /activeStep === 'preprocess'/);
  assert.doesNotMatch(source, /仅预处理当前客户/);
  assert.doesNotMatch(source, /待复核图片/);
  assert.doesNotMatch(source, /全部通过/);
  assert.doesNotMatch(source, /acceptAllPending/);
  assert.doesNotMatch(source, /<strong>追加图片<\/strong>/);
  // 单客户「补图」(appendImagesTo / appendFilesInput)是 A1 终态保留功能:
  // 客户后续收到小票补到该客户,与批次级「追加整个工作区」并存,不在禁止之列。
  assert.doesNotMatch(source, /appendTargetCustomerId/);
  assert.doesNotMatch(source, /只追加当前客户/);
  assert.doesNotMatch(source, /appendSelectedCustomer/);
});

test('重启中断的预处理(status=error)显示「识别中断」且不自动入批次(审计MEDIUM)', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  // 前端识别 'error' 状态:显示条+就绪判定都要有,且就绪 ready:false 不自动追批次
  assert.match(source, /status === 'error'/);
  assert.match(source, /识别中断·请重识别/);
  assert.match(source, /服务重启打断了识别/);
});

// 2026-07-27 复核 HIGH:团号表重传按钮静默失效。
// 建批次成功 → showNewBatch=false → 新建表单(含 newBatchGroupCodeInput)卸载;
// 而 gcUpload 失败横幅在表单之外还活着,重传按钮却复用了那个已卸载的 ref → ?.click() 什么都不做。
test('团号表重传:独立 input 挂在新建表单之外,且真的会重新上传', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'views', 'CustomerLibraryView.vue'),
    'utf8',
  );
  // ① 重传 input 必须在 v-if="showNewBatch" 的块之外
  const formStart = src.indexOf('v-if="showNewBatch"');
  const formEnd = src.indexOf('gcUpload.phase'); // 新建表单块结束、进度块开始
  const retryInputIdx = src.indexOf('ref="gcRetryInput"');
  assert.ok(retryInputIdx > 0, '存在独立的重传 input');
  assert.ok(!(retryInputIdx > formStart && retryInputIdx < formEnd),
    '重传 input 不得落在 showNewBatch 表单块内,否则建好批次后随表单一起卸载');

  // ② 重传按钮绑的是 pickGcRetry,不是已卸载 ref 的 pickNewBatchGroupCode
  const failBlock = src.slice(src.indexOf("gcUpload.phase === 'failed'"), src.indexOf("gcUpload.phase === 'failed'") + 320);
  assert.match(failBlock, /@click="pickGcRetry"/);
  assert.ok(!/@click="pickNewBatchGroupCode"/.test(failBlock), '不得再复用新建表单的选择器');

  // ③ 选完文件要**真的重传**(旧的 onNewBatchGroupCodeChange 只记文件名),且不得误建新批次
  const handler = src.slice(src.indexOf('function onGcRetryChange'), src.indexOf('function onGcRetryChange') + 460);
  assert.match(handler, /uploadGroupCodeInBackground\(batchId, file\)/, '必须打真实上传');
  assert.ok(!/createEmptyBatch/.test(handler), '重传不能走建批次(会多建一个批次)');
  assert.match(handler, /e\.target\.value = ''/, '清空 value 才能连续重选同一个文件');
  assert.match(handler, /if \(!batchId\)/, '没有目标批次要明示,不能静默');
});

// ── 0728工作流#1:建档右上角「去审核」跳转键 ────────────────────────────────
test('建档页:右上角有去审核键,带当前批次直达、无批次回落 latest(与导航同惯例)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/views/CustomerLibraryView.vue'), 'utf8');
  assert.match(src, /去审核 →/);
  assert.match(src, /activeBatchId \? `\/review\/\$\{activeBatchId\}` : '\/review\/latest'/, '有批次直达,无批次进审核台自选');
  assert.match(src, /class="outline-primary"[\s\S]{0,400}去审核/, '描边蓝=导航动作,不抢页内实心位');
});
