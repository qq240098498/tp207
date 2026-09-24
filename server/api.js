const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const reservoirs = require('./reservoirs');
const records = require('./records');
const water = require('./water');
const summary = require('./summary');
const demand = require('./demand');

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

// 会改计划或实际供水的操作：先算调整前的满足度，落库后再算一遍，
// 把影响面（哪些计划的数字/排序变了、影响哪些时段与用水户）随响应一起返回。
function withImpact(mutator) {
  return (req, res, next) => {
    try {
      const before = demand.repeatedReport(store.load());
      const data = store.load();
      const result = mutator(data, req) || {};
      store.save(data);
      const after = demand.repeatedReport(data);
      res.json(Object.assign({}, result, {
        satisfaction: after.rows.find((r) => r.demandId === (result.demandId || '')) || null,
        impact: demand.diffReports(before, after),
      }));
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

/* 需水计划与供水满足度 */
router.get('/water-users', withData((data) => demand.listUsers(data)));
router.post('/water-users', withData((data, req) => ({ __save: true, __body: demand.createUser(data, req.body || {}) })));
router.patch('/water-users/:id', withData((data, req) => ({ __save: true, __body: demand.updateUser(data, req.params.id, req.body || {}) })));
router.delete('/water-users/:id', withData((data, req) => ({ __save: true, __body: demand.removeUser(data, req.params.id) })));

router.get('/demands', withData((data, req) => demand.listDemands(data, req.query)));
router.get('/demands/:id', withData((data, req) => {
  const found = demand.findDemand(data, req.params.id);
  const decorated = demand.listDemands(data).find((d) => d.id === found.id) || null;
  const report = demand.repeatedReport(data);
  return {
    demand: decorated,
    row: report.rows.find((r) => r.demandId === found.id) || null,
  };
}));
router.post('/demands', withImpact((data, req) => {
  const created = demand.createDemand(data, req.body || {});
  return { demandId: created.id, demand: created };
}));
router.patch('/demands/:id', withImpact((data, req) => {
  const updated = demand.updateDemand(data, req.params.id, req.body || {});
  return { demandId: updated.id, demand: updated };
}));
router.delete('/demands/:id', withImpact((data, req) => demand.removeDemand(data, req.params.id)));

router.get('/allocations', withData((data, req) => demand.listAllocations(data, req.query)));
router.post('/allocations', withImpact((data, req) => {
  const saved = demand.saveAllocation(data, req.body || {});
  return { demandId: saved.allocation.demandId, updated: saved.updated, allocation: saved.allocation };
}));
router.delete('/allocations/:id', withImpact((data, req) => {
  const current = data.allocations.find((a) => a.id === req.params.id);
  const demandId = current ? current.demandId : '';
  const result = demand.removeAllocation(data, req.params.id);
  return Object.assign({ demandId }, result);
}));

// 满足度报告：同一接口内部连算两遍做一致性自检，两遍不一致直接报错
router.get('/satisfaction', withData((data, req) => demand.repeatedReport(data, req.query)));

router.use((req, res, next) => {
  next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl));
});

module.exports = router;
