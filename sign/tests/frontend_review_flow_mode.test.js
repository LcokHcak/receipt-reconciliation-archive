const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reviewViewPath = path.join(__dirname, '../frontend/src/views/ReviewView.vue');
const fieldEditorPath = path.join(__dirname, '../frontend/src/components/FieldEditor.vue');
const imageViewerPath = path.join(__dirname, '../frontend/src/components/ImageViewer.vue');
const moreMenuPath = path.join(__dirname, '../frontend/src/components/MoreMenu.vue');
const groupedTaskListPath = path.join(__dirname, '../frontend/src/components/GroupedTaskList.vue');
const reviewDisplayPath = path.join(__dirname, '../frontend/src/lib/reviewDisplay.js');

test('review page exposes flow-mode actions for one-click review navigation', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  const signatureSource = fs.readFileSync(path.join(__dirname, '../frontend/src/components/SignatureEditor.vue'), 'utf8');

  assert.match(source, /fieldEditorRef/);
  assert.match(source, /review-console-layout/);
  assert.match(source, /review-image-panel/);
  assert.match(source, /review-inspector/);
  assert.match(source, /review-action-dock/);
  assert.match(source, /confirmAndNext/);
  assert.match(source, /markRephotoAndNext/);
  assert.match(source, /<SignatureEditor/);
  assert.match(signatureSource, /护照确认后自动按当前中文签名展示生成/);
  assert.match(source, /'确认'/); // 确认按钮标签(合并结算后为动态:处理中…/确认)
  assert.match(source, />\s*重拍\s*</);
  assert.doesNotMatch(source, />\s*保存并下一张\s*</);
  assert.doesNotMatch(source, />\s*上一张\s*</);
  assert.doesNotMatch(source, />\s*下一张\s*</);
});

test('field editor exposes validation and payload methods to the review flow', () => {
  const source = fs.readFileSync(fieldEditorPath, 'utf8');

  assert.match(source, /showSubmit/);
  assert.match(source, /defineExpose/);
  assert.match(source, /validateForSubmit/);
  assert.match(source, /getPayload/);
  assert.match(source, /focusFirstInvalid/);
});

test('field editor renders fixed choice fields as selectable buttons', () => {
  const source = fs.readFileSync(fieldEditorPath, 'utf8');

  assert.match(source, /field\.inputType === 'choice'/);
  assert.match(source, /choice-field/);
  assert.match(source, /selectChoice\(field\.key,\s*option\.value\)/);
  assert.match(source, /:aria-pressed="draft\[field\.key\] === option\.value"/);
});

test('image viewer keeps zoomed images accessible from the top edge', () => {
  const source = fs.readFileSync(imageViewerPath, 'utf8');

  assert.match(source, /stageRef/);
  assert.match(source, /shellStyle/);
  assert.match(source, /class="image-shell"/);
  assert.match(source, /class="image-canvas"/);
  // 2026-06-12: 普通滚轮走原生滚动(看长图),Ctrl+滚轮才缩放;不再 .prevent 全劫持
  assert.match(source, /@wheel="handleWheelZoom"/);
  assert.match(source, /event\.ctrlKey/);
  assert.match(source, /zoomPresets/);
  assert.match(source, /25%/);
  assert.match(source, /200%/);
  assert.match(source, /400%/);
  assert.match(source, /600%/); // 2026-07-14 报障:放大上限 4x→6x
  assert.match(source, /max="600"/);
  // 2026-07-14 根治"放大就看不见/拖不回来":变焦滚动锚定(视口锚点跟随)+旋转后回中
  assert.match(source, /applyZoomAnchored/);
  assert.match(source, /recenterAfterRotate/);
  assert.match(source, /\.image-stage\s*\{[^}]*align-items:\s*flex-start;/s);
  assert.match(source, /\.image-shell\s*\{[^}]*place-items:\s*center;/s);
  assert.match(source, /\.image-canvas\s*\{[^}]*transform-origin:\s*center center;/s);
});

test('review console layout gives image and inspector priority over the queue', () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/style.css'), 'utf8');

  assert.match(source, /\.review-console-layout\s*\{[^}]*grid-template-columns:\s*280px minmax\(420px,\s*1fr\) 380px;/s);
  // 高度预算 210→96(2026-07-28 用户截图实锤):210px 是旧高顶部(标题+批次卡+提示区)的
  // 遗产,顶部瘦身(6cef8d6)后实测只占 70px → 每屏凭空浪费 140px 底部空白,图片面板矮 22%。
  assert.match(source, /\.review-console-layout\s*\{[^}]*height:\s*calc\(100vh - 96px\);/s);
  assert.match(source, /\.review-image-panel\s*\{[^}]*height:\s*calc\(100vh - 96px\);/s);
  // grid→flex(2026-07-28 用户截图):旧 grid 单行 minmax(0,1fr) 按"只有字段面板"写,
  // 完成卡插进来被垂直居中飘在面板正中。flex 列:完成卡 none、字段面板 1。
  assert.match(source, /\.review-inspector\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(source, /\.review-inspector\s*\{[^}]*max-height:\s*calc\(100vh - 96px\);/s);
  assert.match(source, /\.review-inspector > \.review-field-panel \{ flex: 1; min-height: 0; \}/);
  assert.match(source, /\.review-field-panel\s*\{[^}]*overflow:\s*visible;/s);
});

test('per-ticket two-step flow: stance block, per-ticket lock, ordering, default tab', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  const grouped = fs.readFileSync(groupedTaskListPath, 'utf8');
  const stance = fs.readFileSync(path.join(__dirname, '../frontend/src/components/ReceiptStanceBlock.vue'), 'utf8');
  // 票级两步流(2026-07-10 用户拍板):
  assert.match(source, /<ReceiptStanceBlock/);           // 表态区块内嵌检查器
  assert.match(source, /isTaskStanceLocked\(selectedTask\)/); // 票级锁渲染
  assert.match(source, /先表态本票团号/);                  // confirmAndNext 守卫
  // 回执提示:组内小票全部表态即弹(B5)。2026-07-26 顶部瘦身后,三类提示统一成不带框的
  // 单行 .rv-notice(报错红/全通过绿/日常蓝),回执走 is-ok 绿色那条,不再是独立带框卡片。
  assert.match(source, /receiptCard/);
  assert.match(source, /rv-notice is-ok/);
  assert.match(source, /!isTaskStanceLocked\(task\)/);    // 批量高置信排除未表态(B1)
  assert.match(grouped, /sortTasksForReview\(group\.tasks\)/); // 组内 护照→小票→其它 显示序
  assert.match(grouped, /stanceLockedCount/);             // 待匹配 chip+筛选
  assert.match(stance, /无团号·直接确认/);                 // 三件套之无团号
  assert.match(stance, /S活动票/);                        // 三件套之S标记
  assert.match(stance, /modeManualPick/);                 // 多模式候选人选
});

test('「本批次按代理」切换器已下线:审核台单视图,旧挂点清干净', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  // 用户拍板(2026-07-17):代理视角由独立代理视图(/agents)全面接管,审核台切换器移除。
  assert.doesNotMatch(source, /class="view-switch"/);
  assert.doesNotMatch(source, />本批次按代理</u); // 按钮文本节点(注释里的历史记载不算)
  assert.doesNotMatch(source, /AgentQueuePanel/);
  // 确认站/回发已下线(2026-07-14 用户拍板删除):tourPendingCount 角标随之移除
  assert.doesNotMatch(source, /tourPendingCount/);
  assert.doesNotMatch(source, /queue-tabs/);
});

test('P1 内联补救(2026-07-18):未命中面板当场救,复用补救台同一套口径', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  // 补救 API/候选与补救台同源(禁第二副本):PATCH manualRemedyConfirm + mode-mapping + 批次团号表
  assert.match(source, /updateLedgerFields\(r\.workspaceKey, r\.id/); // 行级 ws+id,不用 affectedWorkspaces[0]
  assert.match(source, /manualRemedyConfirm: true/);
  assert.match(source, /fetchModeMapping/);
  assert.match(source, /fetchBatchGroupCodes/);
  assert.match(source, /TOUR_REMEDY_HINT/); // 失败原因人话=共享字典
  // 日期类不给选模式硬确认:改日期+人工放行;跨月迁移有交代
  assert.match(source, /改日期并放行/);
  assert.match(source, /migrated/);
  // 组级同模式按 同团号+同店 收窄(客户组可跨店,防错桶)
  assert.match(source, /sameGroupRemaining/);
  assert.match(source, /r\.shop \|\| ''/);
  // 全清自动收口 confirmGroupModes;稍后处理=纯关面板托底
  assert.match(source, /maybeAutoConfirmAfterRemedy/);
  assert.match(source, /稍后处理/);
  // S活动背书判 modeRaw(原判 r.mode 永不触发的 bug 已修,不许回退)
  assert.match(source, /r\.modeRaw \|\| ''\)\.includes\('S活动'\)/);
  assert.doesNotMatch(source, /String\(r\.mode \|\| ''\)\.includes\('S活动'\)/);
});

test('review operator controls stay accessible in the compact inspector', () => {
  const reviewSource = fs.readFileSync(reviewViewPath, 'utf8');
  const moreMenuSource = fs.readFileSync(moreMenuPath, 'utf8');

  assert.match(moreMenuSource, /placement/);
  assert.match(moreMenuSource, /placement-top/);
  assert.match(moreMenuSource, /bottom:\s*calc\(100% \+ 4px\);/);
  assert.match(reviewSource, /review-primary-actions/);
  assert.match(reviewSource, /danger-ghost-button/);
  assert.match(reviewSource, /追加图片/);
});

test('grouped review queue supports expanding and collapsing every customer group', () => {
  const source = fs.readFileSync(groupedTaskListPath, 'utf8');

  assert.match(source, /setAllGroups/);
  // 展开/收起合成一个切换按钮(UI精简):标签随 allExpanded 动态切换。
  assert.match(source, /'收起' : '展开'/); // 2026-07-28 省「全部」二字收行宽,title 保语义
});

test('review queue shows group upload time and offers selectable sort order', () => {
  const source = fs.readFileSync(groupedTaskListPath, 'utf8');

  // 时间显示口径又换了一轮(2026-07-27 任务流规格十一,覆盖 07-26 的"只留时刻"):
  // 行内=相对等待时长(formatQueueTime,"8分钟前")+ 超时分级着色(waitTierOf),
  // 绝对时间进 title 悬停 —— 时刻本身帮不了判断优先级,等了多久才帮得了。
  assert.match(source, /formatQueueTime\(group\.createdAt, nowMs\)/);
  assert.match(source, /waitTierOf/);
  assert.match(source, /fullTimestamp/);
  assert.match(source, /group-time/);
  // 五种可选排序 + 按浏览器记住选择;默认 FIFO(任务流规格十二)。
  // 文案短写(2026-07-27 UI评估③):280px 面板里「待审优先(已通过沉底)」一项就把
  // 右侧控件全挤出可视区,语义解释挪进 title。
  assert.match(source, /reviewQueueSortMode/);
  assert.match(source, /最早在前\(FIFO\)/);
  assert.match(source, /最新在前/);
  assert.match(source, /待审优先</);
  assert.match(source, /异常优先/);
  assert.match(source, /代理连续/);
  assert.match(source, /return 'oldest'/, '无记忆时默认 FIFO');
  assert.match(source, /v-model="sortMode"/);
  // 排序逻辑走共享纯函数 sortReviewGroups(行为测试在 reviewDisplay 单测里),不在组件内联比较器
  assert.match(source, /sortReviewGroups\(enriched, sortMode\.value\)/);
});

test('grouped review queue highlights the current image row explicitly', () => {
  const source = fs.readFileSync(groupedTaskListPath, 'utf8');

  // 2026-07-28 参考图对齐:「当前」pill 删除——行高亮(.active 蓝左条+蓝底)已标当前,
  // 组头另有「当前审核」,三处同词是噪音。高亮 class 绑定仍在,断言它。
  assert.ok(!source.includes('current-marker'), '子行「当前」pill 已删');
  assert.match(source, /item\.task\.id === selectedTaskId/);
  // 待处理/审核态判定已抽到共享真相源 reviewDisplay(与代理视图同口径,含"已拒绝"),
  // GroupedTaskList 复用 isTaskPending;拒绝态排除逻辑在 reviewDisplay 里断言。
  assert.match(source, /isPending = isTaskPending/);
  const shared = fs.readFileSync(reviewDisplayPath, 'utf8');
  assert.match(shared, /拒绝.*return false|pr\.includes\('拒绝'\)/);
});

test('review flow auto-approves a complete group and shows a clean completion state', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');

  assert.match(source, /isBatchReviewComplete/);
  assert.match(source, /canAutoApproveGroup/);
  assert.match(source, /autoApproveGroupIfReady/);
  assert.match(source, /workbench\.approveGroup\(groupKey\)/);
  // 完成态升级为设计过的完成卡(2026-07-28):✓态标+三桶数字+需重拍联动+主CTA,
  // 不再是「一句话+飘着的按钮」;旧 review-complete-panel 满屏居中类随之退役。
  assert.match(source, /review-complete-inline/);
  assert.match(source, /本批次已审完/);
});

test('completed review batches still keep image and field editing panels mounted', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');

  const imageBlockStart = source.indexOf('<ImageViewer');
  const imageBlock = source.slice(imageBlockStart, source.indexOf('/>', imageBlockStart));
  assert.ok(imageBlockStart >= 0, 'ImageViewer block exists');
  assert.doesNotMatch(imageBlock, /v-if="!isBatchReviewComplete"/);

  const inspectorStart = source.indexOf('<aside class="review-inspector"'); // 2026-07-14 起带换票护罩 :class 绑定
  const inspector = source.slice(inspectorStart, source.indexOf('</aside>', inspectorStart));
  assert.ok(inspectorStart >= 0, 'review inspector exists');
  assert.match(inspector, /<FieldEditor/);
  assert.doesNotMatch(inspector, /<div v-if="isBatchReviewComplete" class="panel review-field-panel/);
  assert.doesNotMatch(inspector, /<div v-else class="panel review-field-panel/);
});

test('review batch action names ledger import as the operator-facing workflow', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');

  assert.match(source, /importLedgerAndMatch/);
  assert.match(source, /结算本批次/);
  assert.doesNotMatch(source, /跑今日团号匹配/);
  assert.doesNotMatch(source, /tour-match-today/);
});

test('全部通过高置信 对齐 确认即结算:整组审完+合并开→内联结算出模式(审计MEDIUM)', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');
  // confirmHighTierInGroup 末尾必须复用 confirmAndNext 同一条结算链(同函数),不再只 autoApprove
  const fn = source.slice(source.indexOf('async function confirmHighTierInGroup'), source.indexOf('async function confirmHighTierInGroup') + 1600);
  assert.match(fn, /canAutoApproveGroup\(groupKey\)/);
  assert.match(fn, /mergeSettleOnConfirm\.value/);
  assert.match(fn, /settledGroupKeys\.value\.has\(groupKey\)/);
  assert.match(fn, /settleGroupInline\(groupKey\)/);
  // 团号表未就绪的降级提示也要在(与 confirmAndNext 一致)
  assert.match(fn, /parsing.*awaiting_upload|awaiting_upload/);
});
