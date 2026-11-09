// 手画文档框(2026-07-30 切图改框选·第 2 期):操作员在原图上拖一个框,
// 这条任务从此按那个框出交付图。
//
// 为什么必须有这个:一票一图护栏会拦下「同图补小票」产生的任务(它复制了
// sourceImagePath 却不带框,交付时同一张照片会按两个票号发两笔账)。
// 拦下之后「导出说明.txt」告诉操作员「点查看原图框出各自的范围后重新导出」——
// **在这个功能之前那句话是做不到的**,等于让人去做一件不存在的操作。
//
// 这里只放纯判断,不碰文件系统:框合不合法、能不能落到这条任务上。
// 落盘在 services/workbench_write/task.js 的 setTaskDocBox(走批次写锁)。

const { SPLIT_FILE_RE } = require('./delivery_render');

// 框至少要占原图这么大,否则是误触画出来的一个点
const MIN_BOX_AREA = 0.005; // 0.5%
// 也不能整张图都框上 —— 那等于没框,交付照样出整图
const MAX_BOX_AREA = 0.92;
// 单边最小长度(防出现极细长条:面积够但一边只有几像素)
const MIN_BOX_SIDE = 0.02;

// 输入是前端拖出来的 [x1,y1,x2,y2](原图归一化)。
// 返回规整后的框,或 { error } 说明为什么不收 —— **绝不静默修正**:
// 悄悄把一个荒谬的框改成"合理"的,操作员会以为自己框对了。
// 传 null / [] 表示**清除**这条任务的手画框(回到没有人工框的状态)。
// 画错了要能撤销 —— 只能覆盖不能清,等于把人锁在一个错框里。
function isClearRequest(raw) {
  return raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0);
}

function normalizeManualBox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) {
    return { error: '框的格式不对(应为 [x1,y1,x2,y2] 四个 0~1 之间的数)' };
  }
  const v = raw.map(Number);
  if (v.some((n) => !Number.isFinite(n))) {
    return { error: '框里有非数字' };
  }
  if (v.some((n) => n < -0.001 || n > 1.001)) {
    return { error: '框超出图片范围(坐标必须是 0~1 的比例)' };
  }
  const x1 = Math.max(0, Math.min(v[0], v[2]));
  const y1 = Math.max(0, Math.min(v[1], v[3]));
  const x2 = Math.min(1, Math.max(v[0], v[2]));
  const y2 = Math.min(1, Math.max(v[1], v[3]));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) {
    return { error: '框太窄了,像是误触 —— 请把整张单据框进去' };
  }
  const area = w * h;
  if (area < MIN_BOX_AREA) {
    return { error: '框太小了,像是误触 —— 请把整张单据框进去' };
  }
  if (area > MAX_BOX_AREA) {
    return { error: '框住了几乎整张图 —— 那样交付时还是会出整图,请只框这一张单据' };
  }
  return { box: [x1, y1, x2, y2] };
}

// 这条任务能不能接受手画框。
//
// 关键约束:框是**原图坐标系**的,所以只有当任务的图**就是那张原图**时才对得上。
// 任务指向切片文件时,同一组坐标画到切片上是错的一块 —— 这不是"暂不支持",
// 是坐标系根本不同。(生产上那 2 条 duplicate_crop_file 就卡在这儿,
// 要先把任务重新指向原图才能框,那是后续的事。)
function canAcceptManualBox(task = {}) {
  const rel = String(task.sourceImagePath || '').trim();
  if (!rel) {
    return { ok: false, error: '这条任务没有图片,无法框选' };
  }
  const fileName = rel.split('\\').join('/').split('/').pop() || '';
  if (SPLIT_FILE_RE.test(fileName)) {
    return {
      ok: false,
      // ⚠️ 这里**不能**说"需要先把它改回指向原图" —— 那个操作不存在,
      // 等于又给操作员指一个做不到的动作(0730 上午刚修过同一类毛病)。
      //
      // 0731 实测:上一版写的第②条「删掉这条、在原图那条任务上用补小票」
      // **同样是做不到的**,而且是 7/7 全中 —— 犯的正是这段注释在警告的错。
      // 两个原因叠在一起:
      //   a) qwen 流程的原图 reference 不进批次,所以「原图那条任务」根本不存在
      //      (本地真批次 119 条任务里,7 条切片任务没有一条有整图兄弟);
      //   b) 就算跑去另一条切片任务上补票也没用 —— createManualReceiptTaskFromSource
      //      是**照抄源任务的 sourceImagePath** 的,建出来的新任务还是切片,还是不能框。
      // 0731 下午 P2-a 落地后,②变成真话了 —— 但和原来的说法不一样:
      // 不用"去原图那条任务"(那条不存在),就在**这条**上点补小票,
      // 补出来的任务会指向整张原图,可以直接在上面框。
      // tests/manual_receipt_from_original.test.js 端到端钉了这句话:
      // 拷进批次的新路径必须真的能过 canAcceptManualBox。
      error: '这条任务用的是已经裁好的切片,框选坐标是按整张原图算的,对不上,所以不能在这里手动框选。'
        + '可行的做法:①就在这条上点「补小票」,补出来的那条会指向整张原图,可以在上面框;'
        + '②或者「更多」里用「按店重切」让系统拿原图重新切一次。',
    };
  }
  return { ok: true };
}

module.exports = {
  normalizeManualBox,
  isClearRequest,
  canAcceptManualBox,
  MIN_BOX_AREA,
  MAX_BOX_AREA,
  MIN_BOX_SIDE,
};
