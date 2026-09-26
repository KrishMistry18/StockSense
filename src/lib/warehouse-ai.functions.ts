import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  analyzeWarehouseStock,
  type AnalysisLeg,
  type WarehouseAnalysis,
} from "@/lib/warehouse-analysis";
import { DEMAND_WINDOW_DAYS } from "@/lib/replenishment";

/**
 * Warehouse stock analysis.
 *
 * Stays an authenticated server function with workspace-scoped reads: membership is re-checked
 * server-side and every query is filtered by workspace, so one company's stock can never be read
 * through another's request. The analysis itself is deterministic arithmetic over the ledger — see
 * warehouse-analysis.ts — so no third-party service sees the data and no API key is required.
 */
export const analyzeWarehouse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { workspaceId: string; warehouseId: string }) => {
    if (!/^[0-9a-f-]{36}$/i.test(data.workspaceId) || !/^[0-9a-f-]{36}$/i.test(data.warehouseId)) {
      throw new Error("Choose a valid warehouse.");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<WarehouseAnalysis> => {
    const db = context.supabase;

    const { data: membership, error: memberError } = await db
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", data.workspaceId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (memberError || !membership) throw new Error("You cannot analyze this workspace.");

    const { data: warehouse, error: warehouseError } = await db
      .from("warehouses")
      .select("id,name")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.warehouseId)
      .maybeSingle();
    if (warehouseError || !warehouse) throw new Error("Warehouse not found.");

    const since = new Date(Date.now() - DEMAND_WINDOW_DAYS * 86_400_000).toISOString();
    const [locations, products, balances, ledger] = await Promise.all([
      db
        .from("locations")
        .select("id,name")
        .eq("workspace_id", data.workspaceId)
        .eq("warehouse_id", warehouse.id),
      db
        .from("products")
        .select("id,name,sku,unit,reorder_point")
        .eq("workspace_id", data.workspaceId)
        .eq("archived", false)
        .limit(500),
      db
        .from("stock_balances")
        .select("product_id,location_id,quantity")
        .eq("workspace_id", data.workspaceId),
      db
        .from("stock_ledger")
        .select("product_id,location_id,delta,created_at,operations(kind)")
        .eq("workspace_id", data.workspaceId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5000),
    ]);
    if (locations.error || products.error || balances.error || ledger.error) {
      throw new Error("Could not load current warehouse stock.");
    }

    // Scope balances and movements to this warehouse's locations before analysing.
    const locationIds = new Set((locations.data ?? []).map((l) => l.id));
    const legs: AnalysisLeg[] = (ledger.data ?? [])
      .filter((row) => locationIds.has(row.location_id))
      .map((row) => ({
        product_id: row.product_id,
        location_id: row.location_id,
        delta: Number(row.delta),
        created_at: row.created_at,
        kind: (row.operations as { kind: string } | null)?.kind ?? null,
      }));

    return analyzeWarehouseStock({
      warehouse: warehouse.name,
      products: products.data ?? [],
      locations: locations.data ?? [],
      balances: (balances.data ?? []).filter((b) => locationIds.has(b.location_id)),
      legs,
    });
  });
