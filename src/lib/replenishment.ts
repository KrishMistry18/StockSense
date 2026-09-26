/**
 * Demand and replenishment math derived from the stock ledger.
 *
 * Everything here is deterministic and auditable on purpose: the dashboard has to be able to
 * explain *why* it says a product runs out in four days, and a reorder suggestion has to be able
 * to admit when the history behind it is too thin to trust.
 */

/** One outbound-relevant ledger leg. `kind` is the parent operation's kind. */
export type DemandLeg = {
  product_id: string;
  delta: number;
  created_at: string;
  kind: string | null;
};

/** Eight whole weeks, so weekly demand buckets are all the same length. */
export const DEMAND_WINDOW_DAYS = 56;
const DEMAND_WINDOW_WEEKS = DEMAND_WINDOW_DAYS / 7;

/** How many days of demand a suggested reorder aims to cover. Stated in the UI, never implied. */
export const COVER_DAYS = 14;

/** A product is "at risk" once its runway drops to this, even if it is still above its threshold. */
export const RISK_DAYS = 14;

const DAY_MS = 86_400_000;

export type Confidence = "high" | "medium" | "low";

export type ProductDemand = {
  /** Average units consumed per day across the whole window, including zero-demand days. */
  dailyDemand: number;
  totalDemand: number;
  /** Number of outbound movements. The history-sufficiency signal. */
  movementCount: number;
  /** Coefficient of variation of weekly demand. The erratic-ness signal. */
  variability: number;
  windowDays: number;
  confidence: Confidence;
  confidenceReason: string;
};

export const NO_DEMAND: ProductDemand = {
  dailyDemand: 0,
  totalDemand: 0,
  movementCount: 0,
  variability: 0,
  windowDays: DEMAND_WINDOW_DAYS,
  confidence: "low",
  confidenceReason: `No outbound movement in the last ${DEMAND_WINDOW_DAYS} days.`,
};

function classify(
  movementCount: number,
  variability: number,
  totalDemand: number,
): ProductDemand["confidence"] {
  if (totalDemand <= 0) return "low";
  if (movementCount >= 6 && variability <= 0.6) return "high";
  if (movementCount >= 3 && variability <= 1.2) return "medium";
  return "low";
}

function explain(confidence: Confidence, movementCount: number, variability: number): string {
  const spread = `${Math.round(variability * 100)}% week-to-week swing`;
  const shipments = `${movementCount} outbound movement${movementCount === 1 ? "" : "s"}`;
  if (confidence === "high") return `Steady demand — ${shipments}, ${spread}.`;
  if (confidence === "medium") return `Usable but uneven — ${shipments}, ${spread}.`;
  if (movementCount < 3) return `Thin history — only ${shipments} in ${DEMAND_WINDOW_DAYS} days.`;
  return `Erratic demand — ${shipments}, ${spread}.`;
}

/**
 * Builds per-product demand from ledger legs.
 *
 * Only `delivery` legs count as demand. Transfers net to zero inside the workspace, receipts are
 * inflow, and adjustments are corrections or shrinkage — treating any of those as demand would
 * quietly inflate the forecast.
 */
export function buildDemand(legs: DemandLeg[], now = new Date()): Map<string, ProductDemand> {
  const windowStart = now.getTime() - DEMAND_WINDOW_DAYS * DAY_MS;
  const buckets = new Map<string, { weeks: number[]; total: number; movements: number }>();

  for (const leg of legs) {
    if (leg.kind !== "delivery") continue;
    const quantity = -Number(leg.delta);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const at = new Date(leg.created_at).getTime();
    if (!Number.isFinite(at) || at < windowStart || at > now.getTime()) continue;

    const week = Math.min(DEMAND_WINDOW_WEEKS - 1, Math.floor((now.getTime() - at) / (7 * DAY_MS)));
    let entry = buckets.get(leg.product_id);
    if (!entry) {
      entry = { weeks: new Array<number>(DEMAND_WINDOW_WEEKS).fill(0), total: 0, movements: 0 };
      buckets.set(leg.product_id, entry);
    }
    entry.weeks[week] = (entry.weeks[week] ?? 0) + quantity;
    entry.total += quantity;
    entry.movements += 1;
  }

  const demand = new Map<string, ProductDemand>();
  for (const [productId, entry] of buckets) {
    const mean = entry.total / DEMAND_WINDOW_WEEKS;
    const variance =
      entry.weeks.reduce((sum, week) => sum + (week - mean) ** 2, 0) / DEMAND_WINDOW_WEEKS;
    const variability = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const confidence = classify(entry.movements, variability, entry.total);
    demand.set(productId, {
      dailyDemand: entry.total / DEMAND_WINDOW_DAYS,
      totalDemand: entry.total,
      movementCount: entry.movements,
      variability,
      windowDays: DEMAND_WINDOW_DAYS,
      confidence,
      confidenceReason: explain(confidence, entry.movements, variability),
    });
  }
  return demand;
}

/** Days until on-hand stock hits zero at the current rate. `null` when nothing is being consumed. */
export function daysToStockout(onHand: number, dailyDemand: number): number | null {
  if (dailyDemand <= 0) return null;
  return Math.max(0, onHand) / dailyDemand;
}

/**
 * Quantity that covers {@link COVER_DAYS} of demand and still leaves the product on its low-stock
 * threshold afterwards. Deliberately simple: there is no supplier lead-time data in the workspace
 * yet, so inventing one would make the number look more informed than it is.
 */
export function suggestedQuantity(
  onHand: number,
  dailyDemand: number,
  reorderPoint: number,
): number {
  const targetLevel = dailyDemand * COVER_DAYS + Math.max(0, reorderPoint);
  return Math.max(0, Math.ceil(targetLevel - Math.max(0, onHand)));
}

export function formatRunway(days: number | null): string {
  if (days === null) return "No recent demand";
  if (days <= 0) return "Out of stock";
  if (days < 1) return "Under a day";
  if (days >= 90) return "90+ days";
  const whole = Math.floor(days);
  return `${whole} day${whole === 1 ? "" : "s"}`;
}

/** Tag class for the shared `.tag-*` styles, keyed off how urgent the runway is. */
export function runwayTone(days: number | null): string {
  if (days === null) return "";
  if (days <= 0) return "tag-out";
  if (days <= 3) return "tag-out";
  if (days <= RISK_DAYS) return "tag-low";
  return "tag-in";
}
