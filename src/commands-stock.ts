import type { Context, Logger } from "koishi";
import type { BourseHistory, Config, SellFeeTier } from "./index";
import type { KLineOptions, PricePoint } from "./render";
import { buildHoldingSummary } from "./utils/holding-summary";

type RenderStockImage = typeof import("./render").renderStockImage;
type RenderTradeResultImage = typeof import("./render").renderTradeResultImage;
type RenderHoldingImage = typeof import("./render").renderHoldingImage;

function resolveSellFeePercent(amount: number, tiers: SellFeeTier[]): number {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  const sorted = [...tiers].sort((a, b) => b.minAmount - a.minAmount);
  const matched = sorted.find((tier) => amount >= tier.minAmount);
  if (!matched) return 0;
  const percent = Number.isFinite(matched.feePercent) ? matched.feePercent : 0;
  return Math.min(100, Math.max(0, percent));
}

type StockCommandDeps = {
  ctx: Context;
  config: Config;
  logger: Logger;
  stockId: string;
  getCurrentPrice: () => number;
  fmtPrice: (value: number) => number;
  fmtAmount: (value: number) => number;
  isMarketOpen: () => Promise<boolean>;
  getPriceHistory: (limit?: number) => Promise<PricePoint[]>;
  processPendingTransactions: () => Promise<void>;
  renderStockImage: RenderStockImage;
  renderTradeResultImage: RenderTradeResultImage;
  renderHoldingImage: RenderHoldingImage;
  pay: (
    uid: number,
    cost: number,
    currency: string,
  ) => Promise<{ success: boolean; msg?: string }>;
};

export function registerStockCommands(deps: StockCommandDeps) {
  const {
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
  } = deps;

  ctx
    .command("stock [interval:string]", "查看股市行情")
    .userFields(["id"]) // 添加 userFields 确保 session.user 在转发子命令前已加载
    .action(async ({ session }, interval) => {
      // 修复：如果 interval 是子指令关键字，则手动转发（防止被当做参数捕获）
      if (["buy", "sell", "my"].includes(interval)) {
        const parts = session.content.trim().split(/\s+/).slice(2);
        const rest = parts.join(" ");
        return session.execute(`stock.${interval} ${rest}`);
      }

      const marketOpenNow = await isMarketOpen();
      if (!marketOpenNow && !["day", "week"].includes(interval))
        return (
          "股市目前休市中。（开放时间：工作日 " +
          config.openHour +
          ":00 - " +
          config.closeHour +
          ":00）"
        );

      let history: BourseHistory[];
      const now = new Date();
      let klineOptions: KLineOptions | undefined;
      let appendCurrent = true;

      if (interval === "day") {
        const todayOpen = new Date(now);
        todayOpen.setHours(config.openHour, 0, 0, 0);
        const isWeekend = now.getDay() === 0 || now.getDay() === 6;
        const hasMarketOpenToday =
          marketOpenNow || (!isWeekend && now >= todayOpen);
        const dayCandleCount = 12;

        if (hasMarketOpenToday) {
          history = await ctx.database.get(
            "bourse_history",
            { stockId, time: { $gte: todayOpen } },
            { sort: { time: "asc" } },
          );
          const rangeMs = Math.max(1, now.getTime() - todayOpen.getTime());
          const bucketMs = Math.max(1, Math.floor(rangeMs / dayCandleCount));
          klineOptions = {
            bucketMs,
            candleCount: dayCandleCount,
            endTimestamp: now.getTime(),
            includeEmpty: true,
          };
        } else {
          const fallbackCandleCount = 7;
          const fallbackBucketMs = 2 * 3600 * 1000;
          const fallbackLimit = 400;
          history = await ctx.database.get(
            "bourse_history",
            { stockId },
            { sort: { time: "desc" }, limit: fallbackLimit },
          );
          history = history.reverse();
          const endTimestamp = history.length
            ? new Date(history[history.length - 1].time).getTime()
            : now.getTime();
          const rangeStart = endTimestamp - fallbackBucketMs * fallbackCandleCount;
          history = history.filter((h) => {
            const ts = h.time.getTime();
            return ts >= rangeStart && ts <= endTimestamp;
          });
          klineOptions = {
            bucketMs: fallbackBucketMs,
            candleCount: fallbackCandleCount,
            endTimestamp,
            includeEmpty: false,
          };
          appendCurrent = false;
        }
      } else if (interval === "week") {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
        // Always align to market open for consistent week-over-week windows
        weekAgo.setHours(config.openHour, 0, 0, 0);
        history = await ctx.database.get(
          "bourse_history",
          { stockId, time: { $gte: weekAgo } },
          { sort: { time: "asc" } },
        );
        klineOptions = {
          bucketMs: 14 * 3600 * 1000,
          candleCount: 12,
          endTimestamp: now.getTime(),
          includeEmpty: true,
        };
      } else {
        // 默认实时（最近100条）
        history = await ctx.database.get(
          "bourse_history",
          { stockId },
          {
            limit: 100,
            sort: { time: "desc" },
          },
        );
        history = history.reverse();
      }

      if (history.length === 0) {
        logger.warn(`stock: 数据库中未找到 ${stockId} 的行情数据`);
        return "暂无行情数据。";
      }

      if (interval !== "day" && interval !== "week" && history.length > 300) {
        const step = Math.ceil(history.length / 300);
        history = history.filter((_, index) => index % step === 0);
      }

      const formattedData = history.map((h) => {
        let timeStr = h.time.toLocaleTimeString();
        if (interval === "week" || interval === "day") {
          timeStr = `${h.time.getMonth() + 1}-${h.time.getDate()} ${h.time.getHours()}:${h.time.getMinutes().toString().padStart(2, "0")}`;
        }
        return {
          time: timeStr,
          price: h.price,
          timestamp: h.time.getTime(),
        };
      });

      const currentPrice = getCurrentPrice();
      const lastHistoryPrice = formattedData[formattedData.length - 1]?.price;
      if (appendCurrent && lastHistoryPrice !== currentPrice) {
        const nowTime = new Date();
        let nowTimeStr = nowTime.toLocaleTimeString();
        if (interval === "week" || interval === "day") {
          nowTimeStr = `${nowTime.getMonth() + 1}-${nowTime.getDate()} ${nowTime.getHours()}:${nowTime.getMinutes().toString().padStart(2, "0")}`;
        }
        formattedData.push({
          time: nowTimeStr,
          price: currentPrice,
          timestamp: nowTime.getTime(),
        });
      }

      const high = Math.max(...formattedData.map((d) => d.price), currentPrice);
      const low = Math.min(...formattedData.map((d) => d.price), currentPrice);

      const viewLabel =
        interval === "week"
          ? "周走势"
          : interval === "day"
            ? "日走势"
            : "实时走势";
      const chartType =
        interval === "day" || interval === "week" ? "kline" : "line";

      const img = await renderStockImage(
        ctx,
        logger,
        formattedData,
        config.stockName,
        viewLabel,
        currentPrice,
        high,
        low,
        chartType,
        klineOptions,
      );
      return img;
    });

  ctx
    .command("stock.buy <amount:number>", "买入股票")
    .userFields(["id"])
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        logger.warn(
          `stock.buy: 非法买入数量 user=${session.userId}, amount=${amount}`,
        );
        return "请输入有效的购买股数（整数）。";
      }
      if (!(await isMarketOpen())) return "休市中，无法交易。";

      const visibleUserId = session.userId;

      if (
        !session.user ||
        session.user.id === undefined ||
        session.user.id === null
      ) {
        logger.error(
          `stock.buy: session.user 不存在或 id 为空 user=${session.userId}`,
        );
        return "无法获取用户ID，请稍后重试。";
      }

      const uid = session.user.id;
      if (typeof uid !== "number") {
        logger.error(
          `stock.buy: 无法获取数字UID user=${session.userId}, rawId=${uid}`,
        );
        return "无法获取用户ID，请稍后重试。";
      }

      const currentPrice = getCurrentPrice();
      const cost = fmtAmount(currentPrice * amount);

      const payResult = await pay(uid, cost, config.currency);
      if (!payResult.success) {
        logger.warn(
          `stock.buy: 支付失败 user=${session.userId}, amount=${amount}, cost=${cost}, reason=${payResult.msg}`,
        );
        return payResult.msg;
      }

      let freezeMinutes = 0;
      if (config.maxFreezeTime > 0) {
        freezeMinutes = cost / config.freezeCostPerMinute;
        if (freezeMinutes > config.maxFreezeTime)
          freezeMinutes = config.maxFreezeTime;
        if (freezeMinutes < config.minFreezeTime)
          freezeMinutes = config.minFreezeTime;
      }
      const freezeMs = freezeMinutes * 60 * 1000;

      const userPendingOrders = await ctx.database.get(
        "bourse_pending",
        { userId: visibleUserId, type: "buy" },
        { sort: { endTime: "desc" }, limit: 1 },
      );
      let startTime = new Date();
      if (userPendingOrders.length > 0) {
        const lastOrderEndTime = userPendingOrders[0].endTime;
        if (lastOrderEndTime > startTime) {
          startTime = lastOrderEndTime;
        }
      }
      const endTime = new Date(startTime.getTime() + freezeMs);

      await ctx.database.create("bourse_pending", {
        userId: visibleUserId,
        uid,
        stockId,
        type: "buy",
        amount,
        price: currentPrice,
        cost,
        startTime,
        endTime,
      });

      const tradeMeta =
        freezeMinutes === 0
          ? {
              status: "settled" as const,
              pendingMinutes: 0,
              pendingEndTime: null as string | null,
            }
          : {
              status: "pending" as const,
              pendingMinutes: freezeMinutes,
              pendingEndTime: endTime.toLocaleString("zh-CN"),
            };

      if (freezeMinutes === 0) {
        await processPendingTransactions();
        const priceHistory = await getPriceHistory();
        const newHoldingData = await ctx.database.get("bourse_holding", {
          userId: visibleUserId,
          stockId,
        });
        const newHoldingAmount =
          newHoldingData.length > 0 ? newHoldingData[0].amount : amount;

        return await renderTradeResultImage(
          ctx,
          logger,
          "buy",
          config.stockName,
          amount,
          currentPrice,
          cost,
          config.currency,
          priceHistory,
          undefined,
          newHoldingAmount,
          tradeMeta,
        );
      }

      const priceHistory = await getPriceHistory();
      const existingHolding = await ctx.database.get("bourse_holding", {
        userId: visibleUserId,
        stockId,
      });
      const projectedHolding =
        (existingHolding.length > 0 ? existingHolding[0].amount : 0) + amount;

      return await renderTradeResultImage(
        ctx,
        logger,
        "buy",
        config.stockName,
        amount,
        currentPrice,
        cost,
        config.currency,
        priceHistory,
        undefined,
        projectedHolding,
        tradeMeta,
      );
    });

  ctx
    .command("stock.sell <amount:number>", "卖出股票")
    .userFields(["id"])
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0 || !Number.isInteger(amount)) {
        logger.warn(
          `stock.sell: 非法卖出数量 user=${session.userId}, amount=${amount}`,
        );
        return "请输入有效的卖出股数。";
      }
      if (!(await isMarketOpen())) return "休市中，无法交易。";

      const visibleUserId = session.userId;

      if (
        !session.user ||
        session.user.id === undefined ||
        session.user.id === null
      ) {
        logger.error(
          `stock.sell: session.user 不存在或 id 为空 user=${session.userId}`,
        );
        return "无法获取用户ID，请稍后重试。";
      }

      const uid = session.user.id;
      if (typeof uid !== "number") {
        logger.error(
          `stock.buy: 无法获取数字UID user=${session.userId}, rawId=${uid}`,
        );
        return "无法获取用户ID，请稍后重试。";
      }

      const holding = await ctx.database.get("bourse_holding", {
        userId: visibleUserId,
        stockId,
      });

      if (holding.length === 0 || holding[0].amount < amount) {
        const currentAmount = holding.length ? holding[0].amount : 0;
        logger.warn(
          `stock.sell: 持仓不足 user=${session.userId}, amount=${amount}, current=${currentAmount}`,
        );
        return `持仓不足！当前持有: ${currentAmount} 股。`;
      }

      const currentPrice = getCurrentPrice();
      const currentHolding = holding[0];
      let existingTotalCost = currentHolding.totalCost;
      if (!existingTotalCost || existingTotalCost <= 0) {
        existingTotalCost = fmtAmount(currentHolding.amount * currentPrice);
        logger.info(
          `stock.sell: 旧持仓无成本记录，使用当前市价估算: ${currentHolding.amount}股 * ${currentPrice} = ${existingTotalCost}`,
        );
      }
      const avgCostPerShare = fmtPrice(
        existingTotalCost / currentHolding.amount,
      );
      const soldCost = fmtAmount(avgCostPerShare * amount);

      const newAmount = currentHolding.amount - amount;
      if (newAmount === 0) {
        await ctx.database.remove("bourse_holding", {
          userId: visibleUserId,
          stockId,
        });
      } else {
        const newTotalCost = fmtAmount(existingTotalCost - soldCost);
        await ctx.database.set(
          "bourse_holding",
          { userId: visibleUserId, stockId },
          {
            amount: newAmount,
            totalCost: Math.max(0, newTotalCost),
          },
        );
      }

      const gain = fmtAmount(currentPrice * amount);
      const feePercent = resolveSellFeePercent(amount, config.sellFeeTiers);
      const fee = feePercent > 0 ? fmtAmount((gain * feePercent) / 100) : 0;
      const netGain = fmtAmount(gain - fee);
      let freezeMinutes = 0;
      if (config.maxFreezeTime > 0) {
        freezeMinutes = netGain / config.freezeCostPerMinute;
        if (freezeMinutes > config.maxFreezeTime)
          freezeMinutes = config.maxFreezeTime;
        if (freezeMinutes < config.minFreezeTime)
          freezeMinutes = config.minFreezeTime;
      }
      const freezeMs = freezeMinutes * 60 * 1000;

      const userPendingOrders = await ctx.database.get(
        "bourse_pending",
        { userId: visibleUserId, type: "sell" },
        { sort: { endTime: "desc" }, limit: 1 },
      );
      let startTime = new Date();
      if (userPendingOrders.length > 0) {
        const lastOrderEndTime = userPendingOrders[0].endTime;
        if (lastOrderEndTime > startTime) {
          startTime = lastOrderEndTime;
        }
      }
      const endTime = new Date(startTime.getTime() + freezeMs);

      await ctx.database.create("bourse_pending", {
        userId: visibleUserId,
        uid,
        stockId,
        type: "sell",
        amount,
        price: currentPrice,
        cost: netGain,
        buyCost: soldCost,
        startTime,
        endTime,
      });

      const hasCostRecord = existingTotalCost > 0;
      const profit = hasCostRecord ? fmtAmount(netGain - soldCost) : null;
      const profitPercent =
        hasCostRecord && soldCost > 0
          ? Number(((profit / soldCost) * 100).toFixed(2))
          : null;

      const tradeMeta =
        freezeMinutes === 0
          ? {
              status: "settled" as const,
              pendingMinutes: 0,
              pendingEndTime: null as string | null,
            }
          : {
              status: "pending" as const,
              pendingMinutes: freezeMinutes,
              pendingEndTime: endTime.toLocaleString("zh-CN"),
            };

      if (freezeMinutes === 0) {
        await processPendingTransactions();
        const priceHistory = await getPriceHistory();

        return await renderTradeResultImage(
          ctx,
          logger,
          "sell",
          config.stockName,
          amount,
          currentPrice,
          gain,
          config.currency,
          priceHistory,
          {
            avgBuyPrice: hasCostRecord ? avgCostPerShare : null,
            buyCost: hasCostRecord ? soldCost : null,
            profit,
            profitPercent,
            fee: fee > 0 ? fee : null,
            feePercent: feePercent > 0 ? feePercent : null,
          },
          undefined,
          tradeMeta,
        );
      }

      const priceHistory = await getPriceHistory();

      return await renderTradeResultImage(
        ctx,
        logger,
        "sell",
        config.stockName,
        amount,
        currentPrice,
        gain,
        config.currency,
        priceHistory,
        {
          avgBuyPrice: hasCostRecord ? avgCostPerShare : null,
          buyCost: hasCostRecord ? soldCost : null,
          profit,
          profitPercent,
          fee: fee > 0 ? fee : null,
          feePercent: feePercent > 0 ? feePercent : null,
        },
        undefined,
        tradeMeta,
      );
    });

  ctx
    .command("stock.my", "我的持仓")
    .userFields(["id"])
    .action(async ({ session }) => {
      if (
        !session.user ||
        session.user.id === undefined ||
        session.user.id === null
      ) {
        logger.error(
          `stock.my: session.user 不存在或 id 为空 user=${session.userId}`,
        );
        return "无法获取用户ID，请稍后重试。";
      }

      const userId = session.userId;
      const holdings = await ctx.database.get("bourse_holding", { userId });
      const pending = await ctx.database.get("bourse_pending", { userId });

      let holdingData = null;
      const currentPrice = getCurrentPrice();
      const summary = buildHoldingSummary({
        currentPrice,
        holding: holdings.length
          ? { amount: holdings[0].amount, totalCost: holdings[0].totalCost }
          : null,
        pending: pending.map((p) => ({
          type: p.type,
          amount: p.amount,
          price: p.price,
          cost: p.cost,
          buyCost: p.buyCost ?? null,
        })),
      });

      if (summary) {
        holdingData = {
          stockName: config.stockName,
          amount: summary.amount,
          currentPrice: fmtPrice(currentPrice),
          avgCost: summary.hasCostData ? fmtPrice(summary.avgCost!) : null,
          totalCost: summary.hasCostData
            ? fmtAmount(summary.totalCost!)
            : null,
          marketValue: fmtAmount(summary.marketValue),
          profit: summary.hasCostData ? fmtAmount(summary.profit!) : null,
          profitPercent: summary.hasCostData
            ? Number(summary.profitPercent!.toFixed(2))
            : null,
        };
      }

      const pendingData = pending.map((p) => {
        const timeLeft = Math.max(
          0,
          Math.ceil((p.endTime.getTime() - Date.now()) / 1000),
        );
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        return {
          type: p.type === "buy" ? "买入" : "卖出",
          typeClass: p.type,
          amount: p.amount,
          price: fmtPrice(p.price),
          cost: fmtAmount(p.cost),
          timeLeft: `${minutes}分${seconds}秒`,
        };
      });

      const img = await renderHoldingImage(
        ctx,
        logger,
        session.username,
        holdingData,
        pendingData,
        config.currency,
      );
      return img;
    });
}
