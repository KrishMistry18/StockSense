# StockSense

Inventory operations for warehouse teams — live stock across every location, validated stock
movements, and an append-only ledger that explains every change.

## Development

You need [Bun](https://bun.sh) (the repo has a `bun.lock`) or Node.js with npm.

```sh
bun install
bun run dev
```

The dev server runs on http://localhost:8080.

| Command           | What it does                     |
| ----------------- | -------------------------------- |
| `bun run dev`     | Start the dev server             |
| `bun run build`   | Production build                 |
| `bun run preview` | Preview the production build     |
| `bun run lint`    | ESLint (includes Prettier rules) |
| `bun run format`  | Rewrite files with Prettier      |

## Configuration

Copy the Supabase values into `.env`:

| Variable                        | Purpose                            |
| ------------------------------- | ---------------------------------- |
| `VITE_SUPABASE_URL`             | Supabase project URL               |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public anon/publishable key        |
| `VITE_SUPABASE_PROJECT_ID`      | Supabase project ref               |
| `LOVABLE_API_KEY`               | AI gateway key for the AI insights |

Without `LOVABLE_API_KEY` the app runs fine; the AI insights screen reports that analysis is not
configured. Point `src/lib/warehouse-ai.server.ts` at a different provider to swap it out.

## Database

Schema lives in `drizzle/migrations` as plain SQL, applied in the order recorded in
`drizzle/migrations/meta/_journal.json`. `drizzle/schema.ts` is intentionally blank.

## Key concepts

- **Operations** — receipts, deliveries, internal transfers, and adjustments. A document only moves
  stock when it is validated, and deliveries step through pick, pack, and dispatch.
- **Stock ledger** — append-only. Every movement records who made it, when, and why. Corrections are
  posted as counter-documents rather than edits, so history always reconciles.
- **Replenishment** — time-to-stockout and reorder suggestions derived from validated delivery
  history, each tagged with a confidence rating based on how steady that demand actually is.

## Built with

- TanStack Start
- React + TypeScript
- Tailwind CSS
- Supabase
