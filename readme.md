# koishi-plugin-monetary-bourse

[![npm](https://img.shields.io/npm/v/koishi-plugin-monetary-bourse?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-monetary-bourse) [![GitHub stars](https://img.shields.io/github/stars/BYWled/koishi-plugin-monetary-bourse?style=flat-square&logo=github)](https://github.com/BYWled/koishi-plugin-monetary-bourse) [![Gitee](https://img.shields.io/badge/Gitee-Project-c71d23?style=flat-square&logo=gitee&logoColor=white)](https://gitee.com/BYWled/koishi-plugin-monetary-bourse)

为 Koishi 提供基于 `monetary` 通用货币系统的股票交易所功能。

本插件模拟了一个具备自动宏观调控、25种经典K线形态、智能概率博弈和可视化交割单的深度拟真股票市场。用户可以使用机器人通用的货币（如信用点）进行股票买卖、炒股理财。

> 版本：**2.0.2**

## ✨ 特性

- **📈 拟真 K 线引擎**：
  - 海量形态库：内置 25 种 经典日内走势形态，分为 看涨/看跌/中性 三大类。包含红三兵、黑三鸦、跳空缺口、收敛/发散三角、箱体震荡等专业技术形态。
  - 智能剧本调度：不再是纯随机！系统根据宏观目标价格与当前价的偏离度，动态调整形态出现概率。当股价低估时，看涨形态概率自动提升，模拟市场的“估值修复”功能。
  - 周期末端修正：在宏观周期尾声（最后20%时间）自动加强回归力度，确保长周期趋势的有效性。
- **🖼️ 全可视化交互**：
  - **专业走势图**：复刻 TradingView 风格的深色玻璃拟态 K 线图，包含动态呼吸灯、渐变填充与详细指标。
  - **持仓资产卡片**：精美渲染个人持仓、成本分析、浮动盈亏比及排队中的挂单详情。
  - **交易交割单**：**(New)** 买卖成交瞬间生成**交易回单图片**，在 K 线图上精确标记买卖点位，直观展示单笔盈亏与买入成本线。
- **❄️ 资金冻结与挂单排队**：
  - 交易采用 T+0 机制，但大额资金/股票会根据金额计算**动态冻结时间**。
  - 挂单采用**串行排队模式**，同一用户的多个挂单需依次读秒，防止通过拆单绕过冻结机制，增加博弈深度。
- **🏦 银行联动**：支持与[ `koishi-plugin-monetary-bank`](https://github.com/BYWled/koishi-plugin-monetary-bank)[![npm](https://img.shields.io/npm/v/koishi-plugin-monetary-bank?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-monetary-bank) 联动，现金不足时自动扣除银行活期存款。

## 📦 依赖

本插件需要以下服务：
- `database`: 用于存储持仓、历史行情和挂单记录。
- `puppeteer`: 用于渲染股市行情图。
- `monetary`: (可选) 用于获取用户货币余额（本插件直接操作数据库表，monetary 插件需安装以建立表结构）。

## 🎮 指令说明

### 用户指令

- **`stock [interval]`**
  - 查看股市行情。
  - 参数 `interval`: 可选 `day` (日线)、`week` (周线)，不填默认为实时走势（最近100条）。
  - 示例：`stock` (查看实时), `stock day` (查看日线)。

- **`stock.buy <amount>`**
  - 买入股票。
  - 参数 `amount`: 购买股数（整数）。
  - 说明：扣除现金（优先）或银行活期，股票将在冻结时间结束后到账。
  - *新特性：若无冻结时间（小额或配置设置），将直接返回一张包含买入点位标记的**交易交割单图片**。*
  
- **`stock.sell <amount>`**
  - 卖出股票。
  - 参数 `amount`: 卖出股数（整数）。
  - 说明：扣除持仓，获得的资金将在冻结时间结束后到账。
  - *新特性：成交后返回**收益结算图**，包含本次交易的盈亏金额、盈亏百分比及买入成本线对比。*
  
- **`stock.my`**
  - 查看我的账户。
  - 显示当前持仓、市值以及正在进行中（冻结中）的买卖订单。

### 管理员指令 (权限等级 3)

- **`stock.control <price> [hours]`**
  - 设置宏观调控目标。
  - 说明：强行引导股价在指定时间内向目标价格移动。若目标涨跌超出±50%限幅，会自动调整至限幅边界后再应用。
  - 示例：`stock.control 5000 12` (在12小时内让股价涨/跌到5000)。

- **`stock.pattern`** *(Alpha 2 新增)*
  - 强制切换 K 线模型。
  - 说明：手动随机切换当前使用的日内走势剧本（如从“单边下跌”切换为“尾盘拉升”）。

- **`bourse.admin.market <status>`**
  - 设置股市开关状态。
  - 参数 `status`: `open` (开启), `close` (关闭), `auto` (自动)。
  - 说明：手动开市时会自动重置并切换一个新的日内 K 线形态。

- 【默认不开启】**`bourse.test.price [ticks]`**
  - 开发测试：推进价格更新若干次并返回当前价格。
  - 参数 `ticks`: 推进次数，默认 1，最大 500。
  - 需要在配置中启用 `enableDebug` 才可使用。

- 【默认不开启】**`bourse.test.run <ticks> [step]`**
  - 开发测试：按虚拟时间推进并统计价格分布。
  - 参数 `ticks`: 推进步数；`step`: 每步秒数（默认120秒）。
  - 需要在配置中启用 `enableDebug` 才可使用。

- 【默认不开启】**`bourse.test.manualThenAuto <target> [hours] [ticks]`**
  - 开发测试：测试手动调控后切回自动的连续性。
  - 需要在配置中启用 `enableDebug` 才可使用。

## 💡 常见问题

**Q：Alpha版本有什么区别？**

A：本插件在发布一个稳定版之前会进行测试，但是股票的走向和时间有关，即使通过开发调试，也难以测试出稳定的结果。因此，在新版本开发出来后（尤其是*算法*上的更新），我不确定是否存在非致命但影响体验的漏洞。

Alpha版本就是在新版本稳定之前的**过渡版**，它们具备了一些没有验证的新功能等更新，但与之一同的是未知的bug。如需使用Alpha版本，请备份数据库和配置文件，防止以外发生。

---

**Q: 为什么买了股票没有立刻到账？**

A: 本插件设计了基于交易金额的动态冻结机制。交易额越大，冻结时间越长（可配置）。请使用 `stock.my` 查看剩余解冻时间。

---

**Q: 股价是如何波动的？（2.0.0 算法升级）** 

A: 股价采用 **"智能期望模型"** 驱动，更贴近真实博弈：

1. **宏观漂移 (Drift)**：价格总是倾向于向"宏观目标价"回归。
2. **形态博弈 (Pattern Gaming)**：
   - 系统内置了 **25种** K线形态（如：`bullish_three_soldiers` 红三兵, `bearish_three_crows` 黑三鸦, `neutral_converging` 收敛三角）。
   - **智能选择**：每隔一段时间，系统会计算当前价与目标价的**偏离度 (Deviation)**。
   - 如果当前价**严重低于**目标价，系统选中**看涨形态**的概率会大幅提升；反之则倾向于看跌形态。
3. **动态波动率**：开盘与收盘时段波动率高，午盘平稳（U型曲线）。
4. **随机游走**：叠加几何布朗运动噪音，模拟市场不可预测的随机性。

## 🔧 配置项

可以在控制台插件配置页进行设置：

### 基础设置
- **currency**: 货币单位名称（默认：`信用点`）。
- **stockName**: 股票名称（默认：`Koishi股份`）。
- **initialPrice**: 股票初始价格（默认：`1200`）。
- **maxHoldings**: 单人最大持仓限制（默认：`100000`）。

### 交易时间
- **openHour**: 每日开市时间（小时，0-23，默认 `8` 点）。
- **closeHour**: 每日休市时间（小时，0-23，默认 `23` 点）。
- **marketStatus**: 股市总开关，可选 `open` (强制开启)、`close` (强制关闭)、`auto` (自动按时间)。

### 冻结机制
- **freezeCostPerMinute**: 每多少货币金额计为1分钟冻结时间（默认 `100`）。
- **minFreezeTime**: 最小冻结时间（分钟，默认 `10`）。
- **maxFreezeTime**: 最大冻结时间（分钟，默认 `1440` 即24小时）。

### 开发者选项
- **enableDebug**: 是否启用调试模式（默认 `false`）。开启后可使用 `bourse.test.*` 系列调试指令。

### 宏观调控
- 已移除配置项中的手动宏观调控字段；请使用管理员指令进行宏观调控。