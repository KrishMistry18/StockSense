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
3. From **Project Settings → API**, copy the project URL and keys into `.env`
   (see [`.env.example`](.env.example)).
4. Optional demo accounts: `bun run scripts/create-demo-users.ts`
5. `bun run dev`.

Step 4 creates `admin`, `manager`, and `staff`, password `StockSense#2026`, pre-confirmed so they
work while email confirmation stays on for real sign-ups. Skip it and register an account instead if
you prefer.

> **Never create users with raw SQL.** GoTrue scans several `auth.users` columns into non-nullable
> strings, and an `INSERT` that omits them leaves NULLs that take down the entire auth API with
> `500 Database error finding users` — unrecoverable through the API, since deleting such a row
> reads it first. Always go through the Auth Admin API, as that script does. If you hit this,
> [`scripts/repair-auth-users.sql`](scripts/repair-auth-users.sql) heals it.

> **Before real users:** drop those three accounts. Their password is committed to this repository.

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
