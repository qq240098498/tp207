// 需水计划与供水满足度：用水户、需水计划、实际供水（分摊到出库记录）的登记与计算都集中在这里。
// 计算口径：
// 1. 出库流量（m³/s）按每天 86400 秒、除以 10000 折算成万m³（与流量表的对应水量同一口径）。
// 2. 某条计划的实际供水量 = 时段内挂在该计划下、且能对应到出库记录的那些记录的水量合计
//    （同一条出库记录只计一次）；对不到出库记录的分摊按登记流量折算，单独列为「对不上」。
// 3. 满足率 = 实际供水量 ÷ 计划需水量；差额 = 需水量 − 实际供水量。
// 4. 满足度是纯函数：同一份数据算两遍，结果必须完全一致。
const { AppError } = require('./errors');
const store = require('./store');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function round3(n) {
  return store.round(n, 3);
}

// 一天的流量（m³/s）折算成万m³
function flowToWan(flow) {
  return round3((Number(flow) * 86400) / 10000);
}

/* ================= 用水户 ================= */

function decorateUser(data, user) {
  const demands = data.demands.filter((d) => d.userId === user.id);
  return Object.assign({}, user, {
    demandCount: demands.length,
    latestWindowEnd: demands.map((d) => d.windowEnd).sort().slice(-1)[0] || '',
  });
}

function listUsers(data) {
  return data.waterUsers.map((u) => decorateUser(data, u)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function findUser(data, id) {
  const found = data.waterUsers.find((u) => u.id === id);
  if (!found) throw new AppError(404, 'WATER_USER_NOT_FOUND', '这个用水户不存在');
  return found;
}

function nextSeq(list, prefix) {
  let max = 0;
  for (const item of list || []) {
    const m = String(item.no || item.code || '').match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(4, '0');
}

function createUser(data, payload) {
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new AppError(400, 'VALIDATION_FAILED', '用水户名称不能为空', { name: '请填用水户名称' });
  const user = {
    id: store.nextId('usr', data.waterUsers),
    code: 'YH' + String(data.waterUsers.length + 1).padStart(3, '0'),
    name,
    contact: String(p.contact || '').trim(),
    canal: String(p.canal || '').trim(),
    remark: String(p.remark || ''),
    createdAt: store.todayIso(),
  };
  data.waterUsers.push(user);
  return decorateUser(data, user);
}

function updateUser(data, id, payload) {
  const user = findUser(data, id);
  const p = payload || {};
  const merged = Object.assign({}, user, p);
  if (!String(merged.name || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '用水户名称不能为空', { name: '请填用水户名称' });
  }
  Object.assign(user, {
    name: String(merged.name).trim(),
    contact: String(merged.contact || '').trim(),
    canal: String(merged.canal || '').trim(),
    remark: String(merged.remark || ''),
  });
  return decorateUser(data, user);
}

function removeUser(data, id) {
  findUser(data, id);
  const used = data.demands.filter((d) => d.userId === id).length;
  if (used > 0) throw new AppError(409, 'WATER_USER_IN_USE', '这个用水户名下还有 ' + used + ' 份需水计划，不能删除', { count: used });
  data.waterUsers = data.waterUsers.filter((u) => u.id !== id);
  return { removed: id };
}

/* ================= 需水计划 ================= */

function listDemands(data, query) {
  const q = query || {};
  let rows = data.demands.slice();
  if (q.userId) rows = rows.filter((d) => d.userId === q.userId);
  if (q.reservoirId) rows = rows.filter((d) => d.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((d) => d.windowEnd >= q.from);
  if (q.to) rows = rows.filter((d) => d.windowStart <= q.to);
  return rows.map((d) => decorateDemand(data, d)).sort((a, b) => (a.windowStart === b.windowStart ? (a.no < b.no ? -1 : 1) : a.windowStart < b.windowStart ? -1 : 1));
}

function findDemand(data, id) {
  const found = data.demands.find((d) => d.id === id);
  if (!found) throw new AppError(404, 'DEMAND_NOT_FOUND', '这份需水计划不存在');
  return found;
}

function validateDemandPayload(data, payload) {
  const p = payload || {};
  const errors = {};
  const userId = String(p.userId || '').trim();
  if (!userId) errors.userId = '请选用水户';
  else if (!data.waterUsers.some((u) => u.id === userId)) errors.userId = '这个用水户不存在';
  const reservoirId = String(p.reservoirId || '').trim();
  if (!reservoirId) errors.reservoirId = '请选供水水库';
  else if (!data.reservoirs.some((r) => r.id === reservoirId)) errors.reservoirId = '这个水库不存在';
  const windowStart = String(p.windowStart || '').trim();
  const windowEnd = String(p.windowEnd || '').trim();
  if (!DATE_RE.test(windowStart)) errors.windowStart = '时段起要按 年-月-日 填';
  if (!DATE_RE.test(windowEnd)) errors.windowEnd = '时段止要按 年-月-日 填';
  if (DATE_RE.test(windowStart) && DATE_RE.test(windowEnd) && windowEnd < windowStart) errors.windowEnd = '时段止不能早于时段起';
  const demandWan = Number(p.demandWan);
  if (!Number.isFinite(demandWan) || demandWan <= 0) errors.demandWan = '需水量要填正数（万m³）';
  if (!String(p.purpose || '').trim()) errors.purpose = '请填用途（如灌溉、供水）';
  if (!String(p.reporter || '').trim()) errors.reporter = '请填报送人';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '需水计划没通过校验，请按提示补齐', errors);
  }
  return { userId, reservoirId, windowStart, windowEnd, demandWan, purpose: String(p.purpose).trim(), reporter: String(p.reporter).trim() };
}

function decorateDemand(data, demand) {
  const user = data.waterUsers.find((u) => u.id === demand.userId);
  const reservoir = data.reservoirs.find((r) => r.id === demand.reservoirId);
  return Object.assign({}, demand, {
    demandWan: Number(demand.demandWan),
    userName: user ? user.name : '(用水户已删除)',
    userCode: user ? user.code : '',
    reservoirName: reservoir ? reservoir.name : '(水库已删除)',
    allocationCount: data.allocations.filter((a) => a.demandId === demand.id).length,
  });
}

function createDemand(data, payload) {
  const v = validateDemandPayload(data, payload);
  const demand = {
    id: store.nextId('dem', data.demands),
    no: nextSeq(data.demands, 'XU-'),
    userId: v.userId,
    reservoirId: v.reservoirId,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    demandWan: v.demandWan,
    purpose: v.purpose,
    reporter: v.reporter,
    submittedAt: String((payload && payload.submittedAt) || store.todayIso()),
    remark: String((payload && payload.remark) || ''),
    createdAt: store.todayIso(),
  };
  data.demands.push(demand);
  return decorateDemand(data, demand);
}

function updateDemand(data, id, payload) {
  const demand = findDemand(data, id);
  const merged = Object.assign({}, demand, payload || {});
  const v = validateDemandPayload(data, merged);
  Object.assign(demand, {
    userId: v.userId,
    reservoirId: v.reservoirId,
    windowStart: v.windowStart,
    windowEnd: v.windowEnd,
    demandWan: v.demandWan,
    purpose: v.purpose,
    reporter: v.reporter,
    submittedAt: String((payload && payload.submittedAt) || demand.submittedAt),
    remark: payload && payload.remark !== undefined ? String(payload.remark) : demand.remark,
  });
  return decorateDemand(data, demand);
}

function removeDemand(data, id) {
  findDemand(data, id);
  const allocationCount = data.allocations.filter((a) => a.demandId === id).length;
  data.demands = data.demands.filter((d) => d.id !== id);
  data.allocations = data.allocations.filter((a) => a.demandId !== id);
  return { removed: id, allocationCount };
}

/* ================= 实际供水登记（分摊到出库记录） ================= */

function listAllocations(data, query) {
  const q = query || {};
  let rows = data.allocations.slice();
  if (q.demandId) rows = rows.filter((a) => a.demandId === q.demandId);
  if (q.userId) {
    const ids = data.demands.filter((d) => d.userId === q.userId).map((d) => d.id);
    rows = rows.filter((a) => ids.includes(a.demandId));
  }
  return rows.map((a) => decorateAllocation(data, a)).sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
}

function decorateAllocation(data, allocation) {
  const demand = data.demands.find((d) => d.id === allocation.demandId);
  const release = data.releases.find((r) => r.id === allocation.releaseId) || null;
  const problems = [];
  if (allocation.releaseId && !release) problems.push('出库记录已删除或不存在');
  if (release && demand && release.reservoirId !== demand.reservoirId) problems.push('出库记录不属于本计划的水库');
  if (release && release.date !== allocation.date) problems.push('分摊日期与出库记录日期不一致');
  if (demand && (allocation.date < demand.windowStart || allocation.date > demand.windowEnd)) problems.push('分摊日期落在计划时段之外');
  return Object.assign({}, allocation, {
    flow: Number(allocation.flow),
    volumeWan: flowToWan(allocation.flow),
    demandNo: demand ? demand.no : '',
    userId: demand ? demand.userId : '',
    reservoirId: demand ? demand.reservoirId : '',
    reservoirName: demand ? ((data.reservoirs.find((r) => r.id === demand.reservoirId) || {}).name || '') : '',
    releaseFlow: release ? Number(release.flow) : null,
    releaseType: release ? release.type : '',
    releaseOperator: release ? release.operator : '',
    releaseVolumeWan: release ? flowToWan(release.flow) : null,
    matched: !!release && !problems.length,
    problems,
  });
}

function saveAllocation(data, payload) {
  const p = payload || {};
  const demand = findDemand(data, String(p.demandId || ''));
  const date = String(p.date || '').trim();
  const errors = {};
  if (!DATE_RE.test(date)) errors.date = '日期要按 年-月-日 填';
  if (DATE_RE.test(date) && (date < demand.windowStart || date > demand.windowEnd)) {
    errors.date = '日期要在计划时段 ' + demand.windowStart + ' 至 ' + demand.windowEnd + ' 之内';
  }
  let release = null;
  const releaseId = String(p.releaseId || '').trim();
  if (releaseId) {
    release = data.releases.find((r) => r.id === releaseId);
    if (!release) errors.releaseId = '这条出库记录不存在';
    else {
      if (release.reservoirId !== demand.reservoirId) errors.releaseId = '这条出库记录不属于本计划的水库';
      if (release.date !== date) errors.releaseId = '这条出库记录的日期是 ' + release.date + '，与所填日期不一致';
    }
  }
  const flow = release ? Number(release.flow) : Number(p.flow);
  if (!release && (!Number.isFinite(Number(p.flow)) || Number(p.flow) < 0)) errors.flow = '流量要填非负数字';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '实际供水登记没通过校验，请按提示补齐', errors);
  }
  // 同一计划、同一天、同一条出库记录只保留一条（再次登记按覆盖处理）
  const existing = data.allocations.find((a) => a.demandId === demand.id && a.date === date && (a.releaseId || '') === releaseId);
  if (existing) {
    existing.flow = flow;
    existing.recorder = String(p.recorder || '').trim();
    existing.remark = String(p.remark || '');
    return { updated: true, allocation: decorateAllocation(data, existing) };
  }
  const allocation = {
    id: store.nextId('alc', data.allocations),
    demandId: demand.id,
    date,
    releaseId,
    flow,
    recorder: String(p.recorder || '').trim(),
    remark: String(p.remark || ''),
    createdAt: store.todayIso(),
  };
  data.allocations.push(allocation);
  return { updated: false, allocation: decorateAllocation(data, allocation) };
}

function removeAllocation(data, id) {
  const found = data.allocations.find((a) => a.id === id);
  if (!found) throw new AppError(404, 'ALLOCATION_NOT_FOUND', '这条实际供水登记不存在');
  data.allocations = data.allocations.filter((a) => a.id !== id);
  return { removed: id };
}

/* ================= 满足度计算（纯函数） ================= */

function demandAllocations(data, demand) {
  return data.allocations
    .filter((a) => a.demandId === demand.id)
    .map((a) => decorateAllocation(data, a));
}

// 一份计划的满足度。dayItems 能追到具体出库记录：哪几天、各多少流量、对应多少水量。
function satisfactionRow(data, demand) {
  const user = data.waterUsers.find((u) => u.id === demand.userId);
  const reservoir = data.reservoirs.find((r) => r.id === demand.reservoirId);
  const allocs = demandAllocations(data, demand);

  // 实际供水量：能对上出库记录的，按出库记录的流量折算，同一条出库记录只计一次；
  // 对不上的，按登记流量折算，同时计入 unmatchedAllocations。
  const countedReleaseIds = new Set();
  let actualWan = 0;
  let linkedCount = 0;
  const unmatchedAllocations = [];
  for (const a of allocs) {
    if (a.releaseId && a.releaseFlow !== null && !a.problems.length) {
      if (!countedReleaseIds.has(a.releaseId)) {
        countedReleaseIds.add(a.releaseId);
        actualWan += Number(a.releaseVolumeWan);
        linkedCount += 1;
      }
    } else {
      actualWan += Number(a.volumeWan);
      unmatchedAllocations.push({
        allocationId: a.id,
        date: a.date,
        flow: a.flow,
        volumeWan: a.volumeWan,
        releaseId: a.releaseId || '',
        recorder: a.recorder,
        reasons: a.problems.length ? a.problems : ['对不到出库记录'],
      });
    }
  }

  // 按天展开：同一时段（同一天）登记了哪些出库记录、各多少流量
  const dayMap = {};
  for (const a of allocs) {
    if (!dayMap[a.date]) dayMap[a.date] = { date: a.date, items: [], dayWan: 0 };
    const item = {
      allocationId: a.id,
      releaseId: a.releaseId || '',
      declaredFlow: a.flow,
      releaseFlow: a.releaseFlow,
      flow: a.releaseFlow !== null && !a.problems.length ? a.releaseFlow : a.flow,
      volumeWan: a.releaseFlow !== null && !a.problems.length ? a.releaseVolumeWan : a.volumeWan,
      type: a.releaseType || '未挂出库记录',
      operator: a.releaseOperator || a.recorder,
      matched: a.matched,
      problems: a.problems,
    };
    dayMap[a.date].items.push(item);
    dayMap[a.date].dayWan = round3(dayMap[a.date].dayWan + Number(item.volumeWan));
  }
  const days = Object.keys(dayMap).sort().map((date) => dayMap[date]);

  // 本库在该计划时段内的出库记录：被任何计划的分摊引用过就算「已对上」，没被引用的单独列出
  const referencedReleaseIds = new Set();
  for (const d of data.demands) {
    if (d.reservoirId !== demand.reservoirId) continue;
    for (const a of data.allocations.filter((x) => x.demandId === d.id && x.releaseId)) referencedReleaseIds.add(a.releaseId);
  }
  const unlinkedReleases = data.releases
    .filter((r) => r.reservoirId === demand.reservoirId && r.date >= demand.windowStart && r.date <= demand.windowEnd && !referencedReleaseIds.has(r.id))
    .map((r) => ({
      releaseId: r.id,
      date: r.date,
      flow: Number(r.flow),
      volumeWan: flowToWan(r.flow),
      type: r.type,
      operator: r.operator,
      reason: '时段内有出库记录，但没有任何用水户的实际供水登记对应到它',
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  actualWan = round3(actualWan);
  const demandWan = Number(demand.demandWan);
  const gapWan = round3(demandWan - actualWan);
  const rate = demandWan > 0 ? store.round(actualWan / demandWan, 4) : 0;

  return {
    demandId: demand.id,
    no: demand.no,
    userId: demand.userId,
    userName: user ? user.name : '(用水户已删除)',
    userCode: user ? user.code : '',
    reservoirId: demand.reservoirId,
    reservoirName: reservoir ? reservoir.name : '(水库已删除)',
    windowStart: demand.windowStart,
    windowEnd: demand.windowEnd,
    period: demand.windowStart + ' 至 ' + demand.windowEnd,
    purpose: demand.purpose,
    reporter: demand.reporter,
    submittedAt: demand.submittedAt,
    demandWan,
    actualWan,
    gapWan,
    rate,
    ratePercent: store.round(rate * 100, 2),
    shortage: gapWan > 0,
    overSupply: gapWan < 0,
    linkedReleaseCount: linkedCount,
    allocationCount: allocs.length,
    unmatchedAllocationCount: unmatchedAllocations.length,
    unlinkedReleaseCount: unlinkedReleases.length,
    days,
    unmatchedAllocations: unmatchedAllocations.sort((a, b) => (a.date < b.date ? -1 : 1)),
    unlinkedReleases,
  };
}

// 全量满足度报告：rows 已按满足率从低到高排（差额大的在前），priority 是同一次计算的名次。
function satisfactionReport(data, query) {
  const q = query || {};
  let demands = data.demands.slice();
  if (q.userId) demands = demands.filter((d) => d.userId === q.userId);
  if (q.reservoirId) demands = demands.filter((d) => d.reservoirId === q.reservoirId);
  if (q.from) demands = demands.filter((d) => d.windowEnd >= q.from);
  if (q.to) demands = demands.filter((d) => d.windowStart <= q.to);

  let rows = demands.map((d) => satisfactionRow(data, d));
  rows.sort((a, b) => {
    if (a.rate !== b.rate) return a.rate - b.rate;
    if (a.gapWan !== b.gapWan) return b.gapWan - a.gapWan;
    if (a.windowStart !== b.windowStart) return a.windowStart < b.windowStart ? -1 : 1;
    return a.no < b.no ? -1 : 1;
  });
  rows.forEach((row, index) => { row.rank = index + 1; });

  const priority = rows.map((row) => ({
    rank: row.rank,
    demandId: row.demandId,
    no: row.no,
    userName: row.userName,
    reservoirName: row.reservoirName,
    period: row.period,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    purpose: row.purpose,
    rate: row.rate,
    ratePercent: row.ratePercent,
    gapWan: row.gapWan,
    demandWan: row.demandWan,
    actualWan: row.actualWan,
  }));

  // 对不上的汇总（跨计划去重）
  const unmatched = [];
  const seenRelease = new Set();
  const seenAllocation = new Set();
  for (const row of rows) {
    for (const item of row.unmatchedAllocations) {
      if (seenAllocation.has(item.allocationId)) continue;
      seenAllocation.add(item.allocationId);
      unmatched.push(Object.assign({ kind: 'allocation', demandId: row.demandId, no: row.no, userName: row.userName, period: row.period }, item));
    }
    for (const item of row.unlinkedReleases) {
      if (seenRelease.has(item.releaseId)) continue;
      seenRelease.add(item.releaseId);
      unmatched.push(Object.assign({ kind: 'release', reservoirId: row.reservoirId, reservoirName: row.reservoirName }, item));
    }
  }
  unmatched.sort((a, b) => ((a.date || '') === (b.date || '') ? 0 : (a.date || '') < (b.date || '') ? -1 : 1));

  const totalDemand = round3(rows.reduce((s, r) => s + r.demandWan, 0));
  const totalActual = round3(rows.reduce((s, r) => s + r.actualWan, 0));
  const totals = {
    demandCount: rows.length,
    userCount: new Set(rows.map((r) => r.userId)).size,
    demandWan: totalDemand,
    actualWan: totalActual,
    gapWan: round3(totalDemand - totalActual),
    rate: totalDemand > 0 ? store.round(totalActual / totalDemand, 4) : 0,
    shortageCount: rows.filter((r) => r.shortage).length,
    fullCount: rows.filter((r) => !r.shortage).length,
    unmatchedCount: unmatched.length,
  };

  return { unit: data.settings.volumeUnit, totals, rows, priority, unmatched };
}

// 同一份数据连续算两遍，结果必须一模一样（确定性自检，由路由层调用）
function repeatedReport(data, query) {
  const first = satisfactionReport(data, query);
  const second = satisfactionReport(data, query);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new AppError(500, 'SATISFACTION_NONDETERMINISTIC', '满足度重复计算两遍结果不一致');
  }
  return first;
}

/* ================= 调整影响面：这次改动影响哪些时段、哪些用水户 ================= */

function rowKey(row) {
  return row.demandId;
}

// 对比调整前后两份满足度报告，列出发生变化的计划及其影响的时段、用水户
function diffReports(before, after) {
  const beforeMap = {};
  for (const r of before.rows) beforeMap[rowKey(r)] = r;
  const afterMap = {};
  for (const r of after.rows) afterMap[rowKey(r)] = r;
  const ids = new Set(Object.keys(beforeMap).concat(Object.keys(afterMap)));

  const changed = [];
  const affectedPeriods = [];
  const periodKey = new Set();
  const userMap = {};
  const fields = ['demandWan', 'actualWan', 'gapWan', 'rate', 'rank'];

  const pushPeriod = (r) => {
    const key = r.reservoirId + '|' + r.windowStart + '|' + r.windowEnd;
    if (periodKey.has(key)) return;
    periodKey.add(key);
    affectedPeriods.push({ reservoirId: r.reservoirId, reservoirName: r.reservoirName, windowStart: r.windowStart, windowEnd: r.windowEnd, period: r.period });
  };

  for (const id of ids) {
    const b = beforeMap[id];
    const a = afterMap[id];
    const changes = {};
    let changedFlag = false;
    for (const f of fields) {
      const bv = b ? b[f] : null;
      const av = a ? a[f] : null;
      if (bv !== av) { changes[f] = { before: bv, after: av }; changedFlag = true; }
    }
    // 对不上数量的变化也要点名
    const bu = b ? b.unmatchedAllocationCount + b.unlinkedReleaseCount : null;
    const au = a ? a.unmatchedAllocationCount + a.unlinkedReleaseCount : null;
    if (bu !== au) { changes.unmatchedCount = { before: bu, after: au }; changedFlag = true; }

    if (changedFlag) {
      const ref = a || b;
      changed.push({
        demandId: id,
        no: ref.no,
        userId: ref.userId,
        userName: ref.userName,
        reservoirName: ref.reservoirName,
        period: ref.period,
        windowStart: ref.windowStart,
        windowEnd: ref.windowEnd,
        present: !!a,
        removed: !a,
        changes,
        rankChanged: !!(changes.rank && changes.rank.before !== changes.rank.after),
        becameShort: !!(!(b && b.shortage) && a && a.shortage),
        resolvedShort: !!(b && b.shortage && a && !a.shortage),
      });
      if (b) pushPeriod(b);
      if (a) pushPeriod(a);
      userMap[ref.userId] = { userId: ref.userId, userName: ref.userName };
    }
  }

  affectedPeriods.sort((a, b) => ((a.reservoirId + a.windowStart) < (b.reservoirId + b.windowStart) ? -1 : 1));
  const affectedUsers = Object.keys(userMap).map((k) => userMap[k]).sort((a, b) => (a.userName < b.userName ? -1 : 1));

  return {
    changed: changed.sort((a, b) => (a.no < b.no ? -1 : 1)),
    affectedPeriods,
    affectedUsers,
    unchanged: changed.length === 0,
  };
}

module.exports = {
  flowToWan,
  listUsers,
  createUser,
  updateUser,
  removeUser,
  listDemands,
  findDemand,
  createDemand,
  updateDemand,
  removeDemand,
  listAllocations,
  saveAllocation,
  removeAllocation,
  decorateAllocation,
  satisfactionReport,
  repeatedReport,
  diffReports,
};
