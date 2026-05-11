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
}
