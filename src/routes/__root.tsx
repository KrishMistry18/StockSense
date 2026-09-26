import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportBoundaryError } from "../lib/report-error";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportBoundaryError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  const isMissingSupabase = error?.message?.includes("Missing Supabase environment variable");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {isMissingSupabase ? "Supabase Configuration Required" : "This page didn't load"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isMissingSupabase
            ? "StockSense needs your Supabase backend URL and anon key to connect to your inventory database."
            : "Something went wrong on our end. You can try refreshing or head back home."}
        </p>

        {isMissingSupabase && (
          <div className="mt-5 space-y-4 text-left">
            <div className="rounded-lg bg-muted/60 p-4 font-mono text-xs text-muted-foreground border">
              <p className="font-semibold text-foreground mb-2">
                Create a <code>.env</code> file with:
              </p>
              <p className="text-primary font-medium">
                VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
              </p>
              <p className="text-primary font-medium">
                VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_ANON_KEY
              </p>
              <p className="text-primary font-medium">
                SUPABASE_URL=https://YOUR_PROJECT.supabase.co
              </p>
              <p className="text-primary font-medium">SUPABASE_PUBLISHABLE_KEY=YOUR_ANON_KEY</p>
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p>
                1. Copy <code>.env.example</code> to <code>.env</code> in the project root.
              </p>
              <p>2. Fill in your project URL and publishable anon key from Supabase.</p>
              <p>
                3. Run <code>scripts/schema.sql</code> in your Supabase SQL editor to create the
                tables.
              </p>
              <p>
                4. Restart the dev server after editing <code>.env</code>.
              </p>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "StockSense" },
      {
        name: "description",
        content: "Real-time inventory operations for modern warehouse teams.",
      },
      { name: "author", content: "StockSense" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    document.documentElement.dataset["theme"] =
      window.localStorage.getItem("stocksense-theme") === "light" ? "light" : "dark";
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
