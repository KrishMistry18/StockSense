/**
 * Reports an error caught by a React error boundary.
 *
 * Production React does not rethrow boundary-caught errors to `window.onerror`, so without this
 * they would vanish silently. This logs them with enough context to be useful and is the single
 * place to wire up an error-tracking service later.
 */
export function reportBoundaryError(error: unknown, context: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;

  // Loaders and server functions commonly throw a raw Response, whose String() form is the
  // useless "[object Response]" — pull the status and URL out instead.
  const message =
    error instanceof Response
      ? `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);

  console.error("[StockSense] Unhandled UI error:", message, {
    route: window.location.pathname,
    ...context,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}
