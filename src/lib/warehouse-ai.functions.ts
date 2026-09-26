import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const analyzeWarehouse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { workspaceId: string; warehouseId: string }) => {
    if (!/^[0-9a-f-]{36}$/i.test(data.workspaceId) || !/^[0-9a-f-]{36}$/i.test(data.warehouseId)) throw new Error("Choose a valid warehouse.");
    return data;
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: membership, error: memberError } = await db.from("workspace_members").select("workspace_id").eq("workspace_id", data.workspaceId).eq("user_id", context.userId).maybeSingle();
    if (memberError || !membership) throw new Error("You cannot analyze this workspace.");
    const { data: warehouse, error: warehouseError } = await db.from("warehouses").select("id,name").eq("workspace_id", data.workspaceId).eq("id", data.warehouseId).maybeSingle();
    if (warehouseError || !warehouse) throw new Error("Warehouse not found.");
    const [locations, products, balances, ledger] = await Promise.all([
      db.from("locations").select("id,name").eq("workspace_id", data.workspaceId).eq("warehouse_id", warehouse.id),
      db.from("products").select("id,name,sku,unit,reorder_point").eq("workspace_id", data.workspaceId).eq("archived", false).limit(200),
      db.from("stock_balances").select("product_id,location_id,quantity").eq("workspace_id", data.workspaceId),
      db.from("stock_ledger").select("product_id,location_id,delta,created_at").eq("workspace_id", data.workspaceId).order("created_at", { ascending: false }).limit(300),
    ]);
    if (locations.error || products.error || balances.error || ledger.error) throw new Error("Could not load current warehouse stock.");
    const locationIds = new Set((locations.data ?? []).map(l => l.id));
    const productIds = new Set((products.data ?? []).map(p => p.id));
    const stock = (products.data ?? []).map(p => ({ sku: p.sku, product: p.name, unit: p.unit, reorder_point: p.reorder_point, on_hand: (balances.data ?? []).filter(b => b.product_id === p.id && locationIds.has(b.location_id)).reduce((sum, b) => sum + Number(b.quantity), 0) }));
    const movements = (ledger.data ?? []).filter(m => locationIds.has(m.location_id) && productIds.has(m.product_id)).slice(0, 80).map(m => ({ sku: (products.data ?? []).find(p => p.id === m.product_id)?.sku, location: (locations.data ?? []).find(l => l.id === m.location_id)?.name, change: m.delta, date: m.created_at }));
    const { generateWarehouseAdvice } = await import("./warehouse-ai.server");
    return { warehouse: warehouse.name, advice: await generateWarehouseAdvice({ warehouse: warehouse.name, stock, movements }) };
  });