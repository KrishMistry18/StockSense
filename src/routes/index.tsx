import { createFileRoute } from "@tanstack/react-router";
import { InventoryApp } from "@/components/inventory-app";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "StockSense — Inventory Management" },
      {
        name: "description",
        content:
          "Manage products, warehouses, receipts, deliveries, transfers, and stock counts in real time.",
      },
      { property: "og:title", content: "StockSense — Inventory Management" },
      {
        property: "og:description",
        content: "A centralized workspace for accurate stock operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InventoryApp,
});
