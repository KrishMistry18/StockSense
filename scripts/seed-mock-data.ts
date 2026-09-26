/**
 * Fills the workspace with realistic inventory history.
 *
 *   bun run scripts/seed-mock-data.ts
 *
 * DESIGN NOTES
 *
 * Every movement is posted through the real `advance_operation` RPC rather than written straight
 * into stock_balances or stock_ledger. Seeding those tables directly would leave balances and the
 * audit trail disagreeing with each other, which is exactly the property this app is built to
 * guarantee. It also means the seeded data exercises the same validation real users hit.
 *
 * That requires a signed-in user, not the service key: apply_stock stamps created_by with
 * auth.uid() (NOT NULL) and advance_operation checks is_member(workspace_id). So this signs in as
 * the admin demo account and works through the ordinary authenticated API.
 *
 * Documents are posted oldest-first and backdated immediately after, so stock_ledger.balance_after
 * stays monotonic and truthful for each product/location. Backdating needs the service key, because
 * authenticated users only hold SELECT on stock_ledger and a column-limited UPDATE on operations —
 * which is the correct permission model, so the seeder works around it rather than loosening it.
 *
 * Opening stock is derived: for each product, opening = everything it will ever ship + transfer out
 * + lose to shrinkage + the balance it should end on. That guarantees no movement is ever refused
 * for insufficient stock, and lets each product land on a chosen final state.
 *
 * Deterministic: the same run produces the same data.
 */

const DAY = 86_400_000;
const DEMO_EMAIL = "admin@stocksense.local";
const DEMO_PASSWORD = "StockSense#2026";
const MARKER_SKU = "STL-ROD-12"; // presence means the workspace is already seeded

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const url = (process.env["SUPABASE_URL"] ?? "").replace(/\/$/, "");
const publishable = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? "";
const secret = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_SECRET_KEY"] ?? "";
if (!url || !publishable || !secret) {
  console.error(
    "Need SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY in .env",
  );
  process.exit(1);
}

// Supabase rejects secret keys on requests that look browser-originated.
const UA = "StockSense-Seed/1.0";
let accessToken = "";

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; service?: boolean; prefer?: string } = {},
) {
  const key = opts.service ? secret : publishable;
  const auth = opts.service ? secret : accessToken || publishable;
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${auth}`,
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object"
        ? String(
            (parsed as Record<string, unknown>)["message"] ??
              (parsed as Record<string, unknown>)["msg"] ??
              text,
          )
        : text;
    throw new Error(`${method} ${path} -> ${response.status}: ${detail}`);
  }
  return parsed;
}

const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** mulberry32 — small deterministic PRNG so repeated runs produce identical data. */
function makeRandom(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(20260926);
const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Catalogue and demand patterns
//
// `shipDays` drives what the Replenishment screen concludes. Demand confidence is the coefficient
// of variation of *weekly* totals, so a product shipping regularly — daily or weekly — reads as
// high confidence, while lumpy or one-off demand reads as low. The spread below is deliberate so
// every confidence tier and stock state appears on screen.
// ---------------------------------------------------------------------------

type Product = {
  sku: string;
  name: string;
  category: string;
  unit: string;
  reorderPoint: number;
  endingTarget: number;
  shipDays: { day: number; qty: number }[];
  id?: string;
};

/** Ships every `stride` days, quantity jittered by +/-`jitter` percent. */
function regular(stride: number, qty: number, jitter = 0.15): { day: number; qty: number }[] {
  const out: { day: number; qty: number }[] = [];
  for (let day = 54; day >= 1; day -= stride) {
    const wobble = 1 + (random() * 2 - 1) * jitter;
    out.push({ day, qty: Math.max(1, Math.round(qty * wobble)) });
  }
  return out;
}

/** Ships on a handful of unpredictable days with wildly different quantities. */
function erratic(count: number, lo: number, hi: number): { day: number; qty: number }[] {
  const days = new Set<number>();
  while (days.size < count) days.add(between(2, 54));
  return [...days].sort((a, b) => b - a).map((day) => ({ day, qty: between(lo, hi) }));
}

const CATALOGUE: Product[] = [
  // Steady daily mover, deliberately left with only a few days of runway.
  {
    sku: MARKER_SKU,
    name: "Steel Rod 12mm",
    category: "Raw Material",
    unit: "Units",
    reorderPoint: 100,
    endingTarget: 38,
    shipDays: regular(2, 22),
  },
  // Regular weekly cadence: high confidence despite shipping only once a week.
  {
    sku: "CU-WIRE-50",
    name: "Copper Wire Spool 50m",
    category: "Electrical",
    unit: "Spools",
    reorderPoint: 120,
    endingTarget: 84,
    shipDays: regular(7, 60),
  },
  {
    sku: "FLT-CRT-20",
    name: "Filter Cartridge 20in",
    category: "Consumables",
    unit: "Units",
    reorderPoint: 60,
    endingTarget: 210,
    shipDays: regular(7, 34),
  },
  {
    sku: "BLT-M10-BX",
    name: "Bolt M10 Box",
    category: "Fasteners",
    unit: "Boxes",
    reorderPoint: 200,
    endingTarget: 610,
    shipDays: regular(1, 26),
  },
  {
    sku: "BRG-6204",
    name: "Bearing 6204",
    category: "Components",
    unit: "Units",
    reorderPoint: 80,
    endingTarget: 152,
    shipDays: regular(3, 18),
  },
  {
    sku: "WLD-ROD-25",
    name: "Welding Rod 2.5mm",
    category: "Consumables",
    unit: "Packs",
    reorderPoint: 90,
    endingTarget: 26,
    shipDays: regular(2, 14),
  },
  {
    sku: "OIL-MTR-5L",
    name: "Motor Oil 5L",
    category: "Lubricants",
    unit: "Cans",
    reorderPoint: 50,
    endingTarget: 124,
    shipDays: regular(4, 20),
  },
  // Erratic: low confidence, because the weekly spread is enormous.
  {
    sku: "SFT-HLM-01",
    name: "Safety Helmet",
    category: "Safety",
    unit: "Units",
    reorderPoint: 40,
    endingTarget: 46,
    shipDays: erratic(5, 4, 90),
  },
  {
    sku: "CNV-BLT-5M",
    name: "Conveyor Belt 5m",
    category: "Components",
    unit: "Rolls",
    reorderPoint: 5,
    endingTarget: 11,
    shipDays: erratic(3, 1, 6),
  },
  // Semi-regular with real variation: lands in the middle confidence tier.
  {
    sku: "PMP-SEAL-K",
    name: "Pump Seal Kit",
    category: "Components",
    unit: "Kits",
    reorderPoint: 30,
    endingTarget: 34,
    shipDays: [
      { day: 52, qty: 18 },
      { day: 45, qty: 9 },
      { day: 33, qty: 26 },
      { day: 26, qty: 12 },
      { day: 12, qty: 21 },
      { day: 5, qty: 7 },
    ],
  },
  // One-off: thin history, so the suggestion is explicitly untrustworthy.
  {
    sku: "HYD-PMP-A2",
    name: "Hydraulic Pump A2",
    category: "Machinery",
    unit: "Units",
    reorderPoint: 4,
    endingTarget: 6,
    shipDays: [{ day: 12, qty: 3 }],
  },
  // Ends at exactly zero, so the dashboard shows a genuine out-of-stock.
  {
    sku: "GSK-SET-09",
    name: "Gasket Set 09",
    category: "Components",
    unit: "Sets",
    reorderPoint: 25,
    endingTarget: 0,
    shipDays: regular(6, 18),
  },
  // Never ships: Replenishment must say "No recent demand" rather than inventing a forecast.
  {
    sku: "PNT-DRM-20",
    name: "Paint Drum 20L",
    category: "Finishing",
    unit: "Drums",
    reorderPoint: 20,
    endingTarget: 58,
    shipDays: [],
  },
  {
    sku: "PNT-THN-5L",
    name: "Paint Thinner 5L",
    category: "Finishing",
    unit: "Cans",
    reorderPoint: 15,
    endingTarget: 42,
    shipDays: [],
  },
  {
    sku: "HEX-NUT-M8",
    name: "Hex Nut M8 Bag",
    category: "Fasteners",
    unit: "Bags",
    reorderPoint: 150,
    endingTarget: 480,
    shipDays: regular(2, 30),
  },
  {
    sku: "WSH-FLT-M8",
    name: "Flat Washer M8 Bag",
    category: "Fasteners",
    unit: "Bags",
    reorderPoint: 120,
    endingTarget: 96,
    shipDays: regular(3, 26),
  },
  {
    sku: "GLV-NTR-L",
    name: "Nitrile Glove L",
    category: "Safety",
    unit: "Boxes",
    reorderPoint: 60,
    endingTarget: 52,
    shipDays: regular(2, 17),
  },
  {
    sku: "GOG-SFT-CL",
    name: "Safety Goggles",
    category: "Safety",
    unit: "Units",
    reorderPoint: 35,
    endingTarget: 140,
    shipDays: regular(5, 22),
  },
  {
    sku: "TAP-DCT-50",
    name: "Duct Tape 50m",
    category: "Consumables",
    unit: "Rolls",
    reorderPoint: 40,
    endingTarget: 31,
    shipDays: erratic(6, 5, 55),
  },
  {
    sku: "GRS-LTH-1K",
    name: "Lithium Grease 1kg",
    category: "Lubricants",
    unit: "Tubs",
    reorderPoint: 25,
    endingTarget: 88,
    shipDays: regular(6, 15),
  },
  {
    sku: "BRG-6308",
    name: "Bearing 6308",
    category: "Components",
    unit: "Units",
    reorderPoint: 45,
    endingTarget: 38,
    shipDays: regular(4, 21),
  },
  {
    sku: "VLV-BAL-2I",
    name: "Ball Valve 2in",
    category: "Components",
    unit: "Units",
    reorderPoint: 18,
    endingTarget: 14,
    shipDays: erratic(4, 2, 22),
  },
  {
    sku: "CHN-RLR-3M",
    name: "Roller Chain 3m",
    category: "Machinery",
    unit: "Lengths",
    reorderPoint: 8,
    endingTarget: 26,
    shipDays: regular(9, 7),
  },
  {
    sku: "ELC-CBL-10",
    name: "Control Cable 10m",
    category: "Electrical",
    unit: "Coils",
    reorderPoint: 30,
    endingTarget: 24,
    shipDays: regular(3, 12),
  },
  {
    sku: "FSE-30A-BX",
    name: "Fuse 30A Box",
    category: "Electrical",
    unit: "Boxes",
    reorderPoint: 22,
    endingTarget: 110,
    shipDays: regular(8, 14),
  },
];

const CUSTOMERS = [
  "Northwind Fabrication",
  "Acme Rail Works",
  "Baltic Shipyard",
  "Orion Motors",
  "Kestrel Engineering",
  "Vale Construction",
];
const SUPPLIERS = [
  "Tata Steel Supply",
  "Continental Bearings",
  "Nordic Wire Co.",
  "Apex Industrial",
  "Meridian Tools",
];

// Extra movements layered on top of deliveries, all inside the demand window.
const TRANSFERS = [
  { day: 47, sku: "GOG-SFT-CL", qty: 45 },
  { day: 40, sku: MARKER_SKU, qty: 60 },
  { day: 34, sku: "HEX-NUT-M8", qty: 120 },
  { day: 22, sku: "BLT-M10-BX", qty: 80 },
  { day: 16, sku: "GRS-LTH-1K", qty: 20 },
  { day: 9, sku: "FLT-CRT-20", qty: 40 },
  { day: 4, sku: "FSE-30A-BX", qty: 25 },
];
const SHRINKAGE = [
  { day: 43, sku: "TAP-DCT-50", qty: 9, reason: "Cycle count — shortfall against recorded stock" },
  { day: 29, sku: "GLV-NTR-L", qty: 4, reason: "Cycle count — packaging damaged" },
  { day: 17, sku: "SFT-HLM-01", qty: 6, reason: "Cycle count — damaged in storage" },
  { day: 6, sku: "ELC-CBL-10", qty: 3, reason: "Cycle count — offcuts unaccounted for" },
];
// Mid-window restocks, so Move history is not a wall of outbound movement.
const RESTOCKS = [
  { day: 50, sku: "HEX-NUT-M8", qty: 500 },
  { day: 46, sku: "BLT-M10-BX", qty: 400 },
  { day: 38, sku: "GLV-NTR-L", qty: 180 },
  { day: 31, sku: MARKER_SKU, qty: 260 },
  { day: 24, sku: "BRG-6308", qty: 150 },
  { day: 19, sku: "WSH-FLT-M8", qty: 240 },
  { day: 15, sku: "CU-WIRE-50", qty: 180 },
  { day: 8, sku: "GRS-LTH-1K", qty: 60 },
];

// ---------------------------------------------------------------------------
// Posting helpers
// ---------------------------------------------------------------------------

let reference = 0;
const nextRef = (kind: string) =>
  `${kind.slice(0, 3).toUpperCase()}/2026/${String(++reference).padStart(4, "0")}`;

type Line = { product_id: string; quantity: number; counted_quantity?: number | null };

/** Creates a document, adds its lines, validates it, then backdates everything it touched. */
async function postDocument(input: {
  workspaceId: string;
  userId: string;
  kind: "receipt" | "delivery" | "transfer" | "adjustment";
  contact: string;
  source?: string | null;
  destination?: string | null;
  notes?: string;
  lines: Line[];
  at: Date;
  leaveAsDraft?: boolean;
  /** Advance a delivery only as far as this stage, so the pipeline shows picked and packed states. */
  stopAt?: "waiting" | "ready";
}): Promise<string> {
  const created = rows<{ id: string }>(
    await api("POST", "/rest/v1/operations", {
      prefer: "return=representation",
      body: {
        workspace_id: input.workspaceId,
        reference: nextRef(input.kind),
        kind: input.kind,
        status: "draft",
        contact: input.contact,
        notes: input.notes ?? "",
        source_location_id: input.source ?? null,
        destination_location_id: input.destination ?? null,
        created_by: input.userId,
      },
    }),
  )[0];
  if (!created) throw new Error("operation insert returned no row");

  await api("POST", "/rest/v1/operation_items", {
    body: input.lines.map((line) => ({
      workspace_id: input.workspaceId,
      operation_id: created.id,
      product_id: line.product_id,
      quantity: line.quantity,
      counted_quantity: line.counted_quantity ?? null,
    })),
  });

  const stamp = input.at.toISOString();

  if (input.leaveAsDraft && !input.stopAt) {
    await api("PATCH", `/rest/v1/operations?id=eq.${created.id}`, {
      service: true,
      body: { created_at: stamp },
    });
    return created.id;
  }

  // Deliveries must walk pick -> pack -> dispatch; everything else validates in one step.
  const full = input.kind === "delivery" ? ["waiting", "ready", "done"] : ["done"];
  const steps = input.stopAt ? full.slice(0, full.indexOf(input.stopAt) + 1) : full;
  for (const next of steps) {
    await api("POST", "/rest/v1/rpc/advance_operation", {
      body: { op_id: created.id, next_status: next },
    });
  }

  if (input.stopAt) {
    await api("PATCH", `/rest/v1/operations?id=eq.${created.id}`, {
      service: true,
      body: {
        created_at: stamp,
        picked_at: stamp,
        ...(input.stopAt === "ready" ? { packed_at: stamp } : {}),
      },
    });
    return created.id;
  }

  await api("PATCH", `/rest/v1/operations?id=eq.${created.id}`, {
    service: true,
    body: {
      created_at: stamp,
      completed_at: stamp,
      ...(input.kind === "delivery" ? { picked_at: stamp, packed_at: stamp } : {}),
    },
  });
  await api("PATCH", `/rest/v1/stock_ledger?operation_id=eq.${created.id}`, {
    service: true,
    body: { created_at: stamp },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Target: ${url}\n`);

  const session = (await api("POST", "/auth/v1/token?grant_type=password", {
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  })) as { access_token: string; user: { id: string } };
  accessToken = session.access_token;
  const userId = session.user.id;
  console.log(`Signed in as ${DEMO_EMAIL}`);

  const workspace = rows<{ id: string; name: string }>(
    await api("GET", "/rest/v1/workspaces?select=id,name&order=created_at.asc&limit=1"),
  )[0];
  if (!workspace) throw new Error("No workspace found. Run scripts/create-demo-users.ts first.");
  console.log(`Workspace: ${workspace.name}\n`);

  const reset = process.argv.includes("--reset");
  const alreadySeeded =
    rows(await api("GET", `/rest/v1/products?select=id&sku=eq.${MARKER_SKU}&limit=1`)).length > 0;

  if (alreadySeeded && !reset) {
    console.log(`Already seeded — found ${MARKER_SKU}. Re-run with --reset to wipe and rebuild.`);
    return;
  }

  if (reset) {
    // Child rows first: stock_ledger references operations, products and locations; stock_balances
    // references products and locations. Deleting operations cascades to operation_items.
    console.log("--reset: clearing all inventory data for this workspace");
    for (const table of [
      "stock_ledger",
      "stock_balances",
      "operations",
      "products",
      "locations",
      "warehouses",
    ]) {
      await api("DELETE", `/rest/v1/${table}?workspace_id=eq.${workspace.id}`, { service: true });
      console.log(`  cleared ${table}`);
    }
  }

  // --- Warehouses and locations --------------------------------------------
  const warehouseSpec = [
    {
      name: "Central Warehouse",
      code: "CEN",
      locations: [
        ["Main Stock", "MAIN"],
        ["Rack B", "RCKB"],
        ["Rack C", "RCKC"],
        ["Goods In", "GIN"],
        ["Quarantine", "QTN"],
      ],
    },
    {
      name: "South Depot",
      code: "STH",
      locations: [
        ["Main Stock", "MAIN"],
        ["Overflow Yard", "YARD"],
        ["Dispatch Bay", "DSP"],
      ],
    },
    {
      name: "North Workshop",
      code: "NTH",
      locations: [
        ["Workshop Floor", "FLOOR"],
        ["Tool Store", "TOOL"],
      ],
    },
  ];
  const loc: Record<string, string> = {};
  for (const spec of warehouseSpec) {
    const warehouse = rows<{ id: string }>(
      await api("POST", "/rest/v1/warehouses", {
        prefer: "return=representation",
        body: { workspace_id: workspace.id, name: spec.name, code: spec.code },
      }),
    )[0];
    if (!warehouse) throw new Error(`warehouse ${spec.code} insert returned no row`);
    for (const [name, code] of spec.locations) {
      const created = rows<{ id: string }>(
        await api("POST", "/rest/v1/locations", {
          prefer: "return=representation",
          body: { workspace_id: workspace.id, warehouse_id: warehouse.id, name, code },
        }),
      )[0];
      if (!created) throw new Error(`location ${code} insert returned no row`);
      loc[`${spec.code}/${code}`] = created.id;
    }
    console.log(`warehouse  ${spec.name} (${spec.locations.length} locations)`);
  }
  const MAIN = loc["CEN/MAIN"]!;
  const RACKB = loc["CEN/RCKB"]!;
  const SOUTH = loc["STH/MAIN"]!;

  // --- Products -------------------------------------------------------------
  for (const product of CATALOGUE) {
    const created = rows<{ id: string }>(
      await api("POST", "/rest/v1/products", {
        prefer: "return=representation",
        body: {
          workspace_id: workspace.id,
          name: product.name,
          sku: product.sku,
          category: product.category,
          unit: product.unit,
          reorder_point: product.reorderPoint,
        },
      }),
    )[0];
    if (!created) throw new Error(`product ${product.sku} insert returned no row`);
    product.id = created.id;
  }
  console.log(`products   ${CATALOGUE.length} created\n`);
  const bySku = new Map(CATALOGUE.map((p) => [p.sku, p]));

  // --- Opening stock --------------------------------------------------------
  // Simulated rather than guessed. Every later movement at Main Stock is replayed in order to find
  // two things: the deepest point the running balance reaches (so opening stock is never so low
  // that a movement gets refused for insufficient stock), and the net change across the whole
  // timeline (so the product can be made to land on the final balance its scenario calls for).
  //
  // An earlier version simply summed what each product ships. Mid-window restocks then landed on
  // top of that, leaving products far above their intended ending balance and a dashboard with
  // almost nothing to look at.
  const opening = CATALOGUE.map((product) => {
    const deltas: { day: number; delta: number }[] = [
      ...product.shipDays.map((s) => ({ day: s.day, delta: -s.qty })),
      ...TRANSFERS.filter((t) => t.sku === product.sku).map((t) => ({ day: t.day, delta: -t.qty })),
      ...SHRINKAGE.filter((s) => s.sku === product.sku).map((s) => ({ day: s.day, delta: -s.qty })),
      ...RESTOCKS.filter((r) => r.sku === product.sku).map((r) => ({ day: r.day, delta: r.qty })),
    ].sort((a, b) => b.day - a.day); // oldest first

    let running = 0;
    let deepest = 0;
    for (const entry of deltas) {
      running += entry.delta;
      deepest = Math.min(deepest, running);
    }
    const feasibleMinimum = -deepest; // never let the balance go negative
    const toHitTarget = product.endingTarget - running; // land exactly on the target
    return { product, quantity: Math.max(feasibleMinimum, toHitTarget, 0) };
  }).filter((entry) => entry.quantity > 0);

  await postDocument({
    workspaceId: workspace.id,
    userId,
    kind: "receipt",
    contact: "Opening balance",
    destination: MAIN,
    notes: "Opening stock count carried into StockSense.",
    lines: opening.map((entry) => ({ product_id: entry.product.id!, quantity: entry.quantity })),
    at: new Date(Date.now() - 70 * DAY),
  });
  console.log(`receipt    opening stock, ${opening.length} lines`);

  // --- Chronological movements ---------------------------------------------
  type Event = { day: number; run: () => Promise<void> };
  const events: Event[] = [];

  // One delivery document per shipping day, covering every product that ships that day.
  const byDay = new Map<number, { product: Product; qty: number }[]>();
  for (const product of CATALOGUE) {
    for (const ship of product.shipDays) {
      const list = byDay.get(ship.day) ?? [];
      list.push({ product, qty: ship.qty });
      byDay.set(ship.day, list);
    }
  }
  for (const [day, lines] of byDay) {
    events.push({
      day,
      run: async () => {
        await postDocument({
          workspaceId: workspace.id,
          userId,
          kind: "delivery",
          contact: CUSTOMERS[between(0, CUSTOMERS.length - 1)]!,
          source: MAIN,
          lines: lines.map((l) => ({ product_id: l.product.id!, quantity: l.qty })),
          at: new Date(Date.now() - day * DAY + between(9, 17) * 3_600_000),
        });
      },
    });
  }

  for (const transfer of TRANSFERS) {
    events.push({
      day: transfer.day,
      run: async () => {
        await postDocument({
          workspaceId: workspace.id,
          userId,
          kind: "transfer",
          contact: "Internal",
          source: MAIN,
          destination: transfer.day === 22 ? SOUTH : RACKB,
          notes: "Rebalancing stock across locations.",
          lines: [{ product_id: bySku.get(transfer.sku)!.id!, quantity: transfer.qty }],
          at: new Date(Date.now() - transfer.day * DAY + 11 * 3_600_000),
        });
      },
    });
  }

  for (const loss of SHRINKAGE) {
    const product = bySku.get(loss.sku)!;
    events.push({
      day: loss.day,
      run: async () => {
        // An adjustment sets an absolute counted figure, so read the live balance first.
        const balance = rows<{ quantity: number }>(
          await api(
            "GET",
            `/rest/v1/stock_balances?select=quantity&product_id=eq.${product.id}&location_id=eq.${MAIN}`,
          ),
        )[0];
        const current = Number(balance?.quantity ?? 0);
        await postDocument({
          workspaceId: workspace.id,
          userId,
          kind: "adjustment",
          contact: "Cycle count",
          source: MAIN,
          notes: loss.reason,
          lines: [
            {
              product_id: product.id!,
              quantity: current,
              counted_quantity: Math.max(0, current - loss.qty),
            },
          ],
          at: new Date(Date.now() - loss.day * DAY + 14 * 3_600_000),
        });
      },
    });
  }

  for (const restock of RESTOCKS) {
    events.push({
      day: restock.day,
      run: async () => {
        await postDocument({
          workspaceId: workspace.id,
          userId,
          kind: "receipt",
          contact: SUPPLIERS[between(0, SUPPLIERS.length - 1)]!,
          destination: MAIN,
          lines: [{ product_id: bySku.get(restock.sku)!.id!, quantity: restock.qty }],
          at: new Date(Date.now() - restock.day * DAY + 10 * 3_600_000),
        });
      },
    });
  }

  // Oldest first, so each ledger row's balance_after matches its backdated timestamp.
  events.sort((a, b) => b.day - a.day);
  let done = 0;
  for (const event of events) {
    await event.run();
    done++;
    if (done % 10 === 0 || done === events.length)
      console.log(`movements  ${done}/${events.length} posted`);
  }

  // Restocks above were added after opening stock was computed, so top the ending balances back up
  // is unnecessary — they simply leave more on hand, which is realistic.

  // --- Open documents ------------------------------------------------------
  // A real warehouse has a queue, not one of each. These sit at different stages so the pending
  // counters differ from one another and the delivery pipeline shows picked and packed states.
  const open: {
    kind: "receipt" | "delivery" | "transfer" | "adjustment";
    contact: string;
    source?: string;
    destination?: string;
    notes: string;
    lines: [string, number][];
    hours: number;
    stopAt?: "waiting" | "ready";
  }[] = [
    {
      kind: "receipt",
      contact: SUPPLIERS[0]!,
      destination: loc["CEN/GIN"]!,
      notes: "Purchase order awaiting delivery.",
      lines: [
        [MARKER_SKU, 500],
        ["WLD-ROD-25", 240],
      ],
      hours: 52,
    },
    {
      kind: "receipt",
      contact: SUPPLIERS[2]!,
      destination: loc["CEN/GIN"]!,
      notes: "Backorder, partial shipment expected.",
      lines: [["CU-WIRE-50", 200]],
      hours: 30,
    },
    {
      kind: "receipt",
      contact: SUPPLIERS[3]!,
      destination: loc["STH/MAIN"]!,
      notes: "Direct to South Depot.",
      lines: [
        ["GLV-NTR-L", 150],
        ["GOG-SFT-CL", 80],
      ],
      hours: 19,
    },
    {
      kind: "receipt",
      contact: SUPPLIERS[1]!,
      destination: loc["CEN/QTN"]!,
      notes: "Held in quarantine pending inspection.",
      lines: [["BRG-6308", 90]],
      hours: 7,
    },
    {
      kind: "delivery",
      contact: CUSTOMERS[1]!,
      source: MAIN,
      notes: "Awaiting pick.",
      lines: [["BRG-6204", 24]],
      hours: 26,
    },
    {
      kind: "delivery",
      contact: CUSTOMERS[3]!,
      source: MAIN,
      notes: "Picked, awaiting packing.",
      lines: [
        ["HEX-NUT-M8", 40],
        ["WSH-FLT-M8", 30],
      ],
      hours: 15,
      stopAt: "waiting",
    },
    {
      kind: "delivery",
      contact: CUSTOMERS[4]!,
      source: MAIN,
      notes: "Packed, ready for dispatch.",
      lines: [["OIL-MTR-5L", 18]],
      hours: 9,
      stopAt: "ready",
    },
    {
      kind: "delivery",
      contact: CUSTOMERS[5]!,
      source: loc["STH/MAIN"]!,
      notes: "South Depot order, awaiting pick.",
      lines: [["FSE-30A-BX", 12]],
      hours: 4,
    },
    {
      kind: "transfer",
      contact: "Internal",
      source: MAIN,
      destination: SOUTH,
      notes: "Planned rebalance to South Depot.",
      lines: [["OIL-MTR-5L", 30]],
      hours: 6,
    },
    {
      kind: "transfer",
      contact: "Internal",
      source: MAIN,
      destination: loc["NTH/FLOOR"]!,
      notes: "Workshop consumables top-up.",
      lines: [
        ["GRS-LTH-1K", 12],
        ["TAP-DCT-50", 10],
      ],
      hours: 3,
    },
    {
      kind: "transfer",
      contact: "Internal",
      source: loc["CEN/RCKB"]!,
      destination: loc["CEN/RCKC"]!,
      notes: "Consolidating rack space.",
      lines: [[MARKER_SKU, 25]],
      hours: 2,
    },
    {
      kind: "adjustment",
      contact: "Cycle count",
      source: loc["CEN/RCKB"]!,
      notes: "Quarterly count in progress.",
      lines: [["HEX-NUT-M8", 0]],
      hours: 5,
    },
    {
      kind: "adjustment",
      contact: "Cycle count",
      source: loc["STH/YARD"]!,
      notes: "Yard recount scheduled.",
      lines: [["GOG-SFT-CL", 0]],
      hours: 1,
    },
  ];

  for (const doc of open) {
    await postDocument({
      workspaceId: workspace.id,
      userId,
      kind: doc.kind,
      contact: doc.contact,
      ...(doc.source ? { source: doc.source } : {}),
      ...(doc.destination ? { destination: doc.destination } : {}),
      notes: doc.notes,
      lines: doc.lines.map(([sku, qty]) => ({
        product_id: bySku.get(sku)!.id!,
        quantity: qty,
        // An adjustment needs a counted figure; leave it equal so nothing moves if validated as-is.
        ...(doc.kind === "adjustment" ? { counted_quantity: qty } : {}),
      })),
      at: new Date(Date.now() - doc.hours * 3_600_000),
      leaveAsDraft: true,
      ...(doc.stopAt ? { stopAt: doc.stopAt } : {}),
    });
  }
  const count = (kind: string) => open.filter((d) => d.kind === kind).length;
  console.log(
    `open       ${count("receipt")} receipts, ${count("delivery")} deliveries, ${count("transfer")} transfers, ${count("adjustment")} adjustments`,
  );

  // --- A reversed document, so the audit trail has a correction to show ------
  const reversible = rows<{
    id: string;
    reference: string;
    contact: string;
    source_location_id: string | null;
  }>(
    await api(
      "GET",
      "/rest/v1/operations?select=id,reference,contact,source_location_id&kind=eq.delivery&status=eq.done&order=created_at.desc&limit=1",
    ),
  )[0];
  if (reversible) {
    const legs = rows<{ product_id: string; location_id: string; delta: number }>(
      await api(
        "GET",
        `/rest/v1/stock_ledger?select=product_id,location_id,delta&operation_id=eq.${reversible.id}`,
      ),
    );
    if (legs.length) {
      await postDocument({
        workspaceId: workspace.id,
        userId,
        kind: "receipt",
        contact: reversible.contact,
        destination: legs[0]!.location_id,
        // Same marker the app writes, so the UI links the two documents and RLS treats it as a
        // reversal (manager-only). The seeder runs as a manager, so this is allowed.
        notes: `Reversal of ${reversible.reference}. Reason: Customer refused delivery, stock returned to shelf`,
        lines: legs.map((leg) => ({
          product_id: leg.product_id,
          quantity: Math.abs(Number(leg.delta)),
        })),
        at: new Date(Date.now() - 20 * 3_600_000),
      });
      console.log(`reversal   counter-document posted against ${reversible.reference}`);
    }
  }

  // --- A cancelled document, so not every closed document is a success -------
  const cancelled = rows<{ id: string }>(
    await api("POST", "/rest/v1/operations", {
      prefer: "return=representation",
      body: {
        workspace_id: workspace.id,
        reference: nextRef("delivery"),
        kind: "delivery",
        status: "draft",
        contact: CUSTOMERS[2]!,
        source_location_id: MAIN,
        notes: "Customer cancelled before picking.",
        created_by: userId,
      },
    }),
  )[0];
  if (cancelled) {
    await api("POST", "/rest/v1/operation_items", {
      body: [
        {
          workspace_id: workspace.id,
          operation_id: cancelled.id,
          product_id: bySku.get("CNV-BLT-5M")!.id!,
          quantity: 3,
        },
      ],
    });
    await api("POST", "/rest/v1/rpc/advance_operation", {
      body: { op_id: cancelled.id, next_status: "canceled" },
    });
    const stamp = new Date(Date.now() - 33 * 3_600_000).toISOString();
    await api("PATCH", `/rest/v1/operations?id=eq.${cancelled.id}`, {
      service: true,
      body: { created_at: stamp },
    });
    console.log("cancelled  1 abandoned delivery");
  }

  console.log("\nSeeded. Sign in and check Dashboard, Replenishment, and Move history.");
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
