import { readFileSync } from "fs";
import { Context, h, Logger } from "koishi";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { promises as fs } from "fs";

const templatesDir = resolve(__dirname, "templates");
const assetsDir = resolve(__dirname, "..", "assets");
const assetsBaseUrl = pathToFileURL(assetsDir).toString().replace(/\/$/, "");
const iconMap: Record<string, string> = {
  stock: "icons/stock.svg",
  user: "icons/user.svg",
  empty: "icons/empty.svg",
  clock: "icons/clock.svg",
  trendUp: "icons/trend-up.svg",
  trendDown: "icons/trend-down.svg",
};
const iconDataUrls: Record<string, string> = {};

function getAssetUrl(relativePath: string): string {
  return `${assetsBaseUrl}/${relativePath}`;
}

for (const [key, relativePath] of Object.entries(iconMap)) {
  try {
    const absolutePath = resolve(assetsDir, relativePath);
    const buffer = readFileSync(absolutePath);
    iconDataUrls[key] = `data:image/svg+xml;base64,${buffer.toString("base64")}`;
  } catch {
    iconDataUrls[key] = getAssetUrl(relativePath);
  }
}

function getFontFaceCss(): string {
  const fontRegularUrl = getAssetUrl("fonts/RobotoMono-Regular.ttf");
  const fontBoldUrl = getAssetUrl("fonts/RobotoMono-Bold.ttf");

  return `
    @font-face {
      font-family: 'Roboto Mono';
      src: url('${fontRegularUrl}') format('truetype');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }

    @font-face {
      font-family: 'Roboto Mono';
      src: url('${fontBoldUrl}') format('truetype');
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
  `;
}

function injectFontFace(template: string): string {
  return template.replace("{{FONT_FACE}}", getFontFaceCss());
}

function getIconUrl(iconName: keyof typeof iconMap): string {
  return iconDataUrls[iconName] || "";
}

function replaceTemplateTokens(
  template: string,
  replacements: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(key, "g"), () => value);
  }
  return result;
}

export function injectStaticAssets(template: string): string {
  return replaceTemplateTokens(injectFontFace(template), {
    "{{ICON_STOCK}}": getIconUrl("stock"),
    "{{ICON_USER}}": getIconUrl("user"),
    "{{ICON_EMPTY}}": getIconUrl("empty"),
    "{{ICON_CLOCK}}": getIconUrl("clock"),
    "{{ICON_TREND_UP}}": getIconUrl("trendUp"),
    "{{ICON_TREND_DOWN}}": getIconUrl("trendDown"),
  });
}

export type PricePoint = {
  time: string;
  price: number;
  timestamp: number;
};

export type KLineOptions = {
  bucketMs: number;
  candleCount?: number;
  endTimestamp?: number;
  includeEmpty?: boolean;
};

type KLineCandle = {
  time: string;
  timeKey: string;
  start: number;
  max: number;
  min: number;
  end: number;
  timestamp: number;
};

export async function renderHoldingImage(
  ctx: Context,
  logger: Logger,
  username: string,
  holding: {
    stockName: string;
    amount: number;
    currentPrice: number;
    avgCost: number | null;
    totalCost: number | null;
    marketValue: number;
    profit: number | null;
    profitPercent: number | null;
  } | null,
  pending: {
    type: string;
    typeClass: string;
    amount: number;
    price: number;
    cost: number;
    timeLeft: string;
  }[],
  currency: string,
) {
  try {
    const templatePath = resolve(templatesDir, "holding-card.html");
    let template = await fs.readFile(templatePath, "utf-8");
    template = injectStaticAssets(template);

    const data = {
      username,
      holding,
      pending,
      currency,
      updateTime: new Date().toLocaleString("zh-CN"),
    };

    template = template.replace("{{DATA}}", JSON.stringify(data));

    const page = await ctx.puppeteer.page();
    try {
      await page.setContent(template);
      const element = await page.$(".card");
      if (!element) throw new Error("找不到 .card 元素");
      const imgBuf = await element.screenshot({ encoding: "binary" });
      return h.image(imgBuf, "image/png");
    } finally {
      await page.close();
    }
  } catch (err) {
    logger.error("renderHoldingImage 失败:", err);
    return `[错误] 生成图片失败: ${err.message}`;
  }
}

export async function renderTradeResultImage(
  ctx: Context,
  logger: Logger,
  tradeType: "buy" | "sell",
  stockName: string,
  amount: number,
  tradePrice: number,
  totalCost: number,
  currency: string,
  priceHistory: PricePoint[],
  sellInfo?: {
    avgBuyPrice: number | null;
    buyCost: number | null;
    profit: number | null;
    profitPercent: number | null;
    fee: number | null;
    feePercent: number | null;
  },
  newHolding?: number,
  tradeMeta?: {
    status?: "pending" | "settled";
    pendingMinutes?: number;
    pendingEndTime?: string | null;
  },
) {
  try {
    const templatePath = resolve(templatesDir, "trade-result.html");
    let template = await fs.readFile(templatePath, "utf-8");
    template = injectStaticAssets(template);

    const tradeIndex = priceHistory.length - 1;
    const status = tradeMeta?.status ?? "settled";
    const pendingMinutes = tradeMeta?.pendingMinutes ?? 0;
    const pendingEndTime = tradeMeta?.pendingEndTime ?? null;

    const data = {
      tradeType,
      stockName,
      amount,
      tradePrice,
      totalCost,
      currency,
      tradeTime: new Date().toLocaleString("zh-CN"),
      prices: priceHistory.map((d) => d.price),
      timestamps: priceHistory.map((d) => d.timestamp),
      tradeIndex,
      avgBuyPrice: sellInfo?.avgBuyPrice ?? null,
      buyCost: sellInfo?.buyCost ?? null,
      profit: sellInfo?.profit ?? null,
      profitPercent: sellInfo?.profitPercent ?? null,
      fee: sellInfo?.fee ?? null,
      feePercent: sellInfo?.feePercent ?? null,
      newHolding: newHolding ?? amount,
      status,
      pendingMinutes,
      pendingEndTime,
    };

    template = template.replace("{{DATA}}", JSON.stringify(data));

    const page = await ctx.puppeteer.page();
    try {
      await page.setContent(template);
      const element = await page.$(".card");
      if (!element) throw new Error("找不到 .card 元素");
      const imgBuf = await element.screenshot({ encoding: "binary" });
      return h.image(imgBuf, "image/png");
    } finally {
      await page.close();
    }
  } catch (err) {
    logger.error("renderTradeResultImage 失败:", err);
    return `[错误] 生成交易确认单失败: ${err.message}`;
  }
}

export async function renderStockImage(
  ctx: Context,
  logger: Logger,
  data: PricePoint[],
  name: string,
  viewLabel: string,
  current: number,
  high: number,
  low: number,
  chartType: "line" | "kline" = "line",
  klineOptions?: KLineOptions,
) {
  if (data.length < 2) {
    logger.warn(`renderStockImage: 数据点不足(${data.length})，无法绘制图表`);
    return "数据不足，无法绘制走势图。";
  }
  try {
    const startPrice = data[0].price;
    const change = current - startPrice;
    const changePercent = (change / startPrice) * 100;
    const isUp = change >= 0;
    const klineData =
      chartType === "kline"
        ? buildKLineData(data, {
            bucketMs: klineOptions?.bucketMs ?? 2 * 3600 * 1000,
            candleCount: klineOptions?.candleCount,
            endTimestamp: klineOptions?.endTimestamp,
            includeEmpty: klineOptions?.includeEmpty,
          })
        : [];

    const templatePath = resolve(templatesDir, "stock-chart.html");
    let html = await fs.readFile(templatePath, "utf-8");
    html = injectStaticAssets(html);

    const colorScheme = {
      mainColor: isUp ? "#f23645" : "#089981",
      gradientStart: isUp
        ? "rgba(242, 54, 69, 0.25)"
        : "rgba(8, 153, 129, 0.25)",
      gradientEnd: "rgba(255, 255, 255, 0)",
      glowColor: isUp ? "rgba(242, 54, 69, 0.4)" : "rgba(8, 153, 129, 0.4)",
      iconGradientStart: isUp ? "#f23645" : "#089981",
      iconGradientEnd: isUp ? "#ff7e87" : "#40c2aa",
      iconShadow: isUp ? "rgba(242, 54, 69, 0.3)" : "rgba(8, 153, 129, 0.3)",
      changeBadgeBg: isUp
        ? "rgba(242, 54, 69, 0.12)"
        : "rgba(8, 153, 129, 0.12)",
    };

    const replacements: Record<string, string> = {
      "{{MAIN_COLOR}}": colorScheme.mainColor,
      "{{GRADIENT_START}}": colorScheme.gradientStart,
      "{{GRADIENT_END}}": colorScheme.gradientEnd,
      "{{GLOW_COLOR}}": colorScheme.glowColor,
      "{{ICON_GRADIENT_START}}": colorScheme.iconGradientStart,
      "{{ICON_GRADIENT_END}}": colorScheme.iconGradientEnd,
      "{{ICON_SHADOW}}": colorScheme.iconShadow,
      "{{CHANGE_BADGE_BG}}": colorScheme.changeBadgeBg,
      "{{STOCK_NAME}}": name,
      "{{VIEW_LABEL}}": viewLabel,
      "{{CURRENT_TIME}}": new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      "{{CURRENT_PRICE}}": current.toFixed(2),
      "{{CHANGE_VALUE}}": `${change >= 0 ? "+" : ""}${change.toFixed(2)}`,
      "{{CHANGE_ICON}}": change >= 0 ? getIconUrl("trendUp") : getIconUrl("trendDown"),
      "{{CHANGE_PERCENT}}": Math.abs(changePercent).toFixed(2),
      "{{CHART_TYPE}}": chartType,
      "{{HIGH_PRICE}}": high.toFixed(2),
      "{{LOW_PRICE}}": low.toFixed(2),
      "{{AMPLITUDE}}": (((high - low) / startPrice) * 100).toFixed(2),
      "{{START_PRICE}}": startPrice.toFixed(2),
      "{{UPDATE_TIME}}": new Date().toLocaleString("zh-CN"),
      "{{PRICES}}": JSON.stringify(data.map((d) => d.price)),
      "{{TIMES}}": JSON.stringify(data.map((d) => d.time)),
      "{{TIMESTAMPS}}": JSON.stringify(data.map((d) => d.timestamp)),
      "{{KLINE_DATA}}": JSON.stringify(klineData),
      "{{G2_SCRIPT}}": "",
    };

    html = replaceTemplateTokens(html, replacements);

    const page = await ctx.puppeteer.page();
    try {
      await page.setContent(html);
      await page.waitForFunction(
        () => {
          const element = document.querySelector(".chart-ready");
          return Boolean(element);
        },
        { timeout: 10000 },
      );
      const element = await page.$(".card");
      if (!element) throw new Error("找不到 .card 元素");
      const imgBuf = await element.screenshot({ encoding: "binary" });
      return h.image(imgBuf, "image/png");
    } finally {
      await page.close();
    }
  } catch (err) {
    logger.error("renderStockImage 失败:", err);
    return `[错误] 生成行情图失败: ${err.message}`;
  }
}

export function buildKLineData(
  data: PricePoint[],
  options: KLineOptions,
): KLineCandle[] {
  if (data.length === 0) return [];
  const bucketMs = options.bucketMs;
  const candleCount = options.candleCount ?? 12;
  const includeEmpty = options.includeEmpty ?? true;
  if (bucketMs <= 0 || candleCount <= 0) return [];

  const sorted = data
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const endTs = options.endTimestamp ?? sorted[sorted.length - 1].timestamp;
  const startTs = endTs - bucketMs * candleCount;

  const buckets: PricePoint[][] = Array.from({ length: candleCount }, () => []);
  for (const point of sorted) {
    if (point.timestamp < startTs || point.timestamp > endTs) continue;
    const rawIndex = Math.floor((point.timestamp - startTs) / bucketMs);
    const index = Math.min(candleCount - 1, Math.max(0, rawIndex));
    buckets[index].push(point);
  }

  const candles: KLineCandle[] = [];
  let lastClose = sorted[0].price;

  for (let i = 0; i < candleCount; i++) {
    const bucket = buckets[i];
    const bucketEnd = startTs + (i + 1) * bucketMs;
    const endDate = new Date(bucketEnd);

    if (bucket.length === 0) {
      if (!includeEmpty) continue;
      const lastPrice = Number(lastClose.toFixed(2));
      candles.push({
        time: formatKLineTime(endDate),
        timeKey: endDate.toISOString(),
        start: lastPrice,
        max: lastPrice,
        min: lastPrice,
        end: lastPrice,
        timestamp: bucketEnd,
      });
      continue;
    }

    const prices = bucket.map((d) => d.price);
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    lastClose = last.price;
    candles.push({
      time: formatKLineTime(endDate),
      timeKey: endDate.toISOString(),
      start: Number(first.price.toFixed(2)),
      max: Number(Math.max(...prices).toFixed(2)),
      min: Number(Math.min(...prices).toFixed(2)),
      end: Number(last.price.toFixed(2)),
      timestamp: bucketEnd,
    });
  }

  return candles;
}

function formatKLineTime(date: Date) {
  return `${date.getMonth() + 1}-${date.getDate()} ${date
    .getHours()
    .toString()
    .padStart(2, "0")}:00`;
}
