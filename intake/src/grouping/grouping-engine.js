'use strict';

// 分组引擎：把抽取后的图片记录按客户归组。
// 连接键可靠度（见 docs/02 §六）：
//   1. 护照号 —— 主键。支持精确或模糊匹配（OCR 偶有 1~2 字符误差）
//   2. 姓名   —— 仅唯一匹配时归并（会重名）
//   3. 航班号 —— 副键，多客户共享同航班，只把"纯航班图"挂到唯一含该航班的簇
// 选项：
//   fuzzy         开启护照号模糊匹配（编辑距离 ≤ maxDistance 且唯一最优）
//   maxDistance   模糊匹配最大编辑距离（默认 2）
//   rejectInvalid 丢弃打码/不合规护照号（含 * 或非 [A-Z]{1,2}\d{6,8}），改走航班/姓名桥接
// 纯函数：不修改入参。精确模式（默认）保持原行为。

function normPassport(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// 规整姓名：统一斜杠/逗号("BAI/YILAN"、"BAI, YILAN" → "BAI YILAN")；
// 打码姓名(含 *)不用于匹配，返回空。
function cleanName(v) {
  const raw = String(v || '');
  if (!raw || raw.includes('*')) return '';
  return raw.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normFlight(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, '').replace(/O/g, '0');
}
function isValidPassport(p) {
  return /^[A-Z]{1,2}\d{6,8}$/.test(p);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// 处理顺序：护照原件优先（号码最权威）→ 高置信优先，作为锚点先建簇
function rank(r) {
  const typeRank = r.type === 'passport' ? 0 : 1;
  const conf = typeof r.confidence === 'number' ? r.confidence : 0;
  return typeRank * 10 - conf; // 越小越先
}

function corroborated(record, cluster) {
  const f = normFlight(record.flightNo);
  if (f && flightClose(cluster, f)) return true;
  const n = cleanName(record.name);
  if (n && cluster.names.has(n)) return true;
  return false;
}

function findFuzzyCluster(clusters, record, p, maxDistance) {
  let best = null;
  let bestD = Infinity;
  let secondD = Infinity;
  for (const c of clusters) {
    if (!c.anchored) continue; // 只并入有"有效护照原件"锚定的簇，防垃圾 key 吸附多客户
    const d = levenshtein(c.key, p);
    if (d < bestD) {
      secondD = bestD;
      bestD = d;
      best = c;
    } else if (d < secondD) {
      secondD = d;
    }
  }
  if (!best || bestD > maxDistance) return null;
  if (secondD - bestD < 1) return null; // 歧义：最优与次优拉不开
  // 距离 1 多为单字符 OCR 误差，碰撞概率低，直接合；距离 ≥2 需佐证(同航班/同姓名)
  if (bestD >= 2 && !corroborated(record, best)) return null;
  return best;
}

function addToCluster(cluster, record) {
  cluster.recordIds.push(record.id);
  const n = cleanName(record.name);
  if (n) cluster.names.add(n);
  const f = normFlight(record.flightNo);
  if (f) cluster.flights.add(f);
  // 离境键 = 航班号|离境月日(航班图常不印年份，只比 MM-DD)
  const md = monthDay(record.departureDate);
  if (f && md) cluster.departures.add(`${f}|${md}`);
}

// 取月-日(YYYY-MM-DD / MM-DD 都可)，航班图无年份时按月日匹配
function monthDay(d) {
  const m = String(d || '').match(/(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

function effectivePassport(record, rejectInvalid) {
  const p = normPassport(record.passportNo);
  if (!p) return '';
  if (rejectInvalid && (record.passportNo.includes('*') || !isValidPassport(p))) return '';
  return p;
}

function group(records = [], { fuzzy = false, maxDistance = 2, rejectInvalid = false, bridgeFlights = true } = {}) {
  const clusters = [];
  const ordered = [...records].sort((a, b) => rank(a) - rank(b));
  const deferred = [];

  // 阶段 1：按护照号建簇（精确或模糊）
  for (const r of ordered) {
    const p = effectivePassport(r, rejectInvalid);
    if (!p) {
      deferred.push(r);
      continue;
    }
    let cluster = clusters.find((c) => c.key === p);
    if (!cluster && fuzzy) cluster = findFuzzyCluster(clusters, r, p, maxDistance);
    if (!cluster) {
      cluster = { key: p, names: new Set(), flights: new Set(), departures: new Set(), recordIds: [], anchored: false };
      clusters.push(cluster);
    }
    if (r.type === 'passport' && isValidPassport(p)) cluster.anchored = true;
    addToCluster(cluster, r);
  }

  // 阶段 2：姓名唯一匹配
  const stillLeft = [];
  for (const r of deferred) {
    const n = cleanName(r.name);
    const hit = n ? uniqueBy(clusters, (c) => c.names.has(n)) : null;
    if (hit) addToCluster(hit, r);
    else stillLeft.push(r);
  }

  // 阶段 3：纯航班图挂到唯一含该航班号的簇。
  // 航班号也做模糊比较：多客户常同航班 + OCR 会把 9C7206 拍成 3C7206，
  // 只要有第二个簇的航班号与之接近(编辑距离≤1)就判歧义、不挂、留人工，守住 precision。
  const unassigned = [];
  for (const r of stillLeft) {
    const f = normFlight(r.flightNo);
    let matching = [];
    if (bridgeFlights && f) {
      // 有离境日期：用"航班号+离境日期"精确匹配(更唯一)；否则回退到仅航班号
      matching = r.departureDate
        ? clusters.filter((c) => depClose(c, f, r.departureDate))
        : clusters.filter((c) => flightClose(c, f));
    }
    // 挂团客户常共享同航班同日 → 歧义时用航班图上的乘客姓名消歧
    if (matching.length > 1) {
      const fn = cleanName(r.name);
      if (fn) {
        const byName = matching.filter((c) => c.names.has(fn));
        if (byName.length === 1) matching = byName;
      }
    }
    if (matching.length === 1) addToCluster(matching[0], r);
    else unassigned.push(r.id);
  }

  return {
    clusters: clusters.map((c) => ({
      key: c.key,
      name: [...c.names][0] || '',
      recordIds: c.recordIds.slice(),
    })),
    unassigned,
  };
}

function flightClose(cluster, f) {
  for (const cf of cluster.flights) {
    if (cf === f || levenshtein(cf, f) <= 1) return true;
  }
  return false;
}

// 离境匹配：簇里有"同离境月日 且 航班号接近"的记录
function depClose(cluster, f, departureDate) {
  const md = monthDay(departureDate);
  if (!md) return false;
  for (const dep of cluster.departures) {
    const [cf, cd] = dep.split('|');
    if (cd === md && (cf === f || levenshtein(cf, f) <= 1)) return true;
  }
  return false;
}

function uniqueBy(clusters, predicate) {
  let hit = null;
  for (const c of clusters) {
    if (predicate(c)) {
      if (hit) return null;
      hit = c;
    }
  }
  return hit;
}

function createGroupingEngine(defaults = {}) {
  return { group: (records, opts) => group(records, { ...defaults, ...opts }) };
}

module.exports = { createGroupingEngine, group, levenshtein, isValidPassport };
