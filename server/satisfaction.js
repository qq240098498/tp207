// 需水满足度：把用水户报的需水计划与实际出库记录对上账
// 口径集中在本文件，路由层不重算；本模块全部是纯函数，同一数据算多少遍结果都一致。
const store = require('./store');

const SECONDS_PER_DAY = 86400;
const WAN_DIVISOR = 10000;
// 对账时允许的四舍五入误差（万m³）
const RECONCILE_TOLERANCE = 0.01;

// 一条出库记录折算的日水量（万m³）：流量（m³/s）× 86400 秒 ÷ 10000
function releaseVolumeWan(flow) {
  return store.round((Number(flow) * SECONDS_PER_DAY) / WAN_DIVISOR, 3);
}

// 时段天数，含起止两端
function planDays(startDate, endDate) {
  return store.daysBetween(startDate, endDate) + 1;
}

// 日期是否落在 [from, to]
function inWindow(date, from, to) {
  return date >= from && date <= to;
}

// 两个日期区间是否有交集（都含两端）
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return !(aEnd < bStart || aStart > bEnd);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// 覆盖某条出库（同水库、同日）的有效计划
function plansCoveringRelease(data, release) {
  return data.plans.filter(
    (p) => p.status !== '已撤销'
      && p.reservoirId === release.reservoirId
      && isValidDate(p.startDate) && isValidDate(p.endDate)
      && inWindow(release.date, p.startDate, p.endDate)
  );
}

function decorateRelease(data, release) {
  const reservoir = data.reservoirs.find((r) => r.id === release.reservoirId);
  const user = data.waterUsers.find((u) => u.id === release.waterUserId);
  return {
    id: release.id,
    reservoirId: release.reservoirId,
    reservoirName: reservoir ? reservoir.name : '',
    date: release.date,
    flow: Number(release.flow),
    type: release.type || '',
    operator: release.operator || '',
    volumeWan: releaseVolumeWan(release.flow),
    waterUserId: release.waterUserId || '',
    waterUserName: user ? user.name : '',
    remark: release.remark || '',
  };
}

// 计算单个计划行：把挂在该用水户名下、同水库、日期落在时段内（含两端）的出库逐条列出
function computePlanRow(data, plan) {
  const user = data.waterUsers.find((u) => u.id === plan.waterUserId);
  const reservoir = data.reservoirs.find((r) => r.id === plan.reservoirId);
  const releases = data.releases
    .filter((r) => r.waterUserId === plan.waterUserId
      && r.reservoirId === plan.reservoirId
      && inWindow(r.date, plan.startDate, plan.endDate))
    .map((r) => decorateRelease(data, r))
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));

  const actualWan = store.round(releases.reduce((s, r) => s + r.volumeWan, 0), 3);
  const demandWan = store.round(Number(plan.demandWan) || 0, 3);
  const gapWan = store.round(demandWan - actualWan, 3);
  const days = planDays(plan.startDate, plan.endDate);
  // 窗口内哪几天没有挂到本户名下的出库，逐天点出来
  const suppliedDates = new Set(releases.map((r) => r.date));
  const missingDates = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(plan.startDate, i);
    if (!suppliedDates.has(d)) missingDates.push(d);
  }
  // 满足率 = 实际供水 ÷ 需水，按百分数保留 1 位；需水为 0 时不给率
  const rate = demandWan > 0 ? store.round((actualWan / demandWan) * 100, 1) : null;

  return {
    planId: plan.id,
    waterUserId: plan.waterUserId,
    waterUserCode: user ? user.code : '',
    waterUserName: user ? user.name : '',
    reservoirId: plan.reservoirId,
    reservoirName: reservoir ? reservoir.name : '',
    startDate: plan.startDate,
    endDate: plan.endDate,
    days,
    purpose: plan.purpose || '',
    reporter: plan.reporter || '',
    reportedAt: plan.reportedAt || '',
    status: plan.status || '已报送',
    remark: plan.remark || '',
    demandWan,
    actualWan,
    gapWan,
    satisfactionRate: rate,
    satisfied: rate !== null && rate >= 100,
    suppliedDays: suppliedDates.size,
    missingDays: missingDates.length,
    missingDates,
    releaseCount: releases.length,
    releases,
  };
}

// 日期加 n 天（输入输出都是 YYYY-MM-DD，按 UTC 算避免时区偏移）
function addDays(dateStr, n) {
  const parts = String(dateStr).split('-').map(Number);
  const t = Date.UTC(parts[0], parts[1] - 1, parts[2]) + n * 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// 排序口径写死，保证稳定：满足率低的在前；没有率的（需水 0）排最后；
// 同率比缺口（缺口大的优先），再比时段、计划编号
const RATE_EMPTY = Number.POSITIVE_INFINITY;
function rankRows(rows) {
  return rows
    .map((r) => r)
    .sort((a, b) => {
      const ra = a.satisfactionRate === null ? RATE_EMPTY : a.satisfactionRate;
      const rb = b.satisfactionRate === null ? RATE_EMPTY : b.satisfactionRate;
      if (ra !== rb) return ra - rb;
      if (b.gapWan !== a.gapWan) return b.gapWan - a.gapWan;
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      if (a.endDate !== b.endDate) return a.endDate < b.endDate ? -1 : 1;
      return a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0;
    })
    .map((r, index) => Object.assign({}, r, { rank: index + 1 }));
}

// 用水户汇总：跨计划、跨水库合并，给出该户总体满足率与最差的时段
function aggregateUsers(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.waterUserId)) {
      map.set(r.waterUserId, {
        waterUserId: r.waterUserId,
        waterUserCode: r.waterUserCode,
        waterUserName: r.waterUserName,
        planCount: 0,
        demandWan: 0,
        actualWan: 0,
        gapWan: 0,
        satisfiedPlanCount: 0,
      });
    }
    const agg = map.get(r.waterUserId);
    agg.planCount += 1;
    agg.demandWan = store.round(agg.demandWan + r.demandWan, 3);
    agg.actualWan = store.round(agg.actualWan + r.actualWan, 3);
    agg.gapWan = store.round(agg.gapWan + r.gapWan, 3);
    if (r.satisfied) agg.satisfiedPlanCount += 1;
  });
  const list = Array.from(map.values()).map((agg) => Object.assign({}, agg, {
    satisfactionRate: agg.demandWan > 0 ? store.round((agg.actualWan / agg.demandWan) * 100, 1) : null,
  }));
  return list
    .sort((a, b) => {
      const ra = a.satisfactionRate === null ? RATE_EMPTY : a.satisfactionRate;
      const rb = b.satisfactionRate === null ? RATE_EMPTY : b.satisfactionRate;
      if (ra !== rb) return ra - rb;
      if (b.gapWan !== a.gapWan) return b.gapWan - a.gapWan;
      return a.waterUserCode < b.waterUserCode ? -1 : 1;
    })
    .map((u, index) => Object.assign({}, u, { rank: index + 1 }));
}

// 对不上账的出库：
// 1) unclaimed 没挂任何用水户的出库（其中落在计划窗口内的最要紧，附可认领的候选计划）
// 2) outsidePlans 挂了用水户、但日期不在该户任何有效计划窗口内（计划外出水）
// 三类（计划内已覆盖 / 计划外挂名 / 未认领）按出库记录本身划分，天然互斥且穷尽。
function computeUnmatched(data, query) {
  const q = query || {};
  const inScope = (r) => {
    if (q.reservoirId && r.reservoirId !== q.reservoirId) return false;
    if (q.waterUserId && r.waterUserId !== q.waterUserId) return false;
    if (isValidDate(q.from) && r.date < q.from) return false;
    if (isValidDate(q.to) && r.date > q.to) return false;
    return true;
  };
  const unclaimed = [];
  const outsidePlans = [];
  const coveredIds = new Set();
  data.releases.forEach((r0) => {
    const covered = !!r0.waterUserId && data.plans.some(
      (p) => p.status !== '已撤销'
        && p.waterUserId === r0.waterUserId
        && p.reservoirId === r0.reservoirId
        && inWindow(r0.date, p.startDate, p.endDate)
    );
    if (covered) {
      coveredIds.add(r0.id);
      return;
    }
    if (!inScope(r0)) return;
    const r = decorateRelease(data, r0);
    if (!r.waterUserId) {
      const covering = plansCoveringRelease(data, r0).map((p) => ({
        planId: p.id,
        waterUserId: p.waterUserId,
        waterUserName: (data.waterUsers.find((u) => u.id === p.waterUserId) || {}).name || '',
        startDate: p.startDate,
        endDate: p.endDate,
        purpose: p.purpose || '',
      }));
      unclaimed.push(Object.assign({}, r, { inWindow: covering.length > 0, candidatePlans: covering }));
    } else {
      outsidePlans.push(r);
    }
  });
  const byDate = (a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1);
  unclaimed.sort(byDate);
  outsidePlans.sort(byDate);
  return { unclaimed, outsidePlans, coveredIds };
}

// 对账始终按全量出库统计，不受页面筛选影响：计划内 + 计划外挂名 + 未认领 = 全部出库
function reconcile(data, rows, unmatched) {
  let totalWanRaw = 0;
  let unclaimedWanRaw = 0;
  let outsideWanRaw = 0;
  let rowWanRaw = 0;
  let outsideCount = 0;
  let unclaimedCount = 0;
  data.releases.forEach((r0) => {
    const v = releaseVolumeWan(r0.flow);
    totalWanRaw += v;
    if (!r0.waterUserId) { unclaimedWanRaw += v; unclaimedCount += 1; return; }
    if (unmatched.coveredIds.has(r0.id)) return;
    outsideWanRaw += v;
    outsideCount += 1;
  });
  const totalReleaseWan = store.round(totalWanRaw, 3);
  const inPlanWan = store.round(totalWanRaw - unclaimedWanRaw - outsideWanRaw, 3);
  const outsideWan = store.round(outsideWanRaw, 3);
  const unclaimedWan = store.round(unclaimedWanRaw, 3);
  const residual = store.round(totalReleaseWan - inPlanWan - outsideWan - unclaimedWan, 3);
  // 行内合计与按记录划分的计划内水量若对不上，只可能是同户时段重叠造成重复计
  rows.forEach((row) => row.releases.forEach((r) => { rowWanRaw += r.volumeWan; }));
  const rowResidual = store.round(store.round(rowWanRaw, 3) - inPlanWan, 3);
  const inPlanCount = unmatched.coveredIds.size;
  return {
    totalReleaseWan,
    inPlanWan,
    outsideWan,
    unclaimedWan,
    residual,
    rowResidual,
    tolerance: RECONCILE_TOLERANCE,
    balanced: Math.abs(residual) <= RECONCILE_TOLERANCE && Math.abs(rowResidual) <= RECONCILE_TOLERANCE,
    totalReleaseCount: data.releases.length,
    inPlanCount,
    outsideCount,
    unclaimedCount,
  };
}

// 主入口：query 可按 reservoirId / waterUserId / from / to 过滤（from/to 与计划时段有交集即纳入）。
// 注意：排名（rank）始终按全部有效计划全局计算，筛选只决定页面上显示哪些行，名次不随筛选变。
function computeSatisfaction(data, query) {
  const q = query || {};
  const activePlans = data.plans.filter((p) => p.status !== '已撤销');

  // 全局行与全局排名
  const globalSorted = activePlans.slice().sort((a, b) => (
    a.startDate === b.startDate
      ? (a.endDate === b.endDate ? (a.id < b.id ? -1 : 1) : a.endDate < b.endDate ? -1 : 1)
      : a.startDate < b.startDate ? -1 : 1
  ));
  const globalRows = globalSorted.map((p) => computePlanRow(data, p));
  const globalRanked = rankRows(globalRows);
  const rankById = new Map(globalRanked.map((r) => [r.planId, r.rank]));
  const userRanking = aggregateUsers(globalRows);

  // 显示范围
  let plans = activePlans.slice();
  if (q.reservoirId) plans = plans.filter((p) => p.reservoirId === q.reservoirId);
  if (q.waterUserId) plans = plans.filter((p) => p.waterUserId === q.waterUserId);
  if (isValidDate(q.from) && isValidDate(q.to)) {
    plans = plans.filter((p) => windowsOverlap(p.startDate, p.endDate, q.from, q.to));
  }
  const scopedIds = new Set(plans.map((p) => p.id));
  const rows = globalRows
    .filter((r) => scopedIds.has(r.planId))
    .map((r) => Object.assign({}, r, { rank: rankById.get(r.planId) }))
    .sort((a, b) => (
      a.startDate === b.startDate
        ? (a.endDate === b.endDate ? (a.planId < b.planId ? -1 : 1) : a.endDate < b.endDate ? -1 : 1)
        : a.startDate < b.startDate ? -1 : 1
    ));

  // 对不上账与对账：未挂名/计划外名单可按水库与日期范围缩小，覆盖判定仍按全局计划
  const unmatched = computeUnmatched(data, q);
  const reconciliation = reconcile(data, globalRows, unmatched);
  const totals = {
    planCount: rows.length,
    demandWan: store.round(rows.reduce((s, r) => s + r.demandWan, 0), 3),
    actualWan: store.round(rows.reduce((s, r) => s + r.actualWan, 0), 3),
    gapWan: store.round(rows.reduce((s, r) => s + r.gapWan, 0), 3),
    unmetPlanCount: rows.filter((r) => !r.satisfied).length,
  };
  totals.satisfactionRate = totals.demandWan > 0
    ? store.round((totals.actualWan / totals.demandWan) * 100, 1) : null;

  return {
    caliber: {
      volumeUnit: '万m³',
      secondsPerDay: SECONDS_PER_DAY,
      wanDivisor: WAN_DIVISOR,
      windowRule: '出库日期落在计划起止日内（含两端）、同水库、挂在同一用水户名下才计入该计划实际供水',
      rateRule: '满足率 = 实际供水量 ÷ 需水量 × 100%',
      rankRule: '按满足率从低到高排，同率按缺口从大到小排；名次按全部计划全局排，筛选不改变名次',
    },
    query: { reservoirId: q.reservoirId || '', waterUserId: q.waterUserId || '', from: q.from || '', to: q.to || '' },
    totals,
    rows,
    ranking: globalRanked.filter((r) => scopedIds.has(r.planId)),
    userRanking,
    unmatched,
    reconciliation,
  };
}

// 对比调整前后两次满足度结果，写清这次调整影响了哪些时段与哪些用水户
function diffSatisfaction(before, after) {
  const beforeMap = new Map(before.rows.map((r) => [r.planId, r]));
  const afterMap = new Map(after.rows.map((r) => [r.planId, r]));
  const planChanges = [];

  afterMap.forEach((now, planId) => {
    const old = beforeMap.get(planId);
    if (!old) {
      planChanges.push({
        planId, waterUserId: now.waterUserId, waterUserName: now.waterUserName,
        change: '新增',
        windowBefore: null, windowAfter: { startDate: now.startDate, endDate: now.endDate },
        demandBefore: null, demandAfter: now.demandWan,
        rateBefore: null, rateAfter: now.satisfactionRate,
        rankBefore: null, rankAfter: now.rank,
      });
      return;
    }
    const moved = old.startDate !== now.startDate || old.endDate !== now.endDate;
    const demandChanged = old.demandWan !== now.demandWan;
    const rateChanged = old.satisfactionRate !== now.satisfactionRate;
    const rankChanged = old.rank !== now.rank;
    if (moved || demandChanged || rateChanged || rankChanged) {
      let change = '名次变动';
      if (moved) change = '时段调整';
      else if (demandChanged) change = '需水量调整';
      else if (rateChanged) change = '满足率变动';
      planChanges.push({
        planId, waterUserId: now.waterUserId, waterUserName: now.waterUserName,
        change,
        windowBefore: { startDate: old.startDate, endDate: old.endDate },
        windowAfter: { startDate: now.startDate, endDate: now.endDate },
        demandBefore: old.demandWan, demandAfter: now.demandWan,
        rateBefore: old.satisfactionRate, rateAfter: now.satisfactionRate,
        rankBefore: old.rank, rankAfter: now.rank,
      });
    }
  });
  beforeMap.forEach((old, planId) => {
    if (!afterMap.has(planId)) {
      planChanges.push({
        planId, waterUserId: old.waterUserId, waterUserName: old.waterUserName,
        change: '删除',
        windowBefore: { startDate: old.startDate, endDate: old.endDate }, windowAfter: null,
        demandBefore: old.demandWan, demandAfter: null,
        rateBefore: old.satisfactionRate, rateAfter: null,
        rankBefore: old.rank, rankAfter: null,
      });
    }
  });

  // 用水户层面：本次出现过指标或名次变动的户
  const userBefore = new Map(before.userRanking.map((u) => [u.waterUserId, u]));
  const userAfter = new Map(after.userRanking.map((u) => [u.waterUserId, u]));
  const userIds = new Set();
  planChanges.forEach((c) => userIds.add(c.waterUserId));
  Array.from(userIds).forEach((id) => {
    if (!userAfter.has(id) && userBefore.has(id)) return;
    const b = userBefore.get(id);
    const a = userAfter.get(id);
    if (b && a && b.satisfactionRate === a.satisfactionRate && b.rank === a.rank) {
      // 户级总指标没变，仍然保留（计划变动了就该点名），但标注 onlyPlanChanged
    }
  });
  const userChanges = Array.from(userIds).map((id) => {
    const b = userBefore.get(id) || null;
    const a = userAfter.get(id) || null;
    const ref = a || b;
    return {
      waterUserId: id,
      waterUserName: ref.waterUserName,
      rateBefore: b ? b.satisfactionRate : null,
      rateAfter: a ? a.satisfactionRate : null,
      rankBefore: b ? b.rank : null,
      rankAfter: a ? a.rank : null,
      gapBefore: b ? b.gapWan : null,
      gapAfter: a ? a.gapWan : null,
    };
  }).sort((x, y) => {
    const rx = x.rateAfter === null || x.rateAfter === undefined ? RATE_EMPTY : x.rateAfter;
    const ry = y.rateAfter === null || y.rateAfter === undefined ? RATE_EMPTY : y.rateAfter;
    return rx - ry;
  });

  return {
    planChangeCount: planChanges.length,
    userChangeCount: userChanges.length,
    planChanges: planChanges.sort((a, b) => (a.planId < b.planId ? -1 : 1)),
    userChanges,
  };
}

module.exports = {
  computeSatisfaction,
  computePlanRow,
  diffSatisfaction,
  releaseVolumeWan,
  planDays,
  plansCoveringRelease,
  decorateRelease,
  SECONDS_PER_DAY,
};
