// 一次性种子：用水户、需水计划、实际供水（分摊）演示数据。
// 直接重写 data/db.json 里的 waterUsers / demands / allocations 三组，重复执行结果一致。
// 场景覆盖：供不够、刚好缺口、超供、整段没供、时段内有出库但没对上、登记对不到出库记录。
const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'data', 'db.json');
const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));

function releaseOf(reservoirId, date) {
  const r = data.releases.find((x) => x.reservoirId === reservoirId && x.date === date);
  if (!r) throw new Error('找不到出库记录 ' + reservoirId + ' ' + date);
  return r;
}

data.waterUsers = [
  { id: 'usr-0001', code: 'YH001', name: '青岭东干渠用水户协会', contact: '王会长', canal: '东干渠', remark: '灌溉大户', createdAt: '2026-04-20' },
  { id: 'usr-0002', code: 'YH002', name: '青岭西干渠用水户协会', contact: '李主任', canal: '西干渠', remark: '', createdAt: '2026-04-20' },
  { id: 'usr-0003', code: 'YH003', name: '白河灌区管理所', contact: '赵站长', canal: '白河总干', remark: '', createdAt: '2026-04-22' },
  { id: 'usr-0004', code: 'YH004', name: '青岭镇自来水厂', contact: '陈厂长', canal: '供水专线', remark: '生活供水', createdAt: '2026-04-25' },
];

data.demands = [
  {
    id: 'dem-0001', no: 'XU-0001', userId: 'usr-0001', reservoirId: 'res-0001',
    windowStart: '2026-05-06', windowEnd: '2026-05-10',
    // 52 m³/s × 5 天 = 2246.4 万m³，计划 2300，缺 53.6
    demandWan: 2300, purpose: '春灌', reporter: '王会长', submittedAt: '2026-04-28',
    remark: '东干渠一轮春灌', createdAt: '2026-04-28',
  },
  {
    id: 'dem-0002', no: 'XU-0002', userId: 'usr-0002', reservoirId: 'res-0001',
    windowStart: '2026-05-06', windowEnd: '2026-05-10',
    demandWan: 1500, purpose: '春灌', reporter: '李主任', submittedAt: '2026-04-28',
    remark: '西干渠同期用水，实际未安排', createdAt: '2026-04-28',
  },
  {
    id: 'dem-0003', no: 'XU-0003', userId: 'usr-0003', reservoirId: 'res-0002',
    windowStart: '2026-05-01', windowEnd: '2026-05-10',
    // 38 m³/s × 10 天 = 3283.2 万m³，只登记到 8 天，计划 3200，缺两天的水
    demandWan: 3200, purpose: '灌溉', reporter: '赵站长', submittedAt: '2026-04-25',
    remark: '5 月 9、10 日没有登记供水', createdAt: '2026-04-25',
  },
  {
    id: 'dem-0004', no: 'XU-0004', userId: 'usr-0004', reservoirId: 'res-0001',
    windowStart: '2026-09-08', windowEnd: '2026-09-12',
    // 60 m³/s × 5 天 = 2592 万m³，计划 2500，实际超供
    demandWan: 2500, purpose: '生活供水', reporter: '陈厂长', submittedAt: '2026-09-01',
    remark: '实际放水大于计划', createdAt: '2026-09-01',
  },
  {
    id: 'dem-0005', no: 'XU-0005', userId: 'usr-0001', reservoirId: 'res-0001',
    windowStart: '2026-06-01', windowEnd: '2026-06-05',
    // 96 m³/s 四天 3317.76 万m³ + 纸上登记 40 m³/s 一天 345.6（对不上），计划 4000
    demandWan: 4000, purpose: '夏灌', reporter: '王会长', submittedAt: '2026-05-28',
    remark: '6 月 5 日报表与出库记录对不上', createdAt: '2026-05-28',
  },
];

const allocations = [];
function link(demandId, reservoirId, dates) {
  for (const date of dates) {
    const r = releaseOf(reservoirId, date);
    allocations.push({
      id: 'alc-' + String(allocations.length + 1).padStart(4, '0'),
      demandId, date, releaseId: r.id, flow: r.flow,
      recorder: '值班员', remark: '', createdAt: '2026-09-20',
    });
  }
}
function manual(demandId, date, flow, remark) {
  allocations.push({
    id: 'alc-' + String(allocations.length + 1).padStart(4, '0'),
    demandId, date, releaseId: '', flow,
    recorder: '王会长', remark: remark || '纸上登记，对不到出库记录', createdAt: '2026-09-20',
  });
}

// XU-0001：05-06~05-10 五天出库全挂上（5×52 m³/s = 224.64 万m³，计划 230，差 5.36）
link('dem-0001', 'res-0001', ['2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10']);
// XU-0002：同期一份计划，一条实际供水都不挂（满足率 0，优先排序第一）
// XU-0003：只挂 05-01~05-08 八天，05-09、05-10 两天出库记录留在「对不上」里
link('dem-0003', 'res-0002', ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']);
// XU-0004：09-08~09-12 五天全挂上（5×60 = 259.2，计划 200，超供）
link('dem-0004', 'res-0001', ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);
// XU-0005：06-01~06-04 挂四天出库，06-05 只在纸上登记 40 m³/s、不挂出库记录（当天实际出库 96）
link('dem-0005', 'res-0001', ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']);
manual('dem-0005', '2026-06-05', 40, '协会报表填 40，出库记录当天是 96');

data.allocations = allocations;

fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), 'utf8');
console.log('种子写入完成：用水户 ' + data.waterUsers.length + ' 个、需水计划 ' + data.demands.length + ' 份、实际供水登记 ' + data.allocations.length + ' 条');
