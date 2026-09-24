# 水库调度与汛限水位管理台

水库调度班用来管水位与库容、算水量平衡、盯汛限与预警、登记调度指令的小台子。

## 运行

```
npm install
npm start
```

默认端口 5207（`PORT` 可以覆盖），数据存在 `data/db.json`，页面在 `/`。

## 页面

- **概览**：水库数、今日各库水位与限水位、超限记录数、指令按状态、偏差超限的指令数、预警等级。
- **水库**：水库台账（水位口径、曲线点数、库容对不上时的提示）、水位-库容曲线的维护与查询。
- **水位与流量**：水位记录、入库流量、出库流量的登记与查询。
- **调度指令**：指令的下达、修改、复制、撤销、删除与附件的登记。
- **水量平衡**：按水库与时段算入库/出库/损失/蓄变与残差，给出是否平衡。
- **需水满足**：按用水户与时段登记需水计划（需水量、时段、用途、报送人），把实际供水对应到具体出库记录；同一时段的需求量与实际供水量并排显示，给出差额与满足率，按满足率从低到高排出优先安排的用水户；对不上的记录单独列出；计划或供水一调整，满足率与排序立刻重算，并写清这次影响哪些时段与哪些用水户。

## 口径（这一版按下列规则实现，页面上的说明与数字都要与本段一致）

1. **库容与水位**：库容在曲线的相邻两点之间线性插值；由库容反查水位也必须按**同一分段曲线反解**，两个方向要对得上（不能拿首末两点整体线性近似）。
2. **水量平衡**：入库水量 − 出库水量 − 损失 = 蓄变。流量（m³/s）换算成水量时按每天 **86400 秒**，再除以 10000 换成万 m³；损失 = 时段天数 × 每天损失（`lossPerDayWan`）。残差绝对值不超过 `balanceToleranceWan`（默认 0.5 万 m³）才算平衡。
3. **汛期**：按**日期**判断（`floodSeasonStart` 到 `floodSeasonEnd`，含两端）。汛限水位只在汛期适用，非汛期用正常蓄水位；汛期开始日之前的日子不能按汛期口径算。
4. **预警等级**：水位达到汛限/警戒要提级；**入库流量**达到 `inflowAttentionFlow`、`inflowSeriousFlow` 也要提级（两个输入都要看，不能只看水位）。
5. **指令编号**：`ZL-` 加四位，**取当前最大编号加一**；删掉指令之后新增不能重号。
6. **复制指令**：附件与说明是**各自的副本**，改一条不影响另一条。
7. **需水满足**：实际供水量按能**对应到出库记录**的部分汇总（每条出库记录只计一次），流量按每天 86400 秒、除以 10000 折成万m³；满足率 = 实际供水量 ÷ 需水量，差额 = 需水量 − 实际供水量；优先排序按满足率从低到高，名次是同一次计算给出的。登记了供水但对不到出库记录、或时段内有出库却没登记给谁，都单独列进「对不上」。满足度是纯函数，同一份数据连算两遍必须完全一致；每次调整的响应都带调整前后的影响面（变化的计划、影响的时段与用水户、满足率与名次的前后值）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/summary | 概览 |
| GET / PATCH | /api/settings | 全局设置（汛期起止、损失、容差、流量门槛等） |
| GET / POST | /api/reservoirs | 水库清单 / 新增 |
| GET / PATCH / DELETE | /api/reservoirs/:id | 水库详情（含曲线、水位、流量、指令）/ 修改 / 删除 |
| PUT | /api/reservoirs/:id/curve | 保存水位-库容曲线（校验水位与库容递增） |
| GET / POST | /api/levels | 水位记录清单（支持 reservoirId、from、to）/ 新增（同库同日同时刻覆盖） |
| DELETE | /api/levels/:id | 删除一条水位记录 |
| GET / POST | /api/flows?kind=inflow\|release | 入库或出库流量清单 / 新增 |
| DELETE | /api/flows/:kind/:id | 删除一条流量记录 |
| GET / POST | /api/orders | 调度指令清单（支持 reservoirId、status）/ 新增 |
| GET / PATCH / DELETE | /api/orders/:id | 指令详情（含实际均值与偏差）/ 修改 / 删除 |
| POST | /api/orders/:id/copy | 复制指令 |
| POST | /api/orders/:id/attachments | 给指令加附件说明 |
| GET | /api/balance?reservoirId=&from=&to= | 时段水量平衡 |
| GET | /api/curve/query?reservoirId=&level=\|capacity= | 由水位查库容、由库容反查水位 |
| GET / POST | /api/water-users | 用水户清单 / 新增 |
| PATCH / DELETE | /api/water-users/:id | 修改 / 删除（名下还有计划时拒绝删除） |
| GET / POST | /api/demands | 需水计划清单（支持 userId、reservoirId、from、to）/ 新增（响应带调整影响面） |
| GET / PATCH / DELETE | /api/demands/:id | 计划详情（含逐日满足度）/ 调整 / 删除（连带供水登记，响应均带影响面） |
| GET / POST | /api/allocations | 实际供水登记清单（支持 demandId、userId）/ 新增（挂出库记录或纸上登记，响应带影响面） |
| DELETE | /api/allocations/:id | 删除一条实际供水登记（响应带影响面） |
| GET | /api/satisfaction?reservoirId=&userId= | 满足度报告：内部连算两遍自检，含汇总、逐计划明细、优先排序、对不上清单 |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
