/**
 * Deterministic warehouse analysis.
 *
 * This replaces what used to be a language-model call. Every number below is derived from the
 * workspace's own ledger by arithmetic that can be restated in a sentence, which matters more here
 * than fluency: a stock recommendation nobody can audit is not much use, and an inventory brief is
 * a bad place for a model to fill a gap with something plausible.
 *
 * It also removes the API-key dependency entirely — the feature now works on any deployment.
 */

import {
  buildDemand,
  daysToStockout,
  formatRunway,
  suggestedQuantity,
  COVER_DAYS,
  DEMAND_WINDOW_DAYS,
  NO_DEMAND,
  RISK_DAYS,
  type Confidence,
  type DemandLeg,
} from "./replenishment";

const DAY_MS = 86_400_000;
/** Trend compares this many days against the equally long stretch before it. */
const TREND_DAYS = 14;
/** A product holding this share of its stock in one location is flagged as concentrated. */
const CONCENTRATION_SHARE = 0.9;

export type AnalysisProduct = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  reorder_point: number;
};

export type AnalysisLeg = DemandLeg & { location_id: string };

export type AnalysisInput = {
  warehouse: string;
  products: AnalysisProduct[];
  /** Balances already filtered to this warehouse's locations. */
  balances: { product_id: string; location_id: string; quantity: number }[];
  locations: { id: string; name: string }[];
  /** Ledger legs already filtered to this warehouse's locations. */
  legs: AnalysisLeg[];
  now?: Date;
};

export type Severity = "critical" | "warning" | "healthy";

export type Finding = {
  severity: Severity;
  title: string;
  detail: string;
  items?: string[];
};

export type ReorderLine = {
  sku: string;
  name: string;
  unit: string;
  onHand: number;
  runway: string;
  runwayDays: number | null;
  confidence: Confidence;
  confidenceReason: string;
  suggested: number;
};

export type WarehouseAnalysis = {
  warehouse: string;
  generatedAt: string;
  headline: { label: string; value: string }[];
  findings: Finding[];
  reorderPlan: ReorderLine[];
  method: string[];
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round = (n: number) => Math.round(n * 100) / 100;

/** Sums outbound (delivery) units in a window offset back from now. */
function outboundBetween(
  legs: AnalysisLeg[],
  now: number,
  fromDaysAgo: number,
  toDaysAgo: number,
): number {
  const from = now - fromDaysAgo * DAY_MS;
  const to = now - toDaysAgo * DAY_MS;
  return legs.reduce((sum, leg) => {
    if (leg.kind !== "delivery") return sum;
    const at = new Date(leg.created_at).getTime();
    if (at < from || at >= to) return sum;
    const qty = -Number(leg.delta);
    return qty > 0 ? sum + qty : sum;
  }, 0);
}

export function analyzeWarehouseStock(input: AnalysisInput): WarehouseAnalysis {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const demand = buildDemand(input.legs, now);

  const onHand = (productId: string) =>
    input.balances
      .filter((b) => b.product_id === productId)
      .reduce((sum, b) => sum + Number(b.quantity), 0);

  // Only products this warehouse actually handles. Without this, every product in the workspace
  // shows up as "out of stock" at every warehouse that has never carried it, which buries the real
  // findings under noise and would have a depot report two dozen phantom stockouts.
  const handled = new Set<string>([
    ...input.balances.map((b) => b.product_id),
    ...input.legs.map((l) => l.product_id),
  ]);
  const scoped = input.products.filter((p) => handled.has(p.id));

  const rows = scoped.map((product) => {
    const quantity = onHand(product.id);
    const productDemand = demand.get(product.id) ?? NO_DEMAND;
    const runwayDays = daysToStockout(quantity, productDemand.dailyDemand);
    return {
      product,
      quantity,
      demand: productDemand,
      runwayDays,
      suggested: suggestedQuantity(
        quantity,
        productDemand.dailyDemand,
        Number(product.reorder_point),
      ),
    };
  });

  const stocked = rows.filter((r) => r.quantity > 0);
  const outOfStock = rows.filter((r) => r.quantity === 0);
  const imminent = rows.filter((r) => r.quantity > 0 && r.runwayDays !== null && r.runwayDays <= 7);
  const soon = rows.filter(
    (r) => r.quantity > 0 && r.runwayDays !== null && r.runwayDays > 7 && r.runwayDays <= RISK_DAYS,
  );
  const belowThreshold = rows.filter(
    (r) => r.quantity > 0 && r.quantity <= Number(r.product.reorder_point),
  );
  // Below its threshold but with plenty of runway: the threshold, not the stock, is the problem.
  const thresholdNoise = belowThreshold.filter(
    (r) => r.runwayDays === null || r.runwayDays > RISK_DAYS * 2,
  );
  const dormant = rows.filter((r) => r.quantity > 0 && r.demand.totalDemand === 0);

  const outboundUnits = input.legs.reduce((sum, leg) => {
    if (leg.kind !== "delivery") return sum;
    const qty = -Number(leg.delta);
    return qty > 0 ? sum + qty : sum;
  }, 0);
  const shrinkage = input.legs.reduce((sum, leg) => {
    if (leg.kind !== "adjustment") return sum;
    const delta = Number(leg.delta);
    return delta < 0 ? sum + -delta : sum;
  }, 0);
  const totalUnits = rows.reduce((sum, r) => sum + r.quantity, 0);

  const recent = outboundBetween(input.legs, nowMs, TREND_DAYS, 0);
  const previous = outboundBetween(input.legs, nowMs, TREND_DAYS * 2, TREND_DAYS);
  const trendPct = previous > 0 ? Math.round(((recent - previous) / previous) * 100) : null;

  // --- Findings, most urgent first ------------------------------------------
  const findings: Finding[] = [];

  if (outOfStock.length) {
    findings.push({
      severity: "critical",
      title: `${plural(outOfStock.length, "product")} out of stock`,
      detail:
        "Nothing on hand at this warehouse. Any order for these cannot be fulfilled from here.",
      items: outOfStock.map((r) => `${r.product.name} (${r.product.sku})`),
    });
  }

  if (imminent.length) {
    findings.push({
      severity: "critical",
      title: `${plural(imminent.length, "product")} within 7 days of stockout`,
      detail: `At the outbound rate of the last ${DEMAND_WINDOW_DAYS} days.`,
      items: imminent
        .sort((a, b) => (a.runwayDays ?? 0) - (b.runwayDays ?? 0))
        .map(
          (r) =>
            `${r.product.name} — ${formatRunway(r.runwayDays)} left, ${r.quantity} ${r.product.unit} on hand`,
        ),
    });
  }

  if (soon.length) {
    findings.push({
      severity: "warning",
      title: `${plural(soon.length, "product")} running out within ${RISK_DAYS} days`,
      detail: "Enough time to reorder, not enough to ignore.",
      items: soon
        .sort((a, b) => (a.runwayDays ?? 0) - (b.runwayDays ?? 0))
        .map((r) => `${r.product.name} — ${formatRunway(r.runwayDays)} left`),
    });
  }

  if (shrinkage > 0) {
    findings.push({
      severity: "warning",
      title: `${shrinkage} units written off by stock adjustments`,
      detail: `Counted lower than recorded over the last ${DEMAND_WINDOW_DAYS} days. Worth checking whether this is damage, miscounting, or unrecorded movement.`,
    });
  }

  if (dormant.length) {
    const dormantUnits = dormant.reduce((sum, r) => sum + r.quantity, 0);
    findings.push({
      severity: "warning",
      title: `${plural(dormant.length, "product")} with no outbound movement`,
      detail: `${dormantUnits} units have not shipped in ${DEMAND_WINDOW_DAYS} days. This is working capital sitting still, and the usual cause of overstock.`,
      items: dormant.map((r) => `${r.product.name} — ${r.quantity} ${r.product.unit}`),
    });
  }

  if (trendPct !== null && Math.abs(trendPct) >= 20) {
    const rising = trendPct > 0;
    findings.push({
      severity: rising ? "warning" : "healthy",
      title: `Outbound demand ${rising ? "up" : "down"} ${Math.abs(trendPct)}% over ${TREND_DAYS} days`,
      detail: `${recent} units shipped in the last ${TREND_DAYS} days against ${previous} in the ${TREND_DAYS} before. ${
        rising
          ? "Runway figures below assume the longer-term average, so they may be optimistic."
          : "Runway figures below may therefore be pessimistic."
      }`,
    });
  }

  if (thresholdNoise.length) {
    findings.push({
      severity: "healthy",
      title: `${plural(thresholdNoise.length, "low-stock alert")} that may be a threshold problem`,
      detail:
        "Below the configured reorder point, but with weeks of runway at current demand. Consider lowering the threshold rather than reordering.",
      items: thresholdNoise.map(
        (r) => `${r.product.name} — ${r.quantity} ${r.product.unit}, ${formatRunway(r.runwayDays)}`,
      ),
    });
  }

  // Concentration: one location holding nearly everything is a single point of failure.
  const concentrated: string[] = [];
  for (const row of stocked) {
    if (input.locations.length < 2) break;
    const perLocation = input.balances.filter((b) => b.product_id === row.product.id);
    const top = perLocation.reduce(
      (best, b) =>
        Number(b.quantity) > best.quantity
          ? { id: b.location_id, quantity: Number(b.quantity) }
          : best,
      { id: "", quantity: 0 },
    );
    if (
      row.quantity > 0 &&
      top.quantity / row.quantity >= CONCENTRATION_SHARE &&
      perLocation.length > 1
    ) {
      const name = input.locations.find((l) => l.id === top.id)?.name ?? "one location";
      concentrated.push(
        `${row.product.name} — ${Math.round((top.quantity / row.quantity) * 100)}% in ${name}`,
      );
    }
  }
  if (concentrated.length) {
    findings.push({
      severity: "healthy",
      title: `${plural(concentrated.length, "product")} concentrated in a single location`,
      detail:
        "Fine operationally, but worth knowing before a location is taken offline for a count.",
      items: concentrated,
    });
  }

  const reorderPlan: ReorderLine[] = rows
    .filter(
      (r) =>
        r.suggested > 0 &&
        (r.quantity <= Number(r.product.reorder_point) ||
          (r.runwayDays !== null && r.runwayDays <= RISK_DAYS)),
    )
    .sort(
      (a, b) =>
        (a.runwayDays ?? Number.POSITIVE_INFINITY) - (b.runwayDays ?? Number.POSITIVE_INFINITY),
    )
    .map((r) => ({
      sku: r.product.sku,
      name: r.product.name,
      unit: r.product.unit,
      onHand: r.quantity,
      runway: formatRunway(r.runwayDays),
      runwayDays: r.runwayDays,
      confidence: r.demand.confidence,
      confidenceReason: r.demand.confidenceReason,
      suggested: r.suggested,
    }));

  const weak = reorderPlan.filter((line) => line.confidence === "low").length;
  if (weak) {
    findings.push({
      severity: "healthy",
      title: `${plural(weak, "reorder suggestion")} rest on thin or erratic history`,
      detail:
        "Those quantities are a starting point for a human decision, not a forecast. Each line states why below.",
    });
  }

  if (!scoped.length) {
    findings.length = 0;
    findings.push({
      severity: "healthy",
      title: "No stock recorded at this warehouse",
      detail:
        "Nothing has been received here and nothing has moved through it, so there is nothing to analyse yet.",
    });
  } else if (!findings.some((f) => f.severity !== "healthy")) {
    findings.unshift({
      severity: "healthy",
      title: "Nothing needs attention",
      detail: `No stockouts, no product inside its ${RISK_DAYS}-day risk window, and no write-offs in the last ${DEMAND_WINDOW_DAYS} days.`,
    });
  }

  return {
    warehouse: input.warehouse,
    generatedAt: now.toISOString(),
    headline: [
      { label: "Products here", value: String(scoped.length) },
      { label: "Units on hand", value: String(round(totalUnits)) },
      { label: "Out of stock", value: String(outOfStock.length) },
      { label: "At risk", value: String(outOfStock.length + imminent.length + soon.length) },
      { label: `Shipped (${DEMAND_WINDOW_DAYS}d)`, value: String(round(outboundUnits)) },
      { label: "Written off", value: String(round(shrinkage)) },
    ],
    findings,
    reorderPlan,
    method: [
      `Demand counts validated deliveries only, over the last ${DEMAND_WINDOW_DAYS} days. Transfers net to zero inside the workspace and adjustments are corrections, so neither is treated as demand.`,
      `Time to stockout is units on hand divided by average daily demand across that window.`,
      `Confidence is the week-to-week variation in demand plus how many movements back it: steady history reads high, thin or erratic history reads low.`,
      `Suggested order covers ${COVER_DAYS} days of demand and restores the product's reorder point. Supplier lead times and minimum order quantities are not tracked, so they are not included.`,
      `Every figure is computed from this workspace's ledger. There is no model and no external service involved.`,
    ],
  };
}
