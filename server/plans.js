// 用水户台账与需水计划的增改删；每次写入都带回本次调整对满足度的影响面
const { AppError } = require('./errors');
const store = require('./store');
const reservoirs = require('./reservoirs');
const satisfaction = require('./satisfaction');

const USER_STATUS = ['正常', '停用'];
const PLAN_STATUS = ['已报送', '已调整', '已撤销'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------- 用水户 ---------------- */

function decorateUser(data, user) {
  const planCount = data.plans.filter((p) => p.waterUserId === user.id && p.status !== '已撤销').length;
  const releaseCount = data.releases.filter((r) => r.waterUserId === user.id).length;
  return Object.assign({}, user, { planCount, releaseCount });
}

function listUsers(data, query) {
  const q = query || {};
  // 把全局户排名并到台账上，页面不用再自己拼
  const report = satisfaction.computeSatisfaction(data, {});
  const rankMap = new Map(report.userRanking.map((u) => [u.waterUserId, u]));
  return data.waterUsers
    .filter((u) => !q.status || u.status === q.status)
    .map((u) => {
      const rankInfo = rankMap.get(u.id);
      return Object.assign(decorateUser(data, u), {
        satisfactionRate: rankInfo ? rankInfo.satisfactionRate : null,
        rank: rankInfo ? rankInfo.rank : null,
        demandWan: rankInfo ? rankInfo.demandWan : 0,
        actualWan: rankInfo ? rankInfo.actualWan : 0,
        gapWan: rankInfo ? rankInfo.gapWan : 0,
      });
    })
    .sort((a, b) => {
      // 没有计划的户沉到最后
      if (a.rank === null && b.rank !== null) return 1;
      if (b.rank === null && a.rank !== null) return -1;
      if (a.rank !== b.rank) return (a.rank || 0) - (b.rank || 0);
      return a.code < b.code ? -1 : 1;
    });
}

function findUser(data, id) {
  const found = data.waterUsers.find((u) => u.id === id);
  if (!found) throw new AppError(404, 'WATER_USER_NOT_FOUND', '这个用水户不存在');
  return found;
}

function nextUserCode(data) {
  let max = 0;
  data.waterUsers.forEach((u) => {
    const m = String(u.code || '').match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return 'YH' + String(max + 1).padStart(3, '0');
}

function validateUser(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.name || '').trim()) errors.name = '用水户名称不能为空';
  if (!USER_STATUS.includes(merged.status)) errors.status = '状态只能是：' + USER_STATUS.join('、');
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '用水户信息没通过校验，请按提示补齐', errors);
  }
  return merged;
}

function createUser(data, payload) {
  const merged = validateUser(payload, { status: '正常' });
  const user = {
    id: store.nextId('usr', data.waterUsers),
    code: String(payload.code || '').trim() || nextUserCode(data),
    name: String(merged.name).trim(),
    contact: String(payload.contact || '').trim(),
    phone: String(payload.phone || '').trim(),
    reach: String(payload.reach || '').trim(),
    status: merged.status,
    remark: String(payload.remark || ''),
  };
  data.waterUsers.push(user);
  return decorateUser(data, user);
}

function updateUser(data, id, payload) {
  const user = findUser(data, id);
  const merged = validateUser(payload, user);
  Object.assign(user, {
    code: payload.code !== undefined ? String(payload.code).trim() || user.code : user.code,
    name: String(merged.name).trim(),
    contact: payload.contact !== undefined ? String(payload.contact).trim() : user.contact,
    phone: payload.phone !== undefined ? String(payload.phone).trim() : user.phone,
    reach: payload.reach !== undefined ? String(payload.reach).trim() : user.reach,
    status: merged.status,
    remark: payload.remark !== undefined ? String(payload.remark) : user.remark,
  });
  return decorateUser(data, user);
}

function removeUser(data, id) {
  findUser(data, id);
  const planCount = data.plans.filter((p) => p.waterUserId === id).length;
  const releaseCount = data.releases.filter((r) => r.waterUserId === id).length;
  if (planCount || releaseCount) {
    throw new AppError(409, 'WATER_USER_IN_USE', '这个用水户名下还有 ' + planCount + ' 条计划、' + releaseCount + ' 条出库记录，不能删除', {
      planCount, releaseCount,
    });
  }
  data.waterUsers = data.waterUsers.filter((u) => u.id !== id);
  return { removed: id };
}

/* ---------------- 需水计划 ---------------- */

function listPlans(data, query) {
  const q = query || {};
  const report = satisfaction.computeSatisfaction(data, q);
  // 显示行已带全部派生字段；额外把撤销的计划也列出来（报表只统计非撤销）
  const rowMap = new Map(report.rows.map((r) => [r.planId, r]));
  let plans = data.plans.slice();
  if (q.includeRevoked !== '1') plans = plans.filter((p) => p.status !== '已撤销');
  if (q.reservoirId) plans = plans.filter((p) => p.reservoirId === q.reservoirId);
  if (q.waterUserId) plans = plans.filter((p) => p.waterUserId === q.waterUserId);
  if (q.from) plans = plans.filter((p) => p.endDate >= q.from);
  if (q.to) plans = plans.filter((p) => p.startDate <= q.to);
  return plans
    .map((p) => {
      const row = rowMap.get(p.id);
      if (row) return row;
      const user = data.waterUsers.find((u) => u.id === p.waterUserId);
      const reservoir = data.reservoirs.find((r) => r.id === p.reservoirId);
      return {
        planId: p.id, waterUserId: p.waterUserId,
        waterUserCode: user ? user.code : '', waterUserName: user ? user.name : '',
        reservoirId: p.reservoirId, reservoirName: reservoir ? reservoir.name : '',
        startDate: p.startDate, endDate: p.endDate, days: satisfaction.planDays(p.startDate, p.endDate),
        purpose: p.purpose || '', reporter: p.reporter || '', reportedAt: p.reportedAt || '',
        status: p.status, remark: p.remark || '',
        demandWan: store.round(Number(p.demandWan) || 0, 3),
        actualWan: null, gapWan: null, satisfactionRate: null, satisfied: false,
        releaseCount: 0, releases: [], rank: null, revoked: true,
      };
    })
    .sort((a, b) => (a.startDate === b.startDate
      ? (a.endDate === b.endDate ? (a.planId < b.planId ? -1 : 1) : a.endDate < b.endDate ? -1 : 1)
      : a.startDate < b.startDate ? -1 : 1));
}

function findPlan(data, id) {
  const found = data.plans.find((p) => p.id === id);
  if (!found) throw new AppError(404, 'PLAN_NOT_FOUND', '这条需水计划不存在');
  return found;
}

function validatePlanPayload(data, payload, current) {
  const merged = Object.assign({
    waterUserId: '', reservoirId: '', startDate: '', endDate: '',
    demandWan: null, purpose: '', reporter: '', status: '已报送',
  }, current || {}, payload || {});
  const errors = {};

  if (!data.waterUsers.some((u) => u.id === merged.waterUserId)) errors.waterUserId = '请选择一个已登记的用水户';
  if (!data.reservoirs.some((r) => r.id === merged.reservoirId)) errors.reservoirId = '请选择一个水库';
  if (!DATE_RE.test(merged.startDate)) errors.startDate = '起始日期要按 年-月-日 填';
  if (!DATE_RE.test(merged.endDate)) errors.endDate = '结束日期要按 年-月-日 填';
  if (DATE_RE.test(merged.startDate) && DATE_RE.test(merged.endDate) && merged.endDate < merged.startDate) {
    errors.endDate = '结束日期不能早于起始日期';
  }
  const demand = Number(merged.demandWan);
  if (!Number.isFinite(demand) || demand <= 0) errors.demandWan = '需水量要填正数（万m³）';
  if (!String(merged.purpose || '').trim()) errors.purpose = '用途不能为空';
  if (!String(merged.reporter || '').trim()) errors.reporter = '报送人不能为空';
  if (!PLAN_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PLAN_STATUS.join('、');

  // 同一用水户、同一水库的有效计划时段不能重叠
  if (!errors.startDate && !errors.endDate && !errors.waterUserId && !errors.reservoirId) {
    const clash = data.plans.find((p) => p.id !== (current && current.id)
      && p.status !== '已撤销'
      && p.waterUserId === merged.waterUserId
      && p.reservoirId === merged.reservoirId
      && !(merged.endDate < p.startDate || merged.startDate > p.endDate));
    if (clash) {
      errors.startDate = '与该用水户的另一条计划时段重叠：' + clash.startDate + ' 至 ' + clash.endDate;
    }
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '需水计划没通过校验，请按提示补齐', errors);
  }
  return { merged, demand };
}

function planToRow(data, plan) {
  return satisfaction.computePlanRow(data, plan);
}

// 把结构化影响面压成一句话清单，接口直接给，前端原样显示
function impactSummary(diff) {
  const lines = [];
  if (!diff.planChangeCount) {
    lines.push('本次调整没有改变任何时段的需水、实际供水与满足率。');
    return lines;
  }
  const userNames = Array.from(new Set(diff.userChanges.map((u) => u.waterUserName).filter(Boolean)));
  lines.push('本次调整影响 ' + diff.userChangeCount + ' 个用水户（' + userNames.join('、') + '）、'
    + diff.planChangeCount + ' 个时段：');
  diff.planChanges.forEach((c) => {
    const w = c.windowAfter ? c.windowAfter.startDate + ' 至 ' + c.windowAfter.endDate
      : (c.windowBefore ? c.windowBefore.startDate + ' 至 ' + c.windowBefore.endDate : '');
    let line = '· ' + c.waterUserName + ' ' + w + '：' + c.change;
    if (c.change === '删除') {
      line += '（原满足率 ' + rateText(c.rateBefore) + '%）';
    } else if (c.change === '新增') {
      line += '，满足率 ' + rateText(c.rateAfter) + '%，优先名次第 ' + c.rankAfter + ' 位';
    } else if (c.change === '名次变动') {
      line += '（满足率仍为 ' + rateText(c.rateAfter) + '%），名次第 ' + (c.rankBefore == null ? '—' : c.rankBefore)
        + ' 位 → 第 ' + (c.rankAfter == null ? '—' : c.rankAfter) + ' 位';
    } else {
      line += '，满足率 ' + rateText(c.rateBefore) + '% → ' + rateText(c.rateAfter)
        + '%，名次第 ' + (c.rankBefore == null ? '—' : c.rankBefore) + ' 位 → 第 ' + (c.rankAfter == null ? '—' : c.rankAfter) + ' 位';
    }
    lines.push(line);
  });
  return lines;
}

function rateText(v) {
  return v === null || v === undefined ? '—' : String(v);
}

// 在改数据前拍一次满足度，改完再拍一次，diff 出影响面
function withImpact(data, mutate) {
  const before = satisfaction.computeSatisfaction(data, {});
  const subject = mutate();
  const after = satisfaction.computeSatisfaction(data, {});
  const diff = satisfaction.diffSatisfaction(before, after);
  const messages = impactSummary(diff);
  return { subject, impact: Object.assign({}, diff, { messages }), satisfaction: after };
}

function createPlan(data, payload) {
  const { merged, demand } = validatePlanPayload(data, payload, null);
  const result = withImpact(data, () => {
    const plan = {
      id: store.nextId('plan', data.plans),
      waterUserId: merged.waterUserId,
      reservoirId: merged.reservoirId,
      startDate: merged.startDate,
      endDate: merged.endDate,
      demandWan: demand,
      purpose: String(merged.purpose).trim(),
      reporter: String(merged.reporter).trim(),
      reportedAt: DATE_RE.test(merged.reportedAt) ? merged.reportedAt : store.todayIso(),
      status: '已报送',
      remark: String(payload.remark || ''),
    };
    data.plans.push(plan);
    return planToRow(data, plan);
  });
  attachRank(result);
  return result;
}

function updatePlan(data, id, payload) {
  const plan = findPlan(data, id);
  const current = {
    id: plan.id, waterUserId: plan.waterUserId, reservoirId: plan.reservoirId,
    startDate: plan.startDate, endDate: plan.endDate, demandWan: plan.demandWan,
    purpose: plan.purpose, reporter: plan.reporter, reportedAt: plan.reportedAt, status: plan.status,
  };
  const { merged, demand } = validatePlanPayload(data, payload, current);
  const result = withImpact(data, () => {
    Object.assign(plan, {
      waterUserId: merged.waterUserId,
      reservoirId: merged.reservoirId,
      startDate: merged.startDate,
      endDate: merged.endDate,
      demandWan: demand,
      purpose: String(merged.purpose).trim(),
      reporter: String(merged.reporter).trim(),
      reportedAt: merged.reportedAt,
      // 改过内容就标“已调整”，显式传状态（如撤销）以传入为准
      status: payload.status !== undefined ? merged.status : (plan.status === '已撤销' ? '已撤销' : '已调整'),
      remark: payload.remark !== undefined ? String(payload.remark) : plan.remark,
    });
    return planToRow(data, plan);
  });
  attachRank(result);
  return result;
}

// 保存接口的 subject 也带上重算后的全局名次，前端不用再二次查
function attachRank(result) {
  const hit = result.satisfaction.ranking.find((r) => r.planId === result.subject.planId);
  if (hit) result.subject.rank = hit.rank;
}

function removePlan(data, id) {
  const plan = findPlan(data, id);
  const result = withImpact(data, () => {
    data.plans = data.plans.filter((p) => p.id !== id);
    return { removed: id, planId: id };
  });
  void plan;
  return result;
}

module.exports = {
  listUsers, createUser, updateUser, removeUser, findUser, decorateUser,
  listPlans, createPlan, updatePlan, removePlan, findPlan,
  withImpact, impactSummary,
  USER_STATUS, PLAN_STATUS,
};
