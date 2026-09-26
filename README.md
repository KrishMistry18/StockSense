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

Copy `.env.example` to `.env` and fill it in. Every value is read from the environment — no project
reference is hardcoded anywhere in `src`, so pointing the app at a different backend is a config
change and nothing more.

Only the Supabase variables are required. Without an AI key the app runs normally and the AI
insights screen reports that analysis is not configured.

## Connect your own backend

The app is not tied to any particular Supabase project. To run it on one you control:

1. Create a project at [supabase.com](https://supabase.com/dashboard) (the free tier is enough).
2. Open **SQL Editor → New query**, paste all of [`scripts/schema.sql`](scripts/schema.sql), and run
   it. That file is every migration concatenated in order, so one run produces a fully migrated
   database: tables, row-level security policies, and the stock-movement functions.
3. From **Project Settings → API**, copy the project URL and publishable key into `.env`.
4. `bun run dev`.

Sign in with the demo accounts the schema seeds (`admin`, `manager`, `staff`, password
`StockSense#2026`), or create your own account.

> **Before real users:** drop those three accounts and delete
> `drizzle/migrations/0003_demo_accounts.sql`. Their password is committed to this repository.

## Database

Schema lives in `drizzle/migrations` as plain SQL, applied in the order recorded in
`drizzle/migrations/meta/_journal.json`. `drizzle/schema.ts` is intentionally blank.

`scripts/schema.sql` is generated from those migrations for one-shot setup. After adding a
migration, regenerate it rather than editing it by hand.

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
