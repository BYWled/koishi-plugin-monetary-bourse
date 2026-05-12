export type HoldingRecord = {
  amount: number;
  totalCost?: number | null;
};

export type PendingRecord = {
  type: "buy" | "sell";
  amount: number;
  price: number;
  cost: number;
  buyCost?: number | null;
};

export type HoldingSummary = {
  amount: number;
  marketValue: number;
  totalCost: number | null;
  avgCost: number | null;
  profit: number | null;
  profitPercent: number | null;
  hasCostData: boolean;
};

export function buildHoldingSummary(input: {
  currentPrice: number;
  holding: HoldingRecord | null;
  pending: PendingRecord[];
}): HoldingSummary | null {
  const holdingAmount = input.holding?.amount ?? 0;
  const pendingBuys = input.pending.filter((p) => p.type === "buy");
  const pendingSells = input.pending.filter((p) => p.type === "sell");

  const pendingBuyAmount = pendingBuys.reduce((sum, p) => sum + p.amount, 0);
  const pendingSellAmount = pendingSells.reduce((sum, p) => sum + p.amount, 0);
  const totalAmount = holdingAmount + pendingBuyAmount + pendingSellAmount;
  if (totalAmount <= 0) return null;

  const holdingValue = holdingAmount * input.currentPrice;
  const pendingBuyValue = pendingBuyAmount * input.currentPrice;
  const pendingSellValue = pendingSells.reduce(
    (sum, p) => sum + p.amount * p.price,
    0,
  );
  const marketValue = holdingValue + pendingBuyValue + pendingSellValue;

  let hasCostData = true;
  let totalCost = 0;

  if (holdingAmount > 0) {
    const holdingCost = input.holding?.totalCost ?? null;
    if (!holdingCost || holdingCost <= 0) {
      hasCostData = false;
    } else {
      totalCost += holdingCost;
    }
  }

  for (const pending of pendingBuys) {
    if (!pending.cost || pending.cost <= 0) hasCostData = false;
    else totalCost += pending.cost;
  }

  for (const pending of pendingSells) {
    if (!pending.buyCost || pending.buyCost <= 0) hasCostData = false;
    else totalCost += pending.buyCost;
  }

  if (!hasCostData) {
    return {
      amount: totalAmount,
      marketValue,
      totalCost: null,
      avgCost: null,
      profit: null,
      profitPercent: null,
      hasCostData: false,
    };
  }

  const avgCost = totalCost / totalAmount;
  const profit = marketValue - totalCost;
  const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  return {
    amount: totalAmount,
    marketValue,
    totalCost,
    avgCost,
    profit,
    profitPercent,
    hasCostData: true,
  };
}
