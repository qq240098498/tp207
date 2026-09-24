const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const reservoirs = require('./reservoirs');
const records = require('./records');
const water = require('./water');
const summary = require('./summary');
const plans = require('./plans');
const satisfaction = require('./satisfaction');

const router = express.Router();

function withData(handler) {
  return (req, res, next) => {
    try {
      const data = store.load();
      const result = handler(data, req);
      if (result && result.__save === true) store.save(data);
      if (result && typeof result === 'object' && '__body' in result) res.json(result.__body);
      else res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

router.get('/health', (req, res) => {
  res.json({ ok: true, service: '水库调度与汛限水位管理台', time: new Date().toISOString() });
});

router.get('/summary', withData((data) => summary.overview(data)));

router.get('/settings', withData((data) => data.settings));
router.patch('/settings', withData((data, req) => {
  const patch = req.body || {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) {
    if (patch[key] !== undefined) data.settings[key] = patch[key];
  }
  return { __save: true, __body: data.settings };
}));

router.get('/reservoirs', withData((data) => reservoirs.list(data)));
router.post('/reservoirs', withData((data, req) => ({ __save: true, __body: reservoirs.create(data, req.body) })));
router.get('/reservoirs/:id', withData((data, req) => reservoirs.detail(data, req.params.id)));
router.patch('/reservoirs/:id', withData((data, req) => ({ __save: true, __body: reservoirs.decorate(data, reservoirs.update(data, req.params.id, req.body)) })));
router.delete('/reservoirs/:id', withData((data, req) => ({ __save: true, __body: reservoirs.remove(data, req.params.id) })));
router.put('/reservoirs/:id/curve', withData((data, req) => ({ __save: true, __body: reservoirs.saveCurve(data, req.params.id, req.body || {}) })));

router.get('/levels', withData((data, req) => records.listLevels(data, req.query)));
router.post('/levels', withData((data, req) => ({ __save: true, __body: records.saveLevel(data, req.body || {}) })));
router.delete('/levels/:id', withData((data, req) => ({ __save: true, __body: records.removeLevel(data, req.params.id) })));

router.get('/flows', withData((data, req) => records.listFlows(data, req.query.kind === 'release' ? 'release' : 'inflow', req.query)));
router.post('/flows', withData((data, req) => ({ __save: true, __body: records.saveFlow(data, req.body && req.body.kind === 'release' ? 'release' : 'inflow', req.body || {}) })));
router.delete('/flows/:kind/:id', withData((data, req) => ({ __save: true, __body: records.removeFlow(data, req.params.kind === 'release' ? 'release' : 'inflow', req.params.id) })));

router.get('/orders', withData((data, req) => records.listOrders(data, req.query)));
router.post('/orders', withData((data, req) => ({ __save: true, __body: records.createOrder(data, req.body || {}) })));
router.get('/orders/:id', withData((data, req) => records.decorateOrder(data, records.findOrder(data, req.params.id))));
router.patch('/orders/:id', withData((data, req) => ({ __save: true, __body: records.updateOrder(data, req.params.id, req.body || {}) })));
router.post('/orders/:id/copy', withData((data, req) => ({ __save: true, __body: records.copyOrder(data, req.params.id, req.body) })));
router.post('/orders/:id/attachments', withData((data, req) => ({ __save: true, __body: records.addAttachment(data, req.params.id, req.body || {}) })));
router.delete('/orders/:id', withData((data, req) => ({ __save: true, __body: records.removeOrder(data, req.params.id) })));

router.get('/balance', withData((data, req) => {
  const { reservoirId, from, to } = req.query;
  if (!reservoirId || !from || !to) throw new AppError(400, 'INVALID_PAYLOAD', '请给出水库与起止日期');
  const result = water.balance(data, reservoirId, from, to);
  if (!result) throw new AppError(404, 'BALANCE_UNAVAILABLE', '这个水库还没有水位-库容曲线，算不了');
  return result;
}));

router.get('/curve/query', withData((data, req) => {
  const { reservoirId, level, capacity } = req.query;
  if (!reservoirId) throw new AppError(400, 'INVALID_PAYLOAD', '请先选一个水库');
  const curve = water.curveOf(data, reservoirId);
  if (!curve) throw new AppError(404, 'CURVE_NOT_FOUND', '这个水库还没有水位-库容曲线');
  const out = { reservoirId, pointCount: (curve.points || []).length, verifiedOn: curve.verifiedOn };
  if (level !== undefined) {
    out.level = Number(level);
    out.capacity = water.capacityAt(curve, level, data.settings);
  }
  if (capacity !== undefined) {
    out.capacity = Number(capacity);
    out.level = water.levelAt(curve, capacity);
    out.levelByCurve = water.levelAt(curve, capacity);
  }
  return out;
}));

/* ---------- 用水户与需水满足度 ---------- */

router.get('/water-users', withData((data, req) => plans.listUsers(data, req.query)));
router.post('/water-users', withData((data, req) => ({ __save: true, __body: plans.createUser(data, req.body || {}) })));
router.patch('/water-users/:id', withData((data, req) => ({ __save: true, __body: plans.updateUser(data, req.params.id, req.body || {}) })));
router.delete('/water-users/:id', withData((data, req) => ({ __save: true, __body: plans.removeUser(data, req.params.id) })));

router.get('/plans', withData((data, req) => plans.listPlans(data, req.query)));
router.post('/plans', withData((data, req) => {
  const out = plans.createPlan(data, req.body || {});
  return { __save: true, __body: out };
}));
router.patch('/plans/:id', withData((data, req) => {
  const out = plans.updatePlan(data, req.params.id, req.body || {});
  return { __save: true, __body: out };
}));
router.delete('/plans/:id', withData((data, req) => {
  const out = plans.removePlan(data, req.params.id);
  return { __save: true, __body: out };
}));

// 满足度报表：同一份数据当场连算两遍，结果不一致直接 500，不把半信半疑的数字给出去
router.get('/satisfaction', withData((data, req) => {
  const first = satisfaction.computeSatisfaction(data, req.query);
  const second = satisfaction.computeSatisfaction(data, req.query);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new AppError(500, 'SATISFACTION_NONDETERMINISTIC', '满足度连算两遍结果不一致，本次结果不予返回，请检查口径');
  }
  first.determinism = { repeated: true, consistent: true };
  return first;
}));

// 出库记录认领到用水户（waterUserId 传空串即取消认领）
router.patch('/flows/release/:id/assign', withData((data, req) => {
  const out = records.assignRelease(data, req.params.id, req.body || {});
  return { __save: true, __body: out };
}));

router.use((req, res, next) => {
  next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl));
});

module.exports = router;
