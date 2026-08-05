import type { Context, Logger } from "koishi";
import type { BourseState, Config } from "./index";

type AdminCommandDeps = {
  ctx: Context;
  config: Config;
  logger: Logger;
  getCurrentPrice: () => number;
  getDailyOpenPrice: () => number | null;
  setWasMarketOpen: (value: boolean) => void;
  isMarketOpen: () => Promise<boolean>;
  switchKLinePattern: (
    reason: string,
    expectedPrice?: number,
    cycleProgress?: number,
  ) => void;
  broadcastMacroNews: (targetPrice: number, basePrice: number) => Promise<void>;
};

export function registerAdminCommands(deps: AdminCommandDeps) {
  const {
    ctx,
    config,
    logger,
    getCurrentPrice,
    getDailyOpenPrice,
    setWasMarketOpen,
    isMarketOpen,
    switchKLinePattern,
    broadcastMacroNews,
  } = deps;

  ctx
    .command(
      "stock.control <price:number> [hours:number]",
      "管理员：设置宏观调控目标",
      { authority: 3 },
    )
    .action(async ({ session }, price, hours) => {
      if (!price || price <= 0) {
        logger.warn(
          `stock.control: 非法目标价格 user=${session.userId}, price=${price}`,
        );
        return "请输入有效的目标价格。";
      }
      const duration = hours || 24;

      const now = new Date();
      const endTime = new Date(now.getTime() + duration * 3600 * 1000);

      const currentPrice = getCurrentPrice();
      const baseStart = currentPrice;
      const dayBase = getDailyOpenPrice() ?? baseStart;
      const upper = Math.min(baseStart * 1.5, dayBase * 1.5);
      const lower = Math.max(baseStart * 0.5, dayBase * 0.5);
      const targetPriceClamped = Math.max(lower, Math.min(upper, price));

      const minutes = duration * 60;
      const trendFactor = (targetPriceClamped - currentPrice) / minutes;

      const newState: BourseState = {
        key: "macro_state",
        lastCycleStart: now,
        startPrice: currentPrice,
        targetPrice: targetPriceClamped,
        trendFactor,
        mode: "manual",
        endTime,
      };

      const existing = await ctx.database.get("bourse_state", {
        key: "macro_state",
      });
      if (existing.length === 0) {
        await ctx.database.create("bourse_state", newState);
      } else {
        const { key, ...updateFields } = newState;
        await ctx.database.set(
          "bourse_state",
          { key: "macro_state" },
          updateFields,
        );
      }

      // 若偏离度超过阈值，播报宏观新闻
      await broadcastMacroNews(targetPriceClamped, currentPrice);

      const hint =
        targetPriceClamped !== price
          ? `（已按±50%限幅从${price}调整为${Number(targetPriceClamped.toFixed(2))}）`
          : "";
      return `宏观调控已设置：\n目标价格：${Number(targetPriceClamped.toFixed(2))}${hint}\n期限：${duration}小时\n模式：手动干预\n到期后将自动切回随机调控。`;
    });

  ctx
    .command(
      "bourse.admin.market <status>",
      "设置股市开关状态 (open/close/auto)",
      { authority: 3 },
    )
    .action(async ({ session }, status) => {
      if (!["open", "close", "auto"].includes(status)) {
        logger.warn(
          `bourse.admin.market: 非法状态 user=${session.userId}, status=${status}`,
        );
        return "无效状态，请使用 open, close, 或 auto";
      }
      const wasOpen = await isMarketOpen();

      const key = "macro_state";
      const existing = await ctx.database.get("bourse_state", { key });
      if (existing.length === 0) {
        const now = new Date();
        await ctx.database.create("bourse_state", {
          key,
          lastCycleStart: now,
          startPrice: config.initialPrice,
          targetPrice: config.initialPrice,
          trendFactor: 0,
          mode: "auto",
          endTime: new Date(now.getTime() + 24 * 3600 * 1000),
          marketOpenStatus: status as "open" | "close" | "auto",
        });
      } else {
        await ctx.database.set(
          "bourse_state",
          { key },
          { marketOpenStatus: status as "open" | "close" | "auto" },
        );
      }

      if (status === "open" && !wasOpen) {
        switchKLinePattern("管理员开市");
        setWasMarketOpen(true);
      } else if (status === "close") {
        setWasMarketOpen(false);
      }

      return `股市状态已设置为: ${status}`;
    });

  ctx
    .command("stock.pattern", "管理员：强制切换K线模型", { authority: 3 })
    .action(() => {
      switchKLinePattern("管理员手动");
      return "已切换K线模型。";
    });

  ctx
    .command(
      "stock.circuit [action:string]",
      "管理员：查看或清除熔断状态",
      { authority: 3 },
    )
    .action(async ({ session }, action) => {
      const state = (
        await ctx.database.get("bourse_state", { key: "macro_state" })
      )[0];

      if (action === "clear" || action === "重置") {
        if (state?.circuitBreakerUntil) {
          await ctx.database.set(
            "bourse_state",
            { key: "macro_state" },
            { circuitBreakerUntil: null, circuitBreakerTriggerPrice: null },
          );
          logger.info(`管理员 ${session.userId} 手动清除了熔断状态`);
          return "熔断状态已清除，交易恢复正常。";
        }
        return "当前没有熔断状态。";
      }

      if (!config.circuitBreakerEnabled) {
        return "熔断机制未启用。请在配置中开启 circuitBreakerEnabled。";
      }

      const currentPrice = getCurrentPrice();
      const dailyOpen = getDailyOpenPrice();
      const dailyDrop =
        dailyOpen !== null
          ? ((dailyOpen - currentPrice) / dailyOpen) * 100
          : null;

      let status = "📊 熔断机制状态\n";
      status += `开关：已启用\n`;
      status += `触发阈值：日跌幅 ${(config.circuitBreakerThreshold * 100).toFixed(0)}%\n`;
      status += `持续时间：${config.circuitBreakerDuration} 分钟\n`;
      status += `后期望模式：${config.circuitBreakerExpectation}\n`;

      if (dailyDrop !== null) {
        status += `当前日跌幅：${dailyDrop.toFixed(2)}%\n`;
      }

      if (state?.circuitBreakerUntil) {
        const until = state.circuitBreakerUntil instanceof Date
          ? state.circuitBreakerUntil
          : new Date(state.circuitBreakerUntil);
        const now = new Date();
        if (now < until) {
          status += `⚠️ 熔断中！预计 ${until.toLocaleString("zh-CN")} 恢复\n`;
        } else {
          status += `状态：正常（熔断已过期）\n`;
        }
      } else {
        status += `状态：正常\n`;
      }

      status += `\n使用 stock.circuit clear 可手动清除熔断状态`;
      return status;
    });
}
