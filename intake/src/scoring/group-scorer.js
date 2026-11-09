'use strict';

// 分组评分器：用成对(pairwise)指标衡量聚类质量——标准且稳健。
// 输入：
//   predicted: [{ key, recordIds:[] }]  分组引擎输出的簇
//   truthByRecord: Map<recordId, truthGroupId>  真值（每条记录的真实客户组，
//                  来自文件夹名的护照前缀/真实护照号）
// 对所有无序记录对统计：
//   TP=同簇且真值同组  FP=同簇但真值不同组  FN=不同簇但真值同组
//   precision=TP/(TP+FP)  recall=TP/(TP+FN)  f1=调和平均
// 另报覆盖率（已归组记录占比）。纯函数。

function buildPredictedByRecord(predicted) {
  const map = new Map();
  predicted.forEach((cluster, idx) => {
    const clusterId = cluster.key || `cluster-${idx}`;
    for (const id of cluster.recordIds) map.set(id, clusterId);
  });
  return map;
}

function score({ predicted = [], truthByRecord = new Map() } = {}) {
  const predictedByRecord = buildPredictedByRecord(predicted);
  const ids = [...truthByRecord.keys()];

  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const sameTruth = truthByRecord.get(a) === truthByRecord.get(b);
      const pa = predictedByRecord.get(a);
      const pb = predictedByRecord.get(b);
      const samePred = pa !== undefined && pb !== undefined && pa === pb;

      if (samePred && sameTruth) tp++;
      else if (samePred && !sameTruth) fp++;
      else if (!samePred && sameTruth) fn++;
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const assigned = ids.filter((id) => predictedByRecord.has(id)).length;
  const coverage = ids.length === 0 ? 1 : assigned / ids.length;

  return {
    pairs: { tp, fp, fn },
    precision,
    recall,
    f1,
    coverage,
    totalRecords: ids.length,
    assignedRecords: assigned,
  };
}

module.exports = { score };
