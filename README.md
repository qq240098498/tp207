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
- **需水满足度**：登记用水户与需水计划（需水量、时段、用途、报送人）；同一时段需求量与实际供水量并排，给差额、满足率与优先名次；每个计划能逐笔追到出库记录，对不上的出库单独列出并可当场认领。

## 口径（这一版按下列规则实现，页面上的说明与数字都要与本段一致）

1. **库容与水位**：库容在曲线的相邻两点之间线性插值；由库容反查水位也必须按**同一分段曲线反解**，两个方向要对得上（不能拿首末两点整体线性近似）。
2. **水量平衡**：入库水量 − 出库水量 − 损失 = 蓄变。流量（m³/s）换算成水量时按每天 **86400 秒**，再除以 10000 换成万 m³；损失 = 时段天数 × 每天损失（`lossPerDayWan`）。残差绝对值不超过 `balanceToleranceWan`（默认 0.5 万 m³）才算平衡。
3. **汛期**：按**日期**判断（`floodSeasonStart` 到 `floodSeasonEnd`，含两端）。汛限水位只在汛期适用，非汛期用正常蓄水位；汛期开始日之前的日子不能按汛期口径算。
4. **预警等级**：水位达到汛限/警戒要提级；**入库流量**达到 `inflowAttentionFlow`、`inflowSeriousFlow` 也要提级（两个输入都要看，不能只看水位）。
5. **指令编号**：`ZL-` 加四位，**取当前最大编号加一**；删掉指令之后新增不能重号。
6. **复制指令**：附件与说明是**各自的副本**，改一条不影响另一条。
7. **需水满足度**：
   - 出库折算与出库流量页同一口径：流量（m³/s）× 每天 **86400** 秒 ÷ 10000 = 水量（万m³）。
   - 一条出库计入某条计划的实际供水，必须同时满足：挂在**同一用水户**名下、**同一水库**、出库日期落在计划起止日内（**含两端**）。
   - 满足率 = 实际供水 ÷ 需水量 × 100%；差额 = 需水量 − 实际供水（正为缺口、负为超供）。
   - 优先名次**按满足率从低到高**全局排（同率按缺口从大到小，再按时段、编号），页面筛选不改变名次；用水户另有跨计划的总满足率与总名次。
   - 对不上账的出库分两类单列：**未认领**（没挂用水户，落在某计划时段内的标出候选计划）与**计划外出水**（挂了名但不在该户任一有效时段内）。对账：计划内 + 计划外挂名 + 未认领 = 全部出库，残差不超过 0.01 万m³ 才算对平。
   - 满足度在服务端是纯函数，`/api/satisfaction` 每次**当场连算两遍**比对，不一致直接报错，不返回可疑数字。
   - 计划新增、修改、删除或出库认领后，满足率与名次立即重算，响应里的 `impact` 写清本次影响**哪些用水户、哪些时段**（时段改前改后、满足率与名次改前改后）。
   - 同一用水户、同一水库的有效计划**时段不允许重叠**（重叠时一条出库不知算给谁）。

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
| GET / POST | /api/water-users | 用水户清单（带总满足率与总名次）/ 新增 |
| GET / PATCH / DELETE | /api/water-users/:id | 用水户详情口径 / 修改 / 删除（名下还有计划或出库时拒绝删除） |
| GET / POST | /api/plans | 需水计划清单（支持 reservoirId、waterUserId、from、to、includeRevoked）/ 新增 |
| PATCH / DELETE | /api/plans/:id | 修改计划 / 删除；响应带 `impact` 影响面 |
| GET | /api/satisfaction?reservoirId=&waterUserId=&from=&to= | 满足度报表（rows/ranking/userRanking/unmatched/reconciliation，服务端连算两遍） |
| PATCH | /api/flows/release/:id/assign | 出库记录认领用 `{"waterUserId":""}` 为取消认领；响应带 `impact` |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
