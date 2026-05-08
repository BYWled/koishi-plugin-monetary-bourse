import type { Context, Logger } from "koishi";
import type { Config } from "./index";

type TestCommandDeps = {
  ctx: Context;
  config: Config;
  logger: Logger;
  getCurrentPrice: () => number;
  setTestNow: (value: Date | null) => void;
  updatePrice: () => Promise<void>;
  getDailyOpenPrice: () => number | null;
};

export function registerTestCommands(deps: TestCommandDeps) {
  const {
    ctx,
    config,
    getCurrentPrice,
    setTestNow,
    updatePrice,
    getDailyOpenPrice,
  } = deps;

  ctx
    .command(
      "bourse.test.price [ticks:number]",
      "开发测试：推进价格更新若干次并返回当前价格",
      { authority: 3 },
    )
    .action(async ({ session }, ticks?) => {
      if (!config.enableDebug)
        return "调试模式未开启，请在插件配置中启用 enableDebug。";
      const n =
        typeof ticks === "number" && ticks > 0 ? Math.min(ticks, 500) : 1;
      const stepMs = 2 * 60 * 1000;
      const startNow = new Date();
      setTestNow(new Date(startNow));
      let minP = getCurrentPrice();
      let maxP = minP;
      for (let i = 0; i < n; i++) {
        await updatePrice();
        const price = getCurrentPrice();
        minP = Math.min(minP, price);
        maxP = Math.max(maxP, price);
        setTestNow(new Date(startNow.getTime() + (i + 1) * stepMs));
      }
      setTestNow(null);
      return `测试完成：推进${n}步（每步2分钟）\n当前价格：${Number(getCurrentPrice().toFixed(2))}\n区间最高：${Number(maxP.toFixed(2))} 最低：${Number(minP.toFixed(2))}`;
    });

  ctx
    .command(
      "bourse.test.run <ticks:number> [step:number]",
      "开发测试：按虚拟时间推进并统计价格分布",
      { authority: 3 },
    )
    .action(async ({ session }, ticks, step) => {
      if (!config.enableDebug)
        return "调试模式未开启，请在插件配置中启用 enableDebug。";
      const n = Math.max(1, Math.min(Number(ticks) || 1, 2000));
      const stepSec = Math.max(10, Math.min(Number(step) || 120, 3600));
      const stepMs = stepSec * 1000;
      const startPrice = getCurrentPrice();
      let minP = startPrice;
      let maxP = startPrice;
      let clampHits = 0;
      const startNow = new Date();
      setTestNow(new Date(startNow));
      for (let i = 0; i < n; i++) {
        await updatePrice();
        const after = getCurrentPrice();
        minP = Math.min(minP, after);
        maxP = Math.max(maxP, after);
        const baseStart =
          (await ctx.database.get("bourse_state", { key: "macro_state" }))[0]
            ?.startPrice ?? after;
        const dayBase = getDailyOpenPrice() ?? baseStart;
        const upper = Math.min(baseStart * 1.5, dayBase * 1.5);
        const lower = Math.max(baseStart * 0.5, dayBase * 0.5);
        if (after >= upper * 0.99 || after <= lower * 1.01) clampHits++;
        setTestNow(new Date(startNow.getTime() + (i + 1) * stepMs));
      }
      setTestNow(null);
      const drift = Number((getCurrentPrice() - startPrice).toFixed(2));
      return `内部测试\n步数：${n}；步长：${stepSec}s\n起始：${startPrice.toFixed(2)}；结束：${getCurrentPrice().toFixed(2)}（Δ=${drift}）\n最高：${maxP.toFixed(2)}；最低：${minP.toFixed(2)}\n接近限幅次数：${clampHits}`;
    });

  ctx
    .command(
      "bourse.test.manualThenAuto <target:number> [hours:number] [ticks:number]",
      "开发测试：手动周期后切回自动的连续性",
      { authority: 3 },
    )
    .action(async ({ session }, target, hours, ticks) => {
      if (!config.enableDebug)
        return "调试模式未开启，请在插件配置中启用 enableDebug。";
      const dur = Math.max(1, Math.min(Number(hours) || 6, 48));
      const n = Math.max(10, Math.min(Number(ticks) || 300, 5000));
      await session?.execute?.(`stock.control ${target} ${dur}`);
      const stepMs = 2 * 60 * 1000;
      const startNow = new Date();
      setTestNow(new Date(startNow));
      for (let i = 0; i < dur * 30; i++) {
        await updatePrice();
        setTestNow(new Date(startNow.getTime() + (i + 1) * stepMs));
      }
      const before = getCurrentPrice();
      for (let i = 0; i < n; i++) {
        await updatePrice();
        setTestNow(new Date(startNow.getTime() + (dur * 30 + i + 1) * stepMs));
      }
      const after = getCurrentPrice();
      setTestNow(null);
      const moved = Math.abs(after - before) >= 0.01;
      return `手动→自动 测试\n目标=${target}，期限=${dur}小时\n手动结束价：${before.toFixed(2)}；后续${n}步结束：${after.toFixed(2)}\n是否继续波动：${moved ? "是" : "否（需检查）"}`;
    });
}
