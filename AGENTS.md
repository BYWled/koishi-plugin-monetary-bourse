# AGENTS.md — koishi-plugin-monetary-bourse

> AI Agent 开发流程指南。收到开发任务时，按本文件定义的阶段依次执行。

## 项目速查

- **插件名**: `koishi-plugin-monetary-bourse` v3.0.2
- **入口**: `src/index.ts`（核心引擎 + 数据库 + 命令注册）
- **模块**: 按职责拆分为 6 个文件，通过依赖注入连接
- **编译**: `tsc` + 复制模板脚本，产物提交到 `lib/`
- **依赖**: `database`（必需）、`puppeteer`（必需）、`monetary`（可选，数据库直读）

## 开发流程

### 阶段一：需求分析与评审

收到需求后，先做以下检查再动手：

1. **定位影响范围** — 代码分布在多个模块中，根据需求类型定位：

   | 需求类型 | 主要文件 | 辅助文件 |
   |---|---|---|
   | 价格引擎/宏观调控 | `index.ts`（updatePrice, selectPatternByExpectation） | `pattern.ts` |
   | 买卖交易/冻结机制 | `commands-stock.ts` | `index.ts`（pay, settleTransaction） |
   | 管理员功能 | `commands-admin.ts` | `index.ts`（bourse_state 操作） |
   | 图表/卡片渲染 | `render.ts` | `templates/*.html` |
   | 分红系统 | `index.ts`（checkAndExecuteDividend） | `utils/holding-summary.ts` |
   | 新闻播报 | `index.ts`（broadcastMacroNews） | `utils/broadcast.ts` |
   | 持仓计算 | `utils/holding-summary.ts` | — |

2. **检查价格引擎副作用** — 修改 `updatePrice()` 前必须理解三力叠加模型：
   - K线形态增量（`pattern.ts` 的 25 个形态）
   - 均值回归（朝目标价格方向拉）
   - 随机游走（Box-Muller 正态分布 + U 形波动曲线）
   - 价格限制：±50% 周期基价硬限，±30% 日开盘价软限

3. **检查跨插件影响** — 本插件依赖两张外部表：
   - `monetary` 表（现金余额）— 通过 `pay()` / `changeMonetary()` 操作
   - `monetary_bank_int` 表（银行活期）— 通过 `getBankDemandBalance()` / `deductBankDemand()` 只读
   - 修改支付逻辑时必须同时检查这两个数据源

4. **检查冻结/排队逻辑** — 买卖操作涉及 `bourse_pending` 表的时序管理：
   - 同类型订单串行排队（新订单在上一个结束后开始）
   - 冻结时间 = `cost / freezeCostPerMinute`，受 min/max 限制
   - `maxFreezeTime = 0` 时即时成交（特殊路径）

5. **向用户确认** — 将分析结果和实施方案告知用户，获得确认后再进入实现阶段

### 阶段二：实现

#### 模块修改指南

| 要改什么 | 改哪个文件 | 注意事项 |
|---|---|---|
| 引擎/数据库/生命周期 | `index.ts` | 价格引擎约 200 行，分红约 200 行 |
| 用户命令 | `commands-stock.ts` | 通过 `StockCommandDeps` 注入引擎函数 |
| 管理命令 | `commands-admin.ts` | authority 3，通过 `AdminCommandDeps` 注入 |
| 调试命令 | `commands-tests.ts` | authority 3，通过 `TestCommandDeps` 注入 |
| K线形态 | `pattern.ts` | 返回 `KLinePatternType` 对象 |
| 图表渲染 | `render.ts` | 使用 Puppeteer + HTML 模板 |
| HTML 模板 | `templates/*.html` | Mustache 风格占位符 |
| 持仓计算 | `utils/holding-summary.ts` | 纯函数，易于测试 |
| 频道解析 | `utils/broadcast.ts` | `platform:channelId` 格式 |

#### 依赖注入模式

命令模块不直接 import 引擎函数，而是通过 deps 对象接收闭包：

```typescript
// commands-stock.ts
export interface StockCommandDeps {
  bourse_state: BourseState
  updatePrice: () => Promise<void>
  pay: (uid, amount) => Promise<{success, error?}>
  renderStockImage: RenderStockImage
  // ... 其他引擎函数
}

export function registerStockCommands(ctx, config, deps: StockCommandDeps) { ... }
```

在 `index.ts` 中组装：

```typescript
registerStockCommands(ctx, config, {
  bourse_state,
  updatePrice,
  pay,
  renderStockImage,
  // ...
})
```

新增引擎功能时：先在 `index.ts` 中实现函数，再添加到对应 deps 接口，最后在命令模块中使用。

#### 需要新增数据库字段时

1. 在 `index.ts` 的 `ctx.model.extend()` 调用中添加字段
2. 更新对应的 TypeScript 接口（`BourseHolding`, `BoursePending`, `BourseHistory`, `BourseState`）
3. 如果涉及 `bourse_holding` 或 `bourse_pending`，更新 `utils/holding-summary.ts` 的计算逻辑

#### 需要新增命令时

1. 确定命令分类：用户 → `commands-stock.ts`，管理 → `commands-admin.ts`，调试 → `commands-tests.ts`
2. 在对应文件的注册函数中添加 `.subcommand()` 调用
3. 如果需要引擎函数，添加到对应的 deps 接口并在 `index.ts` 中注入
4. 使用 `.userFields(['id'])` 获取用户数字 ID

#### 需要新增K线形态时

1. 在 `pattern.ts` 中添加新的模式函数
2. 函数签名：`(progress: number) => number`（返回价格偏移系数）
3. 指定 `category`（bullish/bearish/neutral）和 `endBias`（末端偏向值）
4. 添加到 `PATTERN_LIBRARY` 数组中

### 阶段三：验证与测试

1. **编译检查**: `npm run build`（tsc + 模板复制）
2. **调试命令验证**: 使用 authority 3 的测试命令：
   - `bourse.test.price [ticks]` — 推进价格 N 次，观察价格变化是否合理
   - `bourse.test.run <ticks> [step]` — 虚拟时间模拟，验证分红/结算
   - `bourse.test.manualThenAuto <target> [hours] [ticks]` — 测试手动→自动衔接
3. **逻辑走查** — 检查关键路径：
   - 买入: 余额检查 → 冻结订单创建 → 到期扣款 → 持仓更新
   - 卖出: 持仓检查 → 冻结订单创建 → 到期结算 → 现金入账
   - 价格更新: 形态选择 → 三力叠加 → 价格限制 → 历史记录
   - 分红: EDPR 计算 → 金额分发 → 除权降价 → 宏观重置
4. **渲染测试**: 确认 `render.ts` 的三个函数能正确生成图片
5. **跨插件检查**: 修改支付逻辑后，验证 monetary 和 monetary_bank_int 表操作

### 阶段四：发布前文档

完成后更新以下内容：

1. **CHANGELOG.md**: 在顶部添加新版本条目，格式遵循现有模式（按 Added/Changed/Fixed 分类）
2. **package.json**: 更新 `version` 字段
3. **readme.md**: 如有新功能、新命令或配置变更，更新对应章节
4. **编译**: 运行 `npm run build` 更新 `lib/` 产物
5. **Koishi 编译**: 在插件所在的 koishi 根目录运行 `npm run build monetary-bourse` 更新 `lib/` 产物
6. **usage 导出**: 如有重大功能变更，更新 `index.ts` 中的 `usage` HTML 字符串

## 关键代码位置速查

| 功能 | 文件 | 说明 |
|---|---|---|
| Config Schema 定义 | index.ts | `Config` 导出 + `Schema.intersect` |
| 数据库表声明 | index.ts | 4 个 `ctx.model.extend()` 调用 |
| 价格引擎 | index.ts | `updatePrice()`，约 200 行 |
| 形态选择 | index.ts | `selectPatternByExpectation()` |
| 分红引擎 | index.ts | `checkAndExecuteDividend()`，约 200 行 |
| 新闻播报 | index.ts | `broadcastMacroNews()` |
| 支付/银行联动 | index.ts | `pay()`, `getBankDemandBalance()`, `deductBankDemand()` |
| 买卖命令 | commands-stock.ts | `registerStockCommands()` |
| 管理命令 | commands-admin.ts | `registerAdminCommands()` |
| K线形态库 | pattern.ts | 25 个形态，3 个分类 |
| 图表渲染 | render.ts | `renderStockImage()`, `renderTradeResultImage()`, `renderHoldingImage()` |
| 持仓计算 | utils/holding-summary.ts | `buildHoldingSummary()` |
| 频道解析 | utils/broadcast.ts | `parseChannelTarget()`, `chunkLines()` |

## 数据库表结构

### `bourse_holding` — 持仓

```
id: unsigned  |  userId: string  |  uid: unsigned  |  stockId: string（固定 "MAIN"）
amount: integer  |  totalCost: double
```

### `bourse_pending` — 冻结订单

```
id: unsigned (PK)  |  userId: string  |  uid: unsigned  |  stockId: string
type: "buy"|"sell"  |  amount: integer  |  price: double  |  cost: double
buyCost: double  |  startTime: timestamp  |  endTime: timestamp
```

### `bourse_history` — 价格历史

```
id: unsigned (PK)  |  stockId: string  |  price: double  |  time: timestamp
```

### `bourse_state` — 宏观状态

```
key: string（固定 "macro_state"）  |  lastCycleStart: timestamp  |  startPrice: double
targetPrice: double  |  trendFactor: double（遗留，始终 0）  |  mode: "auto"|"manual"
endTime: timestamp  |  marketOpenStatus: "open"|"close"|"auto"  |  lastDividendDate: timestamp
```

### 外部表

- `monetary` — 现金余额（koishi-plugin-monetary），通过 `changeMonetary()` 操作
- `monetary_bank_int` — 银行活期（koishi-plugin-monetary-bank），通过 `getBankDemandBalance()` / `deductBankDemand()` 只读

## 依赖关系

```
monetary-bourse
├── 必需: database, puppeteer
├── 可选: monetary（数据库层）
├── 软依赖: monetary-bank（查询 monetary_bank_int 表）
└── 被依赖: 无
```
