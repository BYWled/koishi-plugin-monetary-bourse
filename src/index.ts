import { Context, Schema, Logger } from "koishi";
import {} from "koishi-plugin-monetary";
import {} from "koishi-plugin-puppeteer";
import {
  renderHoldingImage,
  renderTradeResultImage,
  renderStockImage,
} from "./render";
import { chunkLines, parseChannelTarget } from "./utils/broadcast";
import { PatternCategory, kLinePatterns } from "./pattern";
import { registerAdminCommands } from "./commands-admin";
import { registerStockCommands } from "./commands-stock";
import { registerTestCommands } from "./commands-tests";

export const name = "monetary-bourse";
// 注入依赖：monetary(可选，用于兼容), database(必须), puppeteer(必须)
// 注意：monetaryBank 是软依赖，我们在代码中动态检查
export const inject = {
  required: ["database", "puppeteer"],
  optional: ["monetary"],
};

const logger = new Logger("bourse");

// --- 数据库模型声明 ---

// 银行插件的数据库表结构（用于直接查询）
interface MonetaryBankInterest {
  id: number;
  uid: number;
  currency: string;
  amount: number;
  type: "demand" | "fixed";
  rate: number;
  cycle: "day" | "week" | "month";
  settlementDate: Date;
  extendRequested: boolean;
  nextRate?: number;
  nextCycle?: "day" | "week" | "month";
}

declare module "koishi" {
  interface Tables {
    bourse_holding: BourseHolding;
    bourse_pending: BoursePending;
    bourse_history: BourseHistory;
    bourse_state: BourseState;
    // 银行插件的表（可选）
    monetary_bank_int: MonetaryBankInterest;
  }
}

export interface BourseHolding {
  id: number;
  userId: string;
  uid: number;
  stockId: string;
  amount: number;
  totalCost: number; // 买入总成本，用于计算盈亏
}

export interface BoursePending {
  id: number;
  userId: string;
  uid: number; // 数字类型的用户ID，用于货币操作
  stockId: string;
  type: "buy" | "sell";
  amount: number;
  price: number; // 交易时的单价
  cost: number; // 总成本或总收益
  buyCost?: number; // 卖出挂单的买入成本
  startTime: Date;
  endTime: Date;
}

export interface BourseHistory {
  id: number;
  stockId: string;
  price: number;
  time: Date;
}

// 全局状态：用于宏观调控的持久化
export interface BourseState {
  key: string; // 固定为 'macro_state'
  lastCycleStart: Date; // 本周期开始时间
  startPrice: number; // 本周期起始价格
  targetPrice: number; // 本周期目标价格
  trendFactor: number; // 每分钟的价格变化趋势量
  mode: "auto" | "manual"; // 调控模式：自动或手动
  endTime: Date; // 本周期预计结束时间
  marketOpenStatus?: "open" | "close" | "auto"; // 市场开关状态
  lastDividendDate?: Date; // 上次分红时间
}

export const usage = `
<div style="max-width: 800px; font-family: sans-serif; line-height: 1.6;">
  <div style="margin-bottom: 24px;">
    <h1 style="border-bottom: none; margin-bottom: 8px; font-size: 28px;">📈 monetary-bourse</h1>
    <p style="opacity: 0.8; font-size: 14px;">基于货币系统的可视化股票交易所插件，支持自动宏观调控与拟真 K 线形态。</p>
  </div>

  <h3>⚙️ 配置项</h3>
  <ul style="margin-top: 8px; margin-bottom: 20px;">
    <li><b>基础设置</b>：自定义货币单位（需与 monetary 系统一致）、股票名称、初始价格，以及单人最大持仓限额。</li>
    <li><b>股市开关与时间</b>：控制股市启动状态，支持设定每日开市 <code>openHour</code> 与休市 <code>closeHour</code> 实现自动启停。</li>
    <li><b>防刷冻结机制</b>：防止用户低买高卖高频刷单。通过 <code>freezeCostPerMinute</code> 调整资金与排队时间比例；设定 <code>minFreezeTime</code> 与 <code>maxFreezeTime</code> 防止过长或过短排队。可将最小时间设为 0 使小额交易秒成。</li>
    <li><b>手续费与精度</b>：可配置分档卖出手续费 <code>sellFeeTiers</code>（股数越大费率越低）；若你使用的通货不支持小数，请开启 <code>precisionInteger</code>。</li>
    <li><b>宏观调控引擎</b>：调整 <code>biasMax</code> 限制期望偏倚的极端值。此外，可以固定每日定期刷新宏观目标的时刻，以便在人流高峰期制造行情的明确转折。</li>
  </ul>

  <h3>📖 开发者建议</h3>
  <p style="font-size: 14px; opacity: 0.85;">
    部署初期，建议在下方开启 <code>enableDebug</code>，通过 <code>bourse.test.price</code> 或 <code>bourse.test.run</code> 指令生成未来一段时间的模拟量价切片，以此验证当前的参数配置是否符合贵群的市场节奏和购买力水平。调整最佳后再关闭调试选项。
  </p>
</div>
`;

export type SellFeeTier = {
  minAmount: number;
  feePercent: number;
};

export type NewsItem = {
  text: string;
  weight: number;
};

export interface Config {
  currency: string;
  stockName: string;
  initialPrice: number;
  maxHoldings: number;
  // 交易时间设置
  openHour: number;
  closeHour: number;
  // 冻结机制设置
  freezeCostPerMinute: number;
  minFreezeTime: number;
  maxFreezeTime: number;
  // 股市开关
  marketStatus: "open" | "close" | "auto";
  // 开发者选项
  enableDebug: boolean;
  // 手续费
  sellFeeTiers: SellFeeTier[];
  // 精度控制
  precisionInteger: boolean;
  // 宏观调控 — 固定更新时间
  fixedUpdateTime: boolean;
  fixedUpdateHour: number;
  // 宏观调控 — 期望偏倚最大值
  biasMax: number;
  // 分红机制
  dividendIntervalDays: number;
  maxDividendRate: number;
  dividendBroadcastChannels: string[];
  // 新闻播报机制
  newsDeviationThreshold: number;
  broadcastChannels: string[];
  positiveNews: NewsItem[];
  negativeNews: NewsItem[];
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    currency: Schema.string().default("信用点").description("货币单位名称"),
    stockName: Schema.string().default("Koishi股份").description("股票名称"),
    initialPrice: Schema.number()
      .min(0.01)
      .default(1200)
      .description("股票初始价格"),
    maxHoldings: Schema.number()
      .min(1)
      .step(1)
      .default(100000)
      .description("单人最大持仓限制"),
  }).description("基础设置"),

  Schema.object({
    marketStatus: Schema.union(["open", "close", "auto"])
      .default("auto")
      .description(
        "股市开关状态：open=强制开启，close=强制关闭，auto=按时间自动",
      ),
  }).description("股市开关"),

  Schema.object({
    openHour: Schema.number()
      .min(0)
      .max(23)
      .step(1)
      .default(8)
      .description("开市时间 (小时)"),
    closeHour: Schema.number()
      .min(0)
      .max(23)
      .step(1)
      .default(23)
      .description("休市时间 (小时)"),
  }).description("交易时间"),

  Schema.object({
    freezeCostPerMinute: Schema.number()
      .min(1)
      .default(100)
      .description("每多少货币计为1分钟冻结时间"),
    minFreezeTime: Schema.number()
      .min(0)
      .default(10)
      .description("最小冻结时间(分钟)"),
    maxFreezeTime: Schema.number()
      .min(0)
      .default(1440)
      .description("最大交易冻结时间(分钟)"),
  }).description("冻结机制"),

  Schema.object({
    sellFeeTiers: Schema.array(
      Schema.object({
        minAmount: Schema.number().min(1).step(1).description("起始股数（含）"),
        feePercent: Schema.number()
          .min(0)
          .max(100)
          .step(0.01)
          .description("手续费比例（%）"),
      }),
    )
      .role("table")
      .default([{ minAmount: 1, feePercent: 0 }])
      .description("卖出手续费分档（按股数越大费率越低匹配）"),
    precisionInteger: Schema.boolean()
      .default(false)
      .description("是否将所有计数精度设置为整数"),
  }).description("手续费与精度"),

  Schema.object({
    fixedUpdateTime: Schema.boolean()
      .default(false)
      .description("是否固定宏观目标的更新时间"),
    fixedUpdateHour: Schema.number()
      .min(0)
      .max(23)
      .step(1)
      .default(9)
      .description("固定更新时间（小时，仅 fixedUpdateTime 为 true 时生效）"),
    biasMax: Schema.number()
      .min(0.1)
      .max(0.9)
      .step(0.01)
      .default(0.45)
      .description("宏观期望上下偏倚的最大值"),
  }).description("宏观调控高级设置"),

  Schema.object({
    dividendIntervalDays: Schema.number()
      .min(1)
      .step(1)
      .default(7)
      .description("分红结算周期（天）"),
    maxDividendRate: Schema.number()
      .min(0)
      .max(1)
      .step(0.01)
      .default(0.15)
      .description("最大分红期望利润率（0-1，超出部分用于除息而非派发）"),
  }).description("分红机制"),

  Schema.object({
    dividendBroadcastChannels: Schema.array(Schema.string())
      .default([])
      .description("分红播报的频道/群聊 ID 列表（支持 onebot:123 或 123）"),
  }).description("分红播报"),

  Schema.object({
    newsDeviationThreshold: Schema.number()
      .min(0.05)
      .max(1)
      .step(0.01)
      .default(0.15)
      .description(
        "触发新闻的偏离度阈值（例如 0.15 表示当新目标价与当前价相差 15% 以上时触发）",
      ),
    broadcastChannels: Schema.array(Schema.string())
      .default([])
      .description(
        "播报新闻的频道/群聊 ID 列表（为空则只在后台输出日志，不发送群消息）",
      ),
    positiveNews: Schema.array(
      Schema.object({
        text: Schema.string().description("新闻文本"),
        weight: Schema.number().min(1).step(1).default(1).description("权重"),
      }),
    )
      .role("table")
      .default([
        {
          text: "【财经快讯】{stockName} 宣布取得重大技术突破，预期利润大增！",
          weight: 1,
        },
        {
          text: "【市场异动】神秘巨头入局，{stockName} 获大额资本注资！",
          weight: 1,
        },
      ])
      .description("利好新闻列表（可用 {stockName} 作为股票名称的占位符）"),
    negativeNews: Schema.array(
      Schema.object({
        text: Schema.string().description("新闻文本"),
        weight: Schema.number().min(1).step(1).default(1).description("权重"),
      }),
    )
      .role("table")
      .default([
        {
          text: "【黑天鹅】{stockName} 遭遇大规模不可抗力打击，市场恐慌情绪蔓延！",
          weight: 1,
        },
        {
          text: "【行业悲报】{stockName} 最新季度财报严重不及预期，高管集体减持！",
          weight: 1,
        },
      ])
      .description("利空新闻列表（可用 {stockName} 作为股票名称的占位符）"),
  }).description("新闻播报机制"),

  Schema.object({
    enableDebug: Schema.boolean()
      .default(false)
      .description("启用调试模式（开启后可使用调试指令）"),
  }).description("开发者选项"),
]);

// --- 核心实现 ---

export function apply(ctx: Context, config: Config) {
  // 1. 初始化数据库模型
  ctx.model.extend(
    "bourse_holding",
    {
      id: "unsigned",
      userId: "string",
      uid: "unsigned",
      stockId: "string",
      amount: "integer",
      totalCost: "double", // 买入总成本
    },
    { primary: ["userId", "stockId"] },
  );

  ctx.model.extend(
    "bourse_pending",
    {
      id: "unsigned",
      userId: "string",
      uid: "unsigned",
      stockId: "string",
      type: "string",
      amount: "integer",
      price: "double",
      cost: "double",
      buyCost: "double",
      startTime: "timestamp",
      endTime: "timestamp",
    },
    { autoInc: true },
  );

  ctx.model.extend(
    "bourse_history",
    {
      id: "unsigned",
      stockId: "string",
      price: "double",
      time: "timestamp",
    },
    { autoInc: true },
  );

  ctx.model.extend(
    "bourse_state",
    {
      key: "string",
      lastCycleStart: "timestamp",
      startPrice: "double",
      targetPrice: "double",
      trendFactor: "double",
      mode: "string",
      endTime: "timestamp",
      marketOpenStatus: "string",
      lastDividendDate: "timestamp",
    },
    { primary: "key" },
  );

  // 2. 股票引擎状态
  const stockId = "MAIN"; // 目前仅支持一支股票
  let currentPrice = Number(config.initialPrice.toFixed(2));

  function fmtPrice(value: number): number {
    return config.precisionInteger
      ? Math.round(value)
      : Number(value.toFixed(2));
  }

  function fmtAmount(value: number): number {
    return config.precisionInteger
      ? Math.round(value)
      : Number(value.toFixed(2));
  }

  // 启动时加载最近行情，若无则写入初始价格
  ctx.on("ready", async () => {
    const history = await ctx.database.get(
      "bourse_history",
      { stockId },
      { limit: 1, sort: { time: "desc" } },
    );
    if (history.length > 0) {
      currentPrice = fmtPrice(history[0].price);
    } else {
      await ctx.database.create("bourse_history", {
        stockId,
        price: currentPrice,
        time: new Date(),
      });
    }

    // 迁移：为旧持仓记录填充 uid（分红派发必需）
    const allHoldings = await ctx.database.get("bourse_holding", {});
    const withoutUid = allHoldings.filter((h) => !h.uid);
    if (withoutUid.length > 0) {
      logger.info(
        `迁移: 发现 ${withoutUid.length} 条持仓记录缺少 uid，开始修复...`,
      );
      // 第一来源：bourse_pending 表有直接的 userId -> uid 映射
      const allPending = await ctx.database.get("bourse_pending", {});
      const uidMap = new Map<string, number>();
      for (const p of allPending) {
        if (p.userId && p.uid && !uidMap.has(p.userId)) {
          uidMap.set(p.userId, p.uid);
        }
      }
      // 第二来源：尝试 Koishi user 表建立 id 映射
      const userTableUidMap = new Map<string, number>();
      try {
        const userTable = ctx.database.tables;
        if (userTable && "user" in userTable) {
          const allUsers = await ctx.database.get("user", {});
          for (const u of allUsers) {
            if (u.id !== undefined && u.id !== null) {
              const strId = String(u.id);
              // 直接按字符串 userId 映射
              if (!userTableUidMap.has(strId)) {
                userTableUidMap.set(strId, Number(u.id));
              }
            }
          }
        }
      } catch {
        // user 表不可用则跳过
      }
      let fixed = 0;
      for (const h of withoutUid) {
        // 第一优先：pending 映射
        const pendingUid = uidMap.get(h.userId);
        if (pendingUid) {
          await ctx.database.set(
            "bourse_holding",
            { userId: h.userId, stockId },
            { uid: pendingUid },
          );
          fixed++;
          continue;
        }
        // 第二优先：user 表映射（userId -> id）
        let userUid = userTableUidMap.get(h.userId);
        if (!userUid) {
          // 尝试 userId 中的尾部数字匹配
          const numMatch = h.userId.match(/(\d+)$/);
          if (numMatch) {
            userUid = userTableUidMap.get(numMatch[1]);
          }
        }
        if (userUid) {
          await ctx.database.set(
            "bourse_holding",
            { userId: h.userId, stockId },
            { uid: userUid },
          );
          fixed++;
          continue;
        }
        // 第三优先：尝试用 userId 的尾部数字作为 uid（部分平台 uid 即数字 userId）
        const numericMatch = h.userId.match(/(\d+)$/);
        const candidateUid = numericMatch ? Number(numericMatch[1]) : null;
        if (candidateUid && candidateUid > 0) {
          // 验证该 uid 在 monetary 表中是否有记录
          try {
            const monRecords = await ctx.database.get("monetary", {
              uid: candidateUid,
              currency: config.currency,
            });
            if (monRecords.length > 0) {
              await ctx.database.set(
                "bourse_holding",
                { userId: h.userId, stockId },
                { uid: candidateUid },
              );
              fixed++;
              logger.info(
                `迁移: 通过 userId 尾部数字推断 uid=${candidateUid} -> userId=${h.userId}`,
              );
              continue;
            }
          } catch {
            // 查询失败继续下一个策略
          }
        }
        logger.warn(
          `迁移: 无法为用户 ${h.userId} 解析 uid，将在首次买入时自动修复`,
        );
      }
      if (fixed > 0) {
        logger.info(`迁移: 成功修复 ${fixed}/${withoutUid.length} 条记录`);
      }
    }
  });

  // 追踪市场开市状态，用于在开市时切换K线模型
  let wasMarketOpen = false;
  // 记录当日开盘价，用于日内涨跌幅限制
  let dailyOpenPrice: number | null = null;
  // 内部测试用：虚拟时间（存在则以此为准，不使用系统时间）
  let __testNow: Date | null = null;

  // 市场定时任务（每 2 分钟运行一次）
  ctx.setInterval(
    async () => {
      const isOpen = await isMarketOpen();

      // 检测开市事件：从关闭变为开启
      if (isOpen && !wasMarketOpen) {
        // 开市了，记录当日开盘价（用于日内限制）
        dailyOpenPrice = currentPrice;
      }
      wasMarketOpen = isOpen;

      if (!isOpen) return;
      await updatePrice();
      await processPendingTransactions();
      await checkAndExecuteDividend();

      // 清理一个月前的记录
      const oneMonthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      await ctx.database.remove("bourse_history", {
        time: { $lt: oneMonthAgo },
      });
    },
    2 * 60 * 1000,
  );

  // 辅助：检查是否开市（简化的周末与时间校验）
  async function isMarketOpen() {
    // 优先使用配置中的开关
    if (config.marketStatus === "open") return true;
    if (config.marketStatus === "close") return false;

    // 其次检查数据库中的手动开关（命令设置的）
    const states = await ctx.database.get("bourse_state", {
      key: "macro_state",
    });
    const state = states[0];
    if (state && state.marketOpenStatus) {
      if (state.marketOpenStatus === "open") return true;
      if (state.marketOpenStatus === "close") return false;
    }

    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();

    // 0 是周日, 6 是周六
    if (day === 0 || day === 6) return false;
    if (hour < config.openHour || hour >= config.closeHour) return false;
    return true;
  }

  // --- 资金操作辅助函数 ---

  /**
   * 获取现金余额（从monetary表查询）
   * monetary 表结构：{ uid: number, currency: string, value: number }
   */
  async function getCashBalance(
    uid: number,
    currency: string,
  ): Promise<number> {
    // 注意：uid=0 是有效值，只检查类型和 NaN
    if (
      uid === undefined ||
      uid === null ||
      typeof uid !== "number" ||
      Number.isNaN(uid)
    ) {
      logger.warn(`getCashBalance: 无效的uid: ${uid}`);
      return 0;
    }

    try {
      // @ts-ignore - monetary 表由 koishi-plugin-monetary 插件定义
      const records = await ctx.database.get("monetary", { uid, currency });
      logger.info(
        `getCashBalance: uid=${uid}, currency=${currency}, records=${JSON.stringify(records)}`,
      );

      if (records && records.length > 0) {
        const value = Number(records[0].value || 0);
        return Number.isNaN(value) ? 0 : value;
      }
      return 0;
    } catch (err) {
      logger.error(
        `getCashBalance 失败: uid=${uid}, currency=${currency}`,
        err,
      );
      return 0;
    }
  }

  /**
   * 修改现金余额
   */
  async function changeCashBalance(
    uid: number,
    currency: string,
    delta: number,
  ): Promise<boolean> {
    // 注意：uid=0 是有效值，只检查类型和 NaN
    if (
      uid === undefined ||
      uid === null ||
      typeof uid !== "number" ||
      Number.isNaN(uid)
    ) {
      logger.warn(`changeCashBalance: 无效的uid: ${uid}`);
      return false;
    }

    try {
      // @ts-ignore
      const records = await ctx.database.get("monetary", { uid, currency });

      if (!records || records.length === 0) {
        // 记录不存在，尝试创建
        if (delta < 0) return false; // 无法扣款
        try {
          // @ts-ignore
          await ctx.database.create("monetary", {
            uid,
            currency,
            value: delta,
          });
          logger.info(
            `changeCashBalance: 创建新记录 uid=${uid}, currency=${currency}, value=${delta}`,
          );
          return true;
        } catch (createErr) {
          logger.error(`changeCashBalance 创建记录失败:`, createErr);
          return false;
        }
      }

      const current = Number(records[0].value || 0);
      // 保留两位小数，避免浮点数精度丢失
      const newValue = fmtAmount(current + delta);

      if (newValue < 0) {
        logger.warn(
          `changeCashBalance: 余额不足 current=${current}, delta=${delta}`,
        );
        return false;
      }

      // @ts-ignore
      await ctx.database.set(
        "monetary",
        { uid, currency },
        { value: newValue },
      );
      logger.info(
        `changeCashBalance: uid=${uid}, currency=${currency}, ${current} -> ${newValue}`,
      );
      return true;
    } catch (err) {
      logger.error(
        `changeCashBalance 失败: uid=${uid}, currency=${currency}, delta=${delta}`,
        err,
      );
      return false;
    }
  }

  /**
   * 获取银行活期余额（直接查询 monetary_bank_int 表）
   */
  async function getBankDemandBalance(
    uid: number,
    currency: string,
  ): Promise<number> {
    // 注意：uid=0 是有效值，只检查类型和 NaN
    if (
      uid === undefined ||
      uid === null ||
      typeof uid !== "number" ||
      Number.isNaN(uid)
    )
      return 0;

    try {
      // 检查表是否存在
      const tables = ctx.database.tables;
      if (!tables || !("monetary_bank_int" in tables)) {
        logger.info("getBankDemandBalance: monetary_bank_int 表不存在");
        return 0;
      }

      const records = await ctx.database.get("monetary_bank_int", {
        uid,
        currency,
        type: "demand",
      });
      logger.info(
        `getBankDemandBalance: uid=${uid}, currency=${currency}, records=${records.length}`,
      );

      let total = 0;
      for (const record of records) {
        total += Number(record.amount || 0);
      }
      return total;
    } catch (err) {
      logger.warn(`getBankDemandBalance 失败: uid=${uid}`, err);
      return 0;
    }
  }

  /**
   * 从银行活期扣款
   */
  async function deductBankDemand(
    uid: number,
    currency: string,
    amount: number,
  ): Promise<boolean> {
    // 注意：uid=0 是有效值，只检查类型和 NaN
    if (
      uid === undefined ||
      uid === null ||
      typeof uid !== "number" ||
      Number.isNaN(uid) ||
      amount <= 0
    )
      return false;

    try {
      const tables = ctx.database.tables;
      if (!tables || !("monetary_bank_int" in tables)) return false;

      // 按结算日期顺序获取活期记录
      const demandRecords = await ctx.database
        .select("monetary_bank_int")
        .where({ uid, currency, type: "demand" })
        .orderBy("settlementDate", "asc")
        .execute();

      let remaining = fmtAmount(amount);
      for (const record of demandRecords) {
        if (remaining <= 0) break;

        if (record.amount <= remaining) {
          remaining = fmtAmount(remaining - record.amount);
          await ctx.database.remove("monetary_bank_int", { id: record.id });
        } else {
          const newAmount = fmtAmount(record.amount - remaining);
          await ctx.database.set(
            "monetary_bank_int",
            { id: record.id },
            { amount: newAmount },
          );
          remaining = 0;
        }
      }

      logger.info(
        `deductBankDemand: uid=${uid}, amount=${amount}, remaining=${remaining}`,
      );
      return remaining === 0;
    } catch (err) {
      logger.error(`deductBankDemand 失败:`, err);
      return false;
    }
  }

  /**
   * 综合支付函数：优先扣除现金，不足部分扣除银行活期
   */
  async function pay(
    uid: number,
    cost: number,
    currency: string,
  ): Promise<{ success: boolean; msg?: string }> {
    logger.info(`pay: uid=${uid}, cost=${cost}, currency=${currency}`);

    const cash = await getCashBalance(uid, currency);
    const bankDemand = await getBankDemandBalance(uid, currency);

    logger.info(`pay: 现金=${cash}, 活期=${bankDemand}, 需要=${cost}`);

    if (cash + bankDemand < cost) {
      const msg = `资金不足！需要 ${cost.toFixed(2)}，当前现金 ${cash.toFixed(2)} + 活期 ${bankDemand.toFixed(2)}`;
      logger.warn(`pay 失败: ${msg}, uid=${uid}`);
      return { success: false, msg };
    }

    let remainingCost = fmtAmount(cost);

    // 1. 扣除现金
    const cashDeduct = fmtAmount(Math.min(cash, remainingCost));
    if (cashDeduct > 0) {
      const success = await changeCashBalance(uid, currency, -cashDeduct);
      if (!success) {
        logger.error(`pay 失败: 扣除现金失败 uid=${uid}, cost=${cashDeduct}`);
        return { success: false, msg: "扣除现金失败，请重试" };
      }
      remainingCost = fmtAmount(remainingCost - cashDeduct);
    }

    // 2. 扣除银行活期
    if (remainingCost > 0) {
      const success = await deductBankDemand(uid, currency, remainingCost);
      if (!success) {
        logger.error(
          `pay 失败: 银行活期扣款失败 uid=${uid}, cost=${remainingCost}`,
        );
        // 回滚现金扣除
        if (cashDeduct > 0) await changeCashBalance(uid, currency, cashDeduct);
        return { success: false, msg: "银行活期扣款失败" };
      }
    }

    return { success: true };
  }

  // --- 新闻播报辅助函数 ---

  async function sendBroadcast(
    channels: string[],
    message: string,
    label: string,
  ) {
    if (!channels || channels.length === 0) return;
    for (const raw of channels) {
      const target = parseChannelTarget(raw);
      if (!target) {
        logger.warn(`${label}: 无效频道配置 ${raw}`);
        continue;
      }
      const bot = target.platform
        ? ctx.bots.find((b) => b.platform === target.platform)
        : ctx.bots[0];
      if (!bot) {
        logger.warn(`${label}: 未找到可用 bot (${raw})`);
        continue;
      }
      try {
        await bot.sendMessage(target.channelId, message);
      } catch (err) {
        logger.warn(`${label}: 发送失败 channel=${raw}`, err);
      }
    }
  }

  async function broadcastMacroNews(targetPrice: number, basePrice: number) {
    const deviation = (targetPrice - basePrice) / basePrice;

    if (Math.abs(deviation) < config.newsDeviationThreshold) return;

    const newsPool = deviation > 0 ? config.positiveNews : config.negativeNews;
    if (!newsPool || newsPool.length === 0) return;

    const totalWeight = newsPool.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return;

    let roll = Math.random() * totalWeight;
    let selected = newsPool[newsPool.length - 1];
    for (const item of newsPool) {
      roll -= item.weight;
      if (roll < 0) {
        selected = item;
        break;
      }
    }

    const newsText = selected.text.replace(/\{stockName\}/g, config.stockName);

    logger.info(
      `触发宏观新闻播报: ${newsText} (偏离度=${(deviation * 100).toFixed(2)}%)`,
    );

    await sendBroadcast(config.broadcastChannels, newsText, "新闻播报");
  }

  // --- 宏观调控逻辑 ---

  // 按分类索引模型
  const patternsByCategory: Record<PatternCategory, string[]> = {
    bullish: [],
    bearish: [],
    neutral: [],
  };
  for (const [name, pattern] of Object.entries(kLinePatterns)) {
    patternsByCategory[pattern.category].push(name);
  }

  const patternNames = Object.keys(kLinePatterns);

  // 当前使用的K线模型
  let currentPattern: string =
    patternNames[Math.floor(Math.random() * patternNames.length)];
  // K线模型切换时的起始价格（用于计算模型内的价格变化）
  let patternStartPrice: number = currentPrice;
  // 记录上次切换时间和下次计划切换时间（用于随机时间切换）
  let lastPatternSwitchTime = new Date();
  // 初始化下次切换时间：当前时间 + 随机时长 (1-6小时)
  let nextPatternSwitchTime = new Date(
    Date.now() + (1 + Math.random() * 5) * 3600 * 1000,
  );

  /**
   * 根据期望价格智能选择K线模型
   */
  function selectPatternByExpectation(
    expectedPrice: number,
    curPrice: number,
    cycleProgress: number,
  ): string {
    const deviation = (expectedPrice - curPrice) / curPrice;
    let bullishProb = 0.33,
      bearishProb = 0.33,
      neutralProb = 0.34;
    const deviationThreshold = 0.05;

    if (Math.abs(deviation) > deviationThreshold) {
      const adjustmentStrength = Math.min(Math.abs(deviation) / 0.3, 1);
      const maxBias = config.biasMax;
      if (deviation > 0) {
        bullishProb = 0.33 + adjustmentStrength * maxBias;
        bearishProb = 0.33 - adjustmentStrength * maxBias * 0.7;
        neutralProb = 1 - bullishProb - bearishProb;
      } else {
        bearishProb = 0.33 + adjustmentStrength * maxBias;
        bullishProb = 0.33 - adjustmentStrength * maxBias * 0.7;
        neutralProb = 1 - bullishProb - bearishProb;
      }
    } else {
      neutralProb = 0.5;
      bullishProb = 0.25;
      bearishProb = 0.25;
    }

    if (cycleProgress > 0.8) {
      const endBoost = ((cycleProgress - 0.8) / 0.2) * 0.2;
      if (deviation > 0) bullishProb += endBoost;
      else if (deviation < 0) bearishProb += endBoost;
      const total = bullishProb + bearishProb + neutralProb;
      bullishProb /= total;
      bearishProb /= total;
      neutralProb /= total;
    }

    const rand = Math.random();
    let category: PatternCategory;
    if (rand < bullishProb) category = "bullish";
    else if (rand < bullishProb + bearishProb) category = "bearish";
    else category = "neutral";

    const patterns = patternsByCategory[category];
    const selected = patterns[Math.floor(Math.random() * patterns.length)];
    logger.info(
      `selectPatternByExpectation: deviation=${(deviation * 100).toFixed(2)}%, selected=${category}/${selected}`,
    );
    return selected;
  }

  // 切换K线模型的函数
  function switchKLinePattern(
    reason: string,
    expectedPrice?: number,
    cycleProgress?: number,
  ) {
    const oldPattern = currentPattern;
    if (expectedPrice !== undefined && cycleProgress !== undefined) {
      currentPattern = selectPatternByExpectation(
        expectedPrice,
        currentPrice,
        cycleProgress,
      );
    } else {
      currentPattern =
        patternNames[Math.floor(Math.random() * patternNames.length)];
    }
    patternStartPrice = currentPrice;
    const now = new Date();
    lastPatternSwitchTime = now;
    const minDuration = 1 * 3600 * 1000;
    const randomDuration = Math.random() * 5 * 3600 * 1000;
    nextPatternSwitchTime = new Date(
      now.getTime() + minDuration + randomDuration,
    );
    const oldInfo = kLinePatterns[oldPattern];
    const newInfo = kLinePatterns[currentPattern];
    logger.info(
      `${reason}切换K线模型: ${oldInfo?.name || oldPattern} -> ${newInfo.name}(${currentPattern}), 下次随机切换: ${nextPatternSwitchTime.toLocaleString()}`,
    );
  }

  async function updatePrice() {
    // 获取当前调控状态
    let state = (
      await ctx.database.get("bourse_state", { key: "macro_state" })
    )[0];
    const now = __testNow ?? new Date();

    // 确保时间类型正确
    if (state) {
      if (!state.lastCycleStart)
        state.lastCycleStart = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      if (!(state.lastCycleStart instanceof Date))
        state.lastCycleStart = new Date(state.lastCycleStart);

      if (!state.endTime)
        state.endTime = new Date(
          state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000,
        );
      if (!(state.endTime instanceof Date))
        state.endTime = new Date(state.endTime);
    }

    // 状态初始化或过期检查（手动与自动到期都应切换为自动新周期）
    let needNewState = false;
    if (!state) {
      needNewState = true;
    } else {
      const endTime =
        state.endTime ||
        new Date(state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000);
      if (now > endTime) needNewState = true;
    }

    const createAutoState = async () => {
      let endTime: Date;

      if (config.fixedUpdateTime) {
        // Fixed schedule: end at the next occurrence of fixedUpdateHour
        endTime = new Date(now);
        endTime.setHours(config.fixedUpdateHour, 0, 0, 0);
        if (endTime <= now) {
          endTime.setDate(endTime.getDate() + 1); // next day if time already passed
        }
      } else {
        const durationHours = 7 * 24;
        endTime = new Date(now.getTime() + durationHours * 3600 * 1000);
      }

      const fluctuation = 0.25; // 周目标波动范围±25%
      const targetRatio = 1 + (Math.random() * 2 - 1) * fluctuation;
      let targetPrice = currentPrice * targetRatio;

      // 限幅
      targetPrice = Math.max(
        currentPrice * 0.5,
        Math.min(currentPrice * 1.5, targetPrice),
      );

      const newState: BourseState = {
        key: "macro_state",
        lastCycleStart: now,
        startPrice: currentPrice,
        targetPrice,
        trendFactor: 0, // 不再使用线性趋势因子
        mode: "auto",
        endTime,
      };
      if (!state) await ctx.database.create("bourse_state", newState);
      else {
        const { key, ...updateFields } = newState;
        await ctx.database.set(
          "bourse_state",
          { key: "macro_state" },
          updateFields,
        );
      }
      state = newState;
    };

    if (needNewState) {
      await createAutoState();
      // 新周期生成时，若目标偏离度超过阈值则播报新闻
      await broadcastMacroNews(state.targetPrice, currentPrice);
    }

    // --- 基础参数 ---
    const basePrice = state.startPrice;
    const targetPrice = state.targetPrice;
    const totalDuration =
      state.endTime.getTime() - state.lastCycleStart.getTime();
    const elapsed = now.getTime() - state.lastCycleStart.getTime();
    const cycleProgress = Math.max(0, Math.min(1, elapsed / totalDuration));

    // ============================================================
    // K线模型切换逻辑（基于期望价格智能选择）
    // ============================================================
    const timeSinceLastSwitch = now.getTime() - lastPatternSwitchTime.getTime();
    const forceSwitchDuration = 30 * 3600 * 1000;
    if (
      now >= nextPatternSwitchTime ||
      timeSinceLastSwitch > forceSwitchDuration
    ) {
      switchKLinePattern("随机时间", targetPrice, cycleProgress);
    }

    // ============================================================
    // 计算当前K线模型内的进度
    // ============================================================
    const patternDuration =
      nextPatternSwitchTime.getTime() - lastPatternSwitchTime.getTime();
    const patternElapsed = now.getTime() - lastPatternSwitchTime.getTime();
    const patternProgress = Math.max(
      0,
      Math.min(1, patternElapsed / patternDuration),
    );

    // ============================================================
    // 1. K线模型驱动价格变化（主要动力）
    // ============================================================
    const pattern = kLinePatterns[currentPattern];
    if (!pattern) {
      logger.warn(`updatePrice: 未知的K线模型 ${currentPattern}`);
      return;
    }

    const patternValue = pattern.fn(patternProgress);
    const prevPatternValue = pattern.fn(Math.max(0, patternProgress - 0.02));
    const patternDelta = patternValue - prevPatternValue;

    const deviation = (targetPrice - currentPrice) / currentPrice;
    const deviationMultiplier = 1 + Math.abs(deviation) * 2;
    const patternReturn = patternDelta * 0.15 * deviationMultiplier;

    // ============================================================
    // 2. 期望回归项（向目标价格靠拢）
    // ============================================================
    const trackPrice = basePrice + (targetPrice - basePrice) * cycleProgress;
    const trackDeviation = (trackPrice - currentPrice) / currentPrice;
    const endPhaseBoost =
      cycleProgress > 0.8 ? ((cycleProgress - 0.8) / 0.2) * 0.05 : 0;
    const reversionStrength = 0.02 + endPhaseBoost;
    const reversionReturn = trackDeviation * reversionStrength;

    // ============================================================
    // 3. 随机波动项（增加真实感）
    // ============================================================
    const u1 = Math.random();
    const u2 = Math.random();
    const normalRandom =
      Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const dayStart = new Date(now);
    dayStart.setHours(config.openHour, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(config.closeHour, 0, 0, 0);
    const dayDuration = dayEnd.getTime() - dayStart.getTime();
    const dayElapsed = now.getTime() - dayStart.getTime();
    const dayProgress = Math.max(0, Math.min(1, dayElapsed / dayDuration));

    const morningVol = Math.exp(-8 * dayProgress);
    const afternoonVol = Math.exp(-8 * (1 - dayProgress));
    const volatility = 0.3 + morningVol * 0.5 + afternoonVol * 0.4;
    // 提升随机扰动强度，让实时曲线更有呼吸感
    const randomReturn = normalRandom * 0.0065 * volatility;

    // ============================================================
    // 4. 合成总收益率
    // ============================================================
    const totalReturn = patternReturn + reversionReturn + randomReturn;

    // ============================================================
    // 5. 计算新价格并应用限幅
    // ============================================================
    let newPrice = currentPrice * (1 + totalReturn);

    const dayBase = dailyOpenPrice ?? basePrice;
    const weekUpper = basePrice * 1.5;
    const weekLower = basePrice * 0.5;
    const dayUpper = dayBase * 1.3;
    const dayLower = dayBase * 0.7;

    const upperLimit = Math.min(weekUpper, dayUpper);
    const lowerLimit = Math.max(weekLower, dayLower);

    if (newPrice > upperLimit * 0.95) {
      const overshoot = (newPrice - upperLimit * 0.95) / (upperLimit * 0.05);
      newPrice = upperLimit * 0.95 + upperLimit * 0.05 * Math.tanh(overshoot);
    }
    if (newPrice < lowerLimit * 1.05) {
      const undershoot = (lowerLimit * 1.05 - newPrice) / (lowerLimit * 0.05);
      newPrice = lowerLimit * 1.05 - lowerLimit * 0.05 * Math.tanh(undershoot);
    }

    newPrice = Math.max(lowerLimit, Math.min(upperLimit, newPrice));
    if (newPrice < 1) newPrice = 1;

    newPrice = fmtPrice(newPrice);
    currentPrice = newPrice;
    await ctx.database.create("bourse_history", {
      stockId,
      price: newPrice,
      time: new Date(),
    });
  }

  // --- 交易处理逻辑 ---

  async function processPendingTransactions() {
    const now = new Date();
    const pending = await ctx.database.get("bourse_pending", {
      endTime: { $lte: now },
    });

    for (const txn of pending) {
      if (txn.type === "buy") {
        // 买入解冻：增加持仓和总成本
        const holding = await ctx.database.get("bourse_holding", {
          userId: txn.userId,
          stockId,
        });
        if (holding.length === 0) {
          await ctx.database.create("bourse_holding", {
            userId: txn.userId,
            uid: txn.uid,
            stockId,
            amount: txn.amount,
            totalCost: fmtAmount(txn.cost),
          });
        } else {
          // 兼容旧版本数据：totalCost 可能为 undefined 或 null 或 0
          // 关键修复：如果旧数据没有成本记录，用【交易时的单价】估算旧持仓成本
          // 这样新旧数据合并时不会造成成本稀释
          let existingCost = holding[0].totalCost;
          if (!existingCost || existingCost <= 0) {
            // 用交易时的单价估算旧持仓成本（比用当前市价更准确，因为交易时价格更接近用户买入时的价格）
            existingCost = fmtAmount(holding[0].amount * txn.price);
            logger.info(
              `processPendingTransactions: 旧持仓无成本记录，使用交易价格估算: ${holding[0].amount}股 * ${txn.price} = ${existingCost}`,
            );
          }
          const newTotalCost = fmtAmount(existingCost + txn.cost);
          await ctx.database.set(
            "bourse_holding",
            { userId: txn.userId, stockId },
            {
              amount: holding[0].amount + txn.amount,
              totalCost: newTotalCost,
              uid: txn.uid, // 确保 uid 始终是最新的
            },
          );
        }
      } else if (txn.type === "sell") {
        // 卖出解冻：增加现金
        // 使用存储的数字uid（注意：uid=0 是有效值）
        if (
          txn.uid !== undefined &&
          txn.uid !== null &&
          typeof txn.uid === "number" &&
          !Number.isNaN(txn.uid)
        ) {
          const amount = fmtAmount(txn.cost);
          const success = await changeCashBalance(
            txn.uid,
            config.currency,
            amount,
          );
          if (!success) {
            logger.error(
              `processPendingTransactions 失败: 卖出结算充值失败 txn.id=${txn.id}, uid=${txn.uid}, amount=${amount}`,
            );
          }
        } else {
          logger.warn(
            `processPendingTransactions 警告: 卖出订单缺少有效uid, txn.id=${txn.id}`,
          );
        }
      }
      await ctx.database.remove("bourse_pending", { id: txn.id });
    }
  }

  // --- 分红除息引擎 ---

  async function checkAndExecuteDividend() {
    const now = __testNow ?? new Date();

    // 获取宏观状态
    let state = (
      await ctx.database.get("bourse_state", { key: "macro_state" })
    )[0];

    // Rule 1: 时间校验
    if (state && state.lastDividendDate) {
      const lastDate = new Date(state.lastDividendDate);
      const elapsed = now.getTime() - lastDate.getTime();
      const intervalMs = config.dividendIntervalDays * 24 * 3600 * 1000;
      if (elapsed < intervalMs) return;
    } else {
      // 首次运行：初始化分红时间戳，等待第一个周期
      if (!state) {
        await ctx.database.create("bourse_state", {
          key: "macro_state",
          lastCycleStart: new Date(Date.now() - 7 * 24 * 3600 * 1000),
          startPrice: currentPrice,
          targetPrice: currentPrice,
          trendFactor: 0,
          mode: "auto",
          endTime: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          lastDividendDate: now,
        });
      } else {
        await ctx.database.set(
          "bourse_state",
          { key: "macro_state" },
          { lastDividendDate: now },
        );
      }
      logger.info("分红引擎: 首次初始化，将在下个周期执行首次分红");
      return;
    }

    // Rule 2: 数据聚合与防零除
    const allHoldings = await ctx.database.get("bourse_holding", {});
    const totalHoldings = allHoldings.reduce((sum, h) => sum + h.amount, 0);
    if (allHoldings.length === 0 || totalHoldings === 0) {
      await ctx.database.set(
        "bourse_state",
        { key: "macro_state" },
        { lastDividendDate: now },
      );
      logger.info("分红引擎: 无持仓记录，跳过本次分红");
      return;
    }

    // 计算 EDPR（分红期望利润率）
    const totalMarketValue = fmtAmount(totalHoldings * currentPrice);
    const totalCost = fmtAmount(
      allHoldings.reduce((sum, h) => sum + (h.totalCost || 0), 0),
    );
    const totalProfit = fmtAmount(totalMarketValue - totalCost);
    const edpr = totalMarketValue > 0 ? totalProfit / totalMarketValue : 0;

    // Rule 3: 亏损不分红拦截
    if (edpr <= 0) {
      await ctx.database.set(
        "bourse_state",
        { key: "macro_state" },
        { lastDividendDate: now },
      );
      logger.info(
        `分红引擎: 大盘亏损（EDPR=${(edpr * 100).toFixed(2)}%），跳过本次分红`,
      );
      return;
    }

    // Rule 4 & 5: 不对称分红与除息
    const priceDropRate = edpr; // 股价跌幅=EDPR（全量）
    const effectiveDividendRate = Math.min(edpr, config.maxDividendRate); // 派息率=min(EDPR, 上限)

    logger.info(
      `分红引擎: 开始执行分红 | EDPR=${(edpr * 100).toFixed(2)}% | ` +
        `除息跌幅=${(priceDropRate * 100).toFixed(2)}% | ` +
        `实际派息率=${(effectiveDividendRate * 100).toFixed(2)}% | ` +
        `持仓人数=${allHoldings.length} | 总股数=${totalHoldings}`,
    );

    // 派发资金给每个持仓用户
    let totalDividendPaid = 0;
    let successCount = 0;
    let failCount = 0;
    const successRecords: { userId: string; amount: number }[] = [];
    for (const holding of allHoldings) {
      const dividendAmount = fmtAmount(
        holding.amount * effectiveDividendRate * currentPrice,
      );
      if (dividendAmount <= 0) continue;

      if (!holding.uid) {
        logger.warn(
          `分红引擎: 用户 ${holding.userId} 缺少 uid，无法派发分红 ${dividendAmount.toFixed(2)}`,
        );
        failCount++;
        continue;
      }

      const success = await changeCashBalance(
        holding.uid,
        config.currency,
        dividendAmount,
      );
      if (success) {
        totalDividendPaid += dividendAmount;
        successCount++;
        successRecords.push({ userId: holding.userId, amount: dividendAmount });
      } else {
        logger.warn(
          `分红引擎: 用户 ${holding.userId} (uid=${holding.uid}) 分红派发失败`,
        );
        failCount++;
      }
    }

    if (
      config.dividendBroadcastChannels &&
      config.dividendBroadcastChannels.length > 0 &&
      successCount > 0
    ) {
      const summary =
        `【分红播报】参与人数: ${successCount} | ` +
        `派息率: ${(effectiveDividendRate * 100).toFixed(2)}% | ` +
        `总派息: ${totalDividendPaid.toFixed(2)} ${config.currency}`;
      await sendBroadcast(
        config.dividendBroadcastChannels,
        summary,
        "分红播报",
      );

      const detailLines = successRecords.map((record) => {
        const ratio =
          totalDividendPaid > 0
            ? (record.amount / totalDividendPaid) * 100
            : 0;
        return `- ${record.userId}：占比 ${ratio.toFixed(2)}% | ${record.amount.toFixed(2)} ${config.currency}`;
      });

      for (const chunk of chunkLines("【分红明细】", detailLines, 10)) {
        await sendBroadcast(
          config.dividendBroadcastChannels,
          chunk,
          "分红明细",
        );
      }
    }

    // 除息降价
    const oldPrice = currentPrice;
    currentPrice = fmtPrice(currentPrice * (1 - priceDropRate));
    if (currentPrice < 1) currentPrice = 1;

    // 写入除息行情记录
    await ctx.database.create("bourse_history", {
      stockId,
      price: currentPrice,
      time: now,
    });

    // 重置宏观状态：覆盖 startPrice 为目标价格重新计算提供正确基准
    const fluctuation = 0.25;
    const targetRatio = 1 + (Math.random() * 2 - 1) * fluctuation;
    let newTargetPrice = currentPrice * targetRatio;
    newTargetPrice = Math.max(
      currentPrice * 0.5,
      Math.min(currentPrice * 1.5, newTargetPrice),
    );

    let newEndTime: Date;
    if (config.fixedUpdateTime) {
      newEndTime = new Date(now);
      newEndTime.setHours(config.fixedUpdateHour, 0, 0, 0);
      if (newEndTime <= now) newEndTime.setDate(newEndTime.getDate() + 1);
    } else {
      newEndTime = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    }

    await ctx.database.set(
      "bourse_state",
      { key: "macro_state" },
      {
        startPrice: currentPrice,
        targetPrice: fmtPrice(newTargetPrice),
        lastCycleStart: now,
        endTime: newEndTime,
        lastDividendDate: now,
      },
    );

    // 切换 K 线走势
    switchKLinePattern("分红除息");

    logger.info(
      `分红引擎: 执行完毕 | 除息前股价=${oldPrice} -> 除息后=${currentPrice} ` +
        `(${(-priceDropRate * 100).toFixed(2)}%) | ` +
        `派发成功=${successCount}人 | 失败=${failCount}人 | ` +
        `合计派发=${totalDividendPaid.toFixed(2)} ${config.currency}`,
    );
  }

  // 统一获取价格历史，便于渲染成交/挂单回单
  async function getPriceHistory(limit = 100) {
    const historyData = await ctx.database.get(
      "bourse_history",
      {
        stockId,
      },
      {
        sort: { time: "desc" },
        limit,
      },
    );

    return historyData.reverse().map((h) => ({
      time: new Date(h.time).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      price: h.price,
      timestamp: new Date(h.time).getTime(),
    }));
  }

  // --- 命令定义 ---
  const getCurrentPrice = () => currentPrice;
  const getDailyOpenPrice = () => dailyOpenPrice;
  const setWasMarketOpen = (value: boolean) => {
    wasMarketOpen = value;
  };
  const setTestNow = (value: Date | null) => {
    __testNow = value;
  };

  registerStockCommands({
    ctx,
    config,
    logger,
    stockId,
    getCurrentPrice,
    fmtPrice,
    fmtAmount,
    isMarketOpen,
    getPriceHistory,
    processPendingTransactions,
    renderStockImage,
    renderTradeResultImage,
    renderHoldingImage,
    pay,
  });

  registerAdminCommands({
    ctx,
    config,
    logger,
    getCurrentPrice,
    getDailyOpenPrice,
    setWasMarketOpen,
    isMarketOpen,
    switchKLinePattern,
    broadcastMacroNews,
  });

  registerTestCommands({
    ctx,
    config,
    logger,
    getCurrentPrice,
    setTestNow,
    updatePrice,
    getDailyOpenPrice,
  });
}
