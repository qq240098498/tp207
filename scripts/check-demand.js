// 需水满足度自检（零依赖，直接跑 node scripts/check-demand.js）。
// 全部在内存副本上做，不写 db.json；跑的是验收口径：
//  1. 同一份数据连算两遍，结果必须完全一致；
//  2. 计划一调，满足率与优先排序立刻变，影响面要点名时段与用水户；
//  3. 供水量能追到具体出库记录（日期、流量），追不上的要单独列出；
//  4. 出库记录与登记的各种对不上都要能检出；
//  5. 录入校验（时段顺序、日期落在时段内、出库记录归属）。
const assert = require('assert');
const store = require('../server/store');
const demand = require('../server/demand');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function rowOf(report, demandId) {
  return report.rows.find((r) => r.demandId === demandId);
}

const base = store.load();
console.log('一、基准满足度');

check('同一份数据连算两遍，结果完全一致（同一次计算重复两遍结果一致）', () => {
  const a = demand.satisfactionReport(base);
  const b = demand.satisfactionReport(clone(base));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  // 路由层用的自检函数也要过
  assert.strictEqual(JSON.stringify(demand.repeatedReport(base)), JSON.stringify(a));
});

const report = demand.satisfactionReport(base);
check('五份计划按满足率从低到高排序并给出同一次计算的名次', () => {
  assert.strictEqual(report.rows.length, 5);
  const rates = report.rows.map((r) => r.rate);
  for (let i = 1; i < rates.length; i += 1) assert.ok(rates[i] >= rates[i - 1], '满足率未从低到高');
  assert.deepStrictEqual(report.rows.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.strictEqual(rowOf(report, 'dem-0002').rate, 0, '完全没供水的计划满足率应为 0');
  assert.strictEqual(rowOf(report, 'dem-0002').rank, 1, '0% 应排第一优先');
});

check('需求量与实际供水量并排，差额与满足率口径正确', () => {
  const r1 = rowOf(report, 'dem-0001');
  assert.strictEqual(r1.demandWan, 2300);
  // 52 m³/s × 5 天 × 86400 ÷ 10000 = 2246.4
  assert.strictEqual(r1.actualWan, 2246.4);
  assert.strictEqual(r1.gapWan, 53.6);
  assert.strictEqual(r1.ratePercent, 97.67);
  assert.strictEqual(r1.shortage, true);
  const r4 = rowOf(report, 'dem-0004');
  assert.ok(r4.overSupply, '超供的计划要标出来');
  assert.strictEqual(r4.ratePercent, 103.68);
});

console.log('二、供水量追到出库记录');
check('实际供水量能对应到哪几天、各多少流量', () => {
  const r1 = rowOf(report, 'dem-0001');
  assert.strictEqual(r1.linkedReleaseCount, 5);
  const dates = r1.days.map((d) => d.date);
  assert.deepStrictEqual(dates, ['2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10']);
  assert.ok(r1.days.every((d) => d.items.length === 1 && d.items[0].releaseFlow === 52 && d.items[0].matched === true));
});

check('对不上的单独列出：登记了但对不到出库记录', () => {
  const r5 = rowOf(report, 'dem-0005');
  assert.strictEqual(r5.unmatchedAllocations.length, 1);
  assert.strictEqual(r5.unmatchedAllocations[0].date, '2026-06-05');
  assert.strictEqual(r5.unmatchedAllocations[0].flow, 40);
  assert.ok(r5.unmatchedAllocations[0].reasons.length > 0);
});

check('对不上的单独列出：时段内有出库但没登记给谁', () => {
  const r3 = rowOf(report, 'dem-0003');
  assert.deepStrictEqual(r3.unlinkedReleases.map((r) => r.date), ['2026-05-09', '2026-05-10']);
  assert.strictEqual(report.unmatched.length, 4, '汇总清单应有 4 条（2 漏登记 + 1 对不上登记 + 1 当天未挂出库）');
});

console.log('三、计划调整后立刻重算，并写清影响面');

check('调大需水量：满足率、差额立即变化，影响点名到时段与用水户', () => {
  const data = clone(base);
  demand.updateDemand(data, 'dem-0001', { demandWan: 2600 });
  const after = demand.satisfactionReport(data);
  const r1 = rowOf(after, 'dem-0001');
  // 2246.4 / 2600 = 0.864
  assert.strictEqual(r1.ratePercent, 86.4);
  assert.strictEqual(r1.gapWan, 353.6);
  const diff = demand.diffReports(report, after);
  assert.strictEqual(diff.unchanged, false);
  assert.deepStrictEqual(diff.affectedUsers.map((u) => u.userId), ['usr-0001']);
  // XU-0001 与 XU-0005（同一用水户）交换名次，两个时段都要在影响面里点名
  assert.strictEqual(diff.affectedPeriods.length, 2);
  assert.deepStrictEqual(diff.affectedPeriods.map((p) => p.windowStart).sort(), ['2026-05-06', '2026-06-01']);
  const changed = diff.changed.find((c) => c.demandId === 'dem-0001');
  assert.ok(changed.changes.rate);
  // 86.4% 插到 XU-0003（82.08%）之后，名次 4 → 3
  assert.strictEqual(changed.rankChanged, true);
  assert.strictEqual(changed.changes.rank.before, 4);
  assert.strictEqual(changed.changes.rank.after, 3);
});

check('补登记一条出库记录：漏登记消失、实际供水量与满足率上升、相关计划名次联动', () => {
  const data = clone(base);
  demand.saveAllocation(data, { demandId: 'dem-0003', date: '2026-05-09', releaseId: 'out-0051' });
  const after = demand.satisfactionReport(data);
  const r3 = rowOf(after, 'dem-0003');
  assert.strictEqual(r3.unlinkedReleases.length, 1, '5 月 9 日已对上，只剩 5 月 10 日');
  assert.strictEqual(r3.actualWan, 2954.88, '多了一天 38 m³/s = 328.32 万m³');
  // 92.34% 与 91.58% 换位：XU-0003 从第 2 降到第 3，XU-0005 升到第 2
  assert.strictEqual(r3.rank, 3);
  assert.strictEqual(rowOf(after, 'dem-0005').rank, 2);
  const diff = demand.diffReports(report, after);
  const ranks = diff.changed.filter((c) => c.rankChanged).map((c) => c.no).sort();
  assert.deepStrictEqual(ranks, ['XU-0003', 'XU-0005']);
  assert.ok(diff.affectedUsers.some((u) => u.userId === 'usr-0003'));
  assert.ok(diff.affectedUsers.some((u) => u.userId === 'usr-0001'));
});

check('调整时段：影响面同时列出新旧两个时段', () => {
  const data = clone(base);
  demand.updateDemand(data, 'dem-0004', { windowStart: '2026-09-09', windowEnd: '2026-09-13' });
  const after = demand.satisfactionReport(data);
  const diff = demand.diffReports(report, after);
  // 时段一挪，09-08 掉出、09-13 不在（无出库），供水量随之变，影响面要覆盖旧时段与新时段
  const starts = diff.affectedPeriods.map((p) => p.windowStart).sort();
  assert.deepStrictEqual(starts, ['2026-09-08', '2026-09-09']);
});

check('删除计划：计划从排序中移除，影响面标 removed', () => {
  const data = clone(base);
  demand.removeDemand(data, 'dem-0002');
  const after = demand.satisfactionReport(data);
  assert.strictEqual(after.rows.length, 4);
  const diff = demand.diffReports(report, after);
  const changed = diff.changed.find((c) => c.demandId === 'dem-0002');
  assert.strictEqual(changed.removed, true);
});

check('改完之后再连算两遍，结果仍一致', () => {
  const data = clone(base);
  demand.updateDemand(data, 'dem-0001', { demandWan: 2400 });
  demand.saveAllocation(data, { demandId: 'dem-0003', date: '2026-05-10', releaseId: 'out-0052' });
  const a = demand.satisfactionReport(data);
  const b = demand.satisfactionReport(data);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

console.log('四、录入校验');
check('时段止早于时段起、需水量非正数、缺报送人/用途都被拒绝', () => {
  const data = clone(base);
  assert.throws(() => demand.createDemand(data, {
    userId: 'usr-0001', reservoirId: 'res-0001', windowStart: '2026-05-10', windowEnd: '2026-05-01',
    demandWan: -1, purpose: '', reporter: '',
  }), (err) => err.code === 'VALIDATION_FAILED' && Object.keys(err.details).length >= 4);
});

check('实际供水日期落在计划时段之外被拒绝', () => {
  const data = clone(base);
  assert.throws(() => demand.saveAllocation(data, { demandId: 'dem-0001', date: '2026-06-01', flow: 10 }),
    (err) => err.code === 'VALIDATION_FAILED' && !!err.details.date);
});

check('出库记录不属于本计划水库 / 日期不一致被拒绝', () => {
  const data = clone(base);
  assert.throws(() => demand.saveAllocation(data, { demandId: 'dem-0003', date: '2026-05-01', releaseId: 'out-0001' }),
    (err) => err.code === 'VALIDATION_FAILED' && !!err.details.releaseId);
  assert.throws(() => demand.saveAllocation(data, { demandId: 'dem-0001', date: '2026-05-06', releaseId: 'out-0002' }),
    (err) => err.code === 'VALIDATION_FAILED' && !!err.details.releaseId);
});

check('出库记录被删后，历史登记自动转为「对不上」而不是悄悄算对', () => {
  const data = clone(base);
  data.releases = data.releases.filter((r) => r.id !== 'out-0006');
  const r1 = rowOf(demand.satisfactionReport(data), 'dem-0001');
  assert.ok(r1.unmatchedAllocations.some((a) => a.releaseId === 'out-0006'));
});

check('同一计划同一天重复登记按覆盖处理，不重复计水量', () => {
  const data = clone(base);
  const before = rowOf(demand.satisfactionReport(data), 'dem-0001').actualWan;
  demand.saveAllocation(data, { demandId: 'dem-0001', date: '2026-05-06', releaseId: 'out-0006' });
  const after = rowOf(demand.satisfactionReport(data), 'dem-0001');
  assert.strictEqual(after.actualWan, before);
  assert.strictEqual(after.allocationCount, 5);
});

console.log('\n全部 ' + passed + ' 项自检通过。');
