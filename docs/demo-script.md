# StockSense — demo video script

Every figure below was read from the live database. If you record more than a day or two from now
they will have drifted, because runway is measured against today and the 56-day demand window slides.
**Re-run `bun run scripts/seed-mock-data.ts --reset` shortly before recording**, then re-check the
numbers, or just read them off the screen as you go.

---

## Before you hit record

| | |
| --- | --- |
| Server | `bun run dev` — **not** a production build. The demo login cards are dev-only by design |
| Sign in | `admin` / `StockSense#2026` (owner). Have `staff` ready in a second browser profile |
| Window | 1920×1080, browser zoom 100%, devtools closed, bookmarks bar hidden |
| Theme | Record in dark. Switch to light once, on the Dashboard, to show the toggle |
| Data | 3 warehouses · 10 locations · 25 products · 89 documents · 379 ledger rows |

Have these references pasted somewhere you can see: **`REC/2026/0088`** (the reversal),
**`DEL/2026/0074`** (what it reverses), **`DEL/2026/0089`** (the cancelled order).

Total runtime target: **6 minutes**. A 90-second cut is at the end.

---

## Scene 1 — The problem (0:00–0:25)

> **SAY:** "Most inventory tools tell you how much stock you have. Almost none tell you when you'll
> run out. StockSense is built around that one question — and around being able to prove every
> number it shows you."

**ACTION:** Sit on the sign-in screen. Don't click yet.

---

## Scene 2 — Sign in and roles (0:25–0:55)

**ACTION:** Point at the three demo cards. Click **Admin User**.

> **SAY:** "Three roles, and they're not cosmetic. Owner runs the team, manager runs operations,
> staff records movements. Every one of those limits is a row-level security policy in Postgres — the
> database refuses the action, so it holds no matter how the request is made. I'll prove that later."

**ACTION:** Once loaded, point at the user chip top-right: name, role, green live dot.

> **SAY:** "On a shared terminal you can always see who's signed in before you touch anything."

---

## Scene 3 — Dashboard (0:55–1:40)

**ACTION:** Let the six cards land. Point along them.

> **SAY:** "Fifteen products in stock, nine low, one out. Four receipts, four deliveries and three
> transfers still open."

**ACTION:** Scroll to **Time to stockout** on the right.

> **SAY:** "This is the part that matters. Not 'Welding Rod is low' — **Welding Rod runs out in three
> days**. Gasket Set is already out. Control Cable and Nitrile Gloves have six days. Sorted by
> urgency, because that's the order you'd actually act in."

**ACTION:** Collapse the sidebar with the top-left toggle, expand it again. Toggle light mode, then back.

> **SAY:** "Collapsible rail, and both themes run off one set of tokens — every screen switches together."

---

## Scene 4 — Replenishment (1:40–2:50) ← the centrepiece

**ACTION:** Click **Replenishment**.

> **SAY:** "Eleven products need attention. For each one: what's on hand, time to stockout, the demand
> behind it, and a confidence rating."

**ACTION:** Point at **Welding Rod 2.5mm** — 26 packs, 3 days, high, suggest 159.

> **SAY:** "High confidence, because it ships steadily. Twenty-six packs left, three days of runway,
> order a hundred and fifty-nine."

**ACTION:** Point at **Safety Helmet** — 46 units, 9 days, **low** confidence.

> **SAY:** "Now the honest bit. Same nine-day runway as Steel Rod, but this one says **low**
> confidence — helmet demand is erratic, so that number is a starting point for a human decision, not
> a forecast. A tool that hid this would be lying to you."

**ACTION:** Point at **Pump Seal Kit** — medium confidence.

> **SAY:** "Medium: six movements, seventy-seven percent week-to-week swing."

**ACTION:** Scroll to **Paint Drum 20L**.

> **SAY:** "And this one just says *no recent demand*. It refuses to invent a forecast from nothing."

**ACTION:** Tick two products, choose a location, click **Create draft receipt**.

> **SAY:** "Approving creates a **draft**. Nothing moves. A person still has to validate it — the
> system never quietly places an order on your behalf."

**ACTION:** Read the footnote aloud briefly.

> **SAY:** "It also states what it doesn't know: no supplier lead times, no minimum order quantities,
> so they're excluded rather than faked."

---

## Scene 5 — Stock insights (2:50–3:30)

**ACTION:** Click **Stock insights** → select **Central Warehouse** → **Analyze**.

> **SAY:** "2,879 units on hand, 7,356 shipped in fifty-six days, twenty-two written off by stock
> counts."

**ACTION:** Walk down the findings.

> **SAY:** "One out of stock. Three inside seven days. Six inside fourteen. Twenty-two units written
> off — worth knowing whether that's damage or miscounting. And two products that haven't shipped at
> all, which is working capital sitting still."

**ACTION:** Expand **How is this calculated?**

> **SAY:** "There's no AI here. It's arithmetic over your own ledger, and it shows its working. That's
> deliberate — a stock recommendation nobody can audit isn't much use."

**ACTION:** Switch to **North Workshop**, analyze.

> **SAY:** "And it only reports on products a warehouse actually handles. Nothing's been received
> here, so it says so instead of inventing twenty-five phantom stockouts."

---

## Scene 6 — Operations (3:30–4:20)

**ACTION:** Click **Receipts** → open a draft.

> **SAY:** "Receipts, deliveries, internal transfers, adjustments. Everything is a document. Stock
> only moves when one is validated."

**ACTION:** Click **Deliveries**. Point at one `waiting` and one `ready`.

> **SAY:** "Deliveries walk pick, then pack, then dispatch — and stock only leaves on dispatch, not
> when someone starts picking. This one's picked, that one's packed and waiting to go."

**ACTION:** Open `DEL/2026/0089`.

> **SAY:** "This one was cancelled before picking. It stays in the record."

**ACTION:** Click **Products**, point at the **Runway** column.

> **SAY:** "Twenty-five products, and the runway travels with them. Adding a product with opening
> stock posts a real receipt — there's no back door that edits a balance directly."

**ACTION:** Click **Warehouses**.

> **SAY:** "Three warehouses, ten locations — shelves, racks, goods-in, quarantine."

---

## Scene 7 — Audit trail and reversal (4:20–5:10) ← the trust beat

**ACTION:** Click **Move history**.

> **SAY:** "Three hundred and seventy-nine movements. Every one: who, what, when, where — and **why**."

**ACTION:** Scroll to `REC/2026/0088`.

> **SAY:** "Here's a correction. This receipt reverses delivery `DEL/2026/0074` — customer refused
> delivery, stock returned to shelf."

**ACTION:** Open `DEL/2026/0074`, show the linked banner.

> **SAY:** "The original is still here, untouched, marked as reversed. Nothing was edited and nothing
> was deleted. A mistake becomes an equal and opposite movement, so the history still reconciles —
> that's how stock accounting actually has to work. And the reason is recorded, because a correction
> without a reason is just a mystery."

**ACTION:** Click **Reverse** on any validated document to show the required-reason modal. Cancel out.

---

## Scene 8 — Roles, proven (5:10–5:45)

**ACTION:** Click **Team**.

> **SAY:** "As owner I can see the team. Five people, their roles, and exactly what each role grants.
> Anyone who registers lands as **pending** — no access to a single row — until I grant them a role.
> Registering alone gets you nothing."

**ACTION:** Switch to the second browser signed in as **staff**.

> **SAY:** "Same app as Sam, who's staff. No Team in the sidebar."

**ACTION:** Go to **Products**.

> **SAY:** "No New Product button, no edit, no archive. And this isn't a hidden button — the database
> refuses it. If Sam crafted the request by hand, Postgres would reject it with a policy violation."

**ACTION:** Open **Profile**.

> **SAY:** "Every role states plainly what it can and can't do."

---

## Scene 9 — Close (5:45–6:00)

> **SAY:** "Time to stockout instead of a stock level. Confidence on every suggestion, including when
> it's low. An append-only ledger where corrections are counter-documents, not edits. And permissions
> the database enforces rather than the interface implies. That's StockSense."

---

## 90-second cut

Use scenes **3 → 4 → 7**, in that order, and nothing else:

1. **0:00–0:20** Dashboard, Time to stockout. "Not *low* — *three days*."
2. **0:20–1:00** Replenishment. Welding Rod high confidence; Safety Helmet low confidence; draft only, never auto-ordered.
3. **1:00–1:30** Move history, the reversal, both documents still present.

Those three beats are the ones that separate this from a CRUD app: the prediction, the honesty about
the prediction, and the audit trail.

---

## Notes

- **Don't** demo sign-up mid-video — the new account lands as `pending` and sees nothing, which
  stalls the flow. Describe it on the Team screen instead.
- If a number on screen disagrees with this script, trust the screen and read that out. The data is
  live and the window slides daily.
- The green dot on the avatar is a live-session indicator, worth a half-sentence if you have room.
