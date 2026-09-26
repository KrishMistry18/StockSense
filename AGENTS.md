<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- Keep StockSense as a single signed-in operational workspace with RLS-backed shared-company data, because inventory movements must stay consistent across staff.
- Keep theme selection in the browser and apply shared semantic CSS tokens to both modes, because every workspace screen must switch appearance consistently without changing inventory data.
- Keep AI inventory advice in authenticated server functions with workspace-scoped reads, because stock data and AI credentials must not leak across companies or to the browser.
- Treat product deletion as a guarded archive and preserve completed documents and ledger rows, because historical stock accounting must remain auditable.
