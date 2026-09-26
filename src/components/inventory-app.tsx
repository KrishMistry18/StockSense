import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Boxes, Building2,
  ClipboardCheck, Gauge, History, LogOut, Menu, Package, Plus, Search,
  TriangleAlert, UserRound, Warehouse, X, Moon, Sun, Sparkles, Archive, Trash2, Pencil,
  Timer, RotateCcw, ShieldCheck, Info, Lock, PanelLeftClose, PanelLeftOpen, Users, UserCheck, UserMinus, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { analyzeWarehouse } from "@/lib/warehouse-ai.functions";
import { registerAccount } from "@/lib/account.functions";
import { useServerFn } from "@tanstack/react-start";
import type { User } from "@supabase/supabase-js";
import { buildDemand, daysToStockout, formatRunway, runwayTone, suggestedQuantity, COVER_DAYS, DEMAND_WINDOW_DAYS, NO_DEMAND, RISK_DAYS, type DemandLeg, type ProductDemand } from "@/lib/replenishment";
import { canReverse, findReversal, parseReversal, reverseOperation } from "@/lib/reversal";
import type { WarehouseAnalysis } from "@/lib/warehouse-analysis";

type View = "dashboard" | "replenishment" | "insights" | "products" | "receipts" | "deliveries" | "transfers" | "adjustments" | "history" | "warehouses" | "team" | "profile";
type Workspace = { id: string; name: string; join_code: string };
type Product = { id: string; name: string; sku: string; category: string; unit: string; reorder_point: number; archived: boolean };
type Location = { id: string; name: string; code: string; warehouse_id: string; warehouses?: { name: string } | null };
type Balance = { product_id: string; location_id: string; quantity: number };
type Operation = { id: string; reference: string; kind: string; status: string; contact: string; notes: string; created_at: string; source_location_id: string | null; destination_location_id: string | null; picked_at: string | null; packed_at: string | null };
type OperationProduct = { operation_id: string; product_id: string };
/**
 * Workspace roles. The database is the authority — managers-only rules live in RLS policies — and
 * the UI mirrors them so a member is never offered an action the server will refuse.
 */
type Role = "manager" | "staff";
const CAN: Record<Role, { catalogue: boolean; warehouses: boolean; reverse: boolean; purchase: boolean }> = {
  manager: { catalogue: true, warehouses: true, reverse: true, purchase: true },
  staff: { catalogue: false, warehouses: false, reverse: false, purchase: false },
};
const STAFF_LOCKED = "Managers only. Your role can record and validate stock movements.";
type Ledger = { id: string; delta: number; balance_after: number; created_at: string; created_by: string; operation_id: string | null; products?: { name: string; sku: string } | null; locations?: { name: string } | null; operations?: { reference: string; kind: string; notes: string } | null };

const nav: { label: string; view: View; icon: typeof Gauge }[] = [
  { label: "Dashboard", view: "dashboard", icon: Gauge }, { label: "Replenishment", view: "replenishment", icon: Timer }, { label: "AI insights", view: "insights", icon: Sparkles }, { label: "Products", view: "products", icon: Package },
  { label: "Receipts", view: "receipts", icon: ArrowDownToLine }, { label: "Deliveries", view: "deliveries", icon: ArrowUpFromLine },
  { label: "Internal transfers", view: "transfers", icon: ArrowLeftRight }, { label: "Adjustments", view: "adjustments", icon: ClipboardCheck },
  { label: "Move history", view: "history", icon: History }, { label: "Warehouses", view: "warehouses", icon: Warehouse },
];
/** Manager-only screens, appended to the navigation for managers only. */
const managerNav: { label: string; view: View; icon: typeof Gauge }[] = [
  { label: "Team", view: "team", icon: Users },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = window.localStorage.getItem("stocksense-theme");
    const next = saved === "light" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset['theme'] = next;
  }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset['theme'] = next;
    window.localStorage.setItem("stocksense-theme", next);
  }
  return <Button type="button" variant="ghost" size="icon" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggle}>{theme === "dark" ? <Sun /> : <Moon />}</Button>;
}

export function InventoryApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [view, setView] = useState<View>("dashboard");
  const [sidebar, setSidebar] = useState(false);
  // Desktop-only rail collapse. Read after mount so the server render and the first client render
  // agree; reading localStorage during render would hydrate mismatched markup.
  const [collapsed, setCollapsed] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [operationProducts, setOperationProducts] = useState<OperationProduct[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [demandLegs, setDemandLegs] = useState<DemandLeg[]>([]);
  const [actors, setActors] = useState<Record<string, string>>({});
  const [role, setRole] = useState<Role>("staff");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const { data: memberships } = await supabase.from("workspace_members").select("role, workspace_id, workspaces(id,name,join_code)").limit(1);
    const membership = memberships?.[0];
    const selected = membership?.workspaces as Workspace | null | undefined;
    // A pending member can read their own membership row but not the workspace behind it, which is
    // how "waiting for approval" is told apart from "not in a workspace at all".
    setPending(membership?.role === "pending");
    if (!selected) { setWorkspace(null); setDataLoading(false); return; }
    setWorkspace(selected);
    setRole(membership?.role === "manager" ? "manager" : "staff");
    const demandSince = new Date(Date.now() - DEMAND_WINDOW_DAYS * 86400000).toISOString();
    const [p, l, b, o, h, oi, d] = await Promise.all([
      supabase.from("products").select("id,name,sku,category,unit,reorder_point,archived").eq("workspace_id", selected.id).order("name"),
      supabase.from("locations").select("id,name,code,warehouse_id,warehouses(name)").eq("workspace_id", selected.id).order("name"),
      supabase.from("stock_balances").select("product_id,location_id,quantity").eq("workspace_id", selected.id),
      supabase.from("operations").select("id,reference,kind,status,contact,notes,created_at,source_location_id,destination_location_id,picked_at,packed_at").eq("workspace_id", selected.id).order("created_at", { ascending: false }),
      supabase.from("stock_ledger").select("id,delta,balance_after,created_at,created_by,operation_id,products(name,sku),locations(name),operations(reference,kind,notes)").eq("workspace_id", selected.id).order("created_at", { ascending: false }).limit(200),
      supabase.from("operation_items").select("operation_id,product_id").eq("workspace_id", selected.id),
      supabase.from("stock_ledger").select("product_id,delta,created_at,operations(kind)").eq("workspace_id", selected.id).gte("created_at", demandSince).order("created_at", { ascending: false }).limit(4000),
    ]);
    const history = (h.data ?? []) as Ledger[];
    setProducts((p.data ?? []) as Product[]); setLocations((l.data ?? []) as Location[]); setBalances((b.data ?? []) as Balance[]);
    setOperations((o.data ?? []) as Operation[]); setLedger(history); setOperationProducts((oi.data ?? []) as OperationProduct[]);
    setDemandLegs(((d.data ?? []) as { product_id: string; delta: number; created_at: string; operations?: { kind: string } | null }[]).map((row) => ({ product_id: row.product_id, delta: Number(row.delta), created_at: row.created_at, kind: row.operations?.kind ?? null })));
    // Names are best-effort: a workspace can only read the profiles it is allowed to see, so the
    // audit trail falls back to a short member id rather than hiding who made the movement.
    const actorIds = [...new Set(history.map((row) => row.created_by).filter(Boolean))];
    if (actorIds.length) {
      const { data: people } = await supabase.from("profiles").select("id,display_name").in("id", actorIds);
      setActors(Object.fromEntries((people ?? []).filter((person) => person.display_name).map((person) => [person.id, person.display_name])));
    } else setActors({});
    setDataLoading(false);
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => { setUser(data.user); setAuthLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((event, session) => { if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) setUser(session?.user ?? null); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (user) { setDataLoading(true); void load(); } else { setWorkspace(null); setProducts([]); setOperations([]); setBalances([]); setLedger([]); setDemandLegs([]); setActors({}); } }, [user?.id, load]);

  useEffect(() => { setCollapsed(window.localStorage.getItem("stocksense-sidebar") === "collapsed"); }, []);
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem("stocksense-sidebar", next ? "collapsed" : "expanded");
  }

  const demandByProduct = useMemo(() => buildDemand(demandLegs), [demandLegs]);

  if (authLoading) return <div className="auth-grid grid min-h-screen place-items-center text-muted-foreground">Loading StockSense…</div>;
  if (!user) return <AuthScreen />;
  if (dataLoading) return <div className="auth-grid grid min-h-screen place-items-center text-muted-foreground">Loading inventory…</div>;
  if (pending && !workspace) return <PendingApproval user={user} onRefresh={load} />;
  if (!workspace) return <WorkspaceSetup onReady={load} />;

  const quantity = (id: string) => balances.filter((b) => b.product_id === id).reduce((n, b) => n + Number(b.quantity), 0);
  const demandFor = (id: string) => demandByProduct.get(id) ?? NO_DEMAND;
  const balanceAt = (productId: string, locationId: string) => Number(balances.find((b) => b.product_id === productId && b.location_id === locationId)?.quantity ?? 0);
  const can = CAN[role];
  const contentProps = { workspace, products, locations, balances, operations, operationProducts, ledger, quantity, demandFor, balanceAt, actors, userId: user.id, role, can, load, setBusy, setError, search, setView };
  return (
    <div className="app-shell min-h-screen text-foreground lg:flex">
      {/* Collapse applies only from lg up: the mobile drawer is always full width, since a 72px
          overlay would be useless. */}
      <aside className={`${sidebar ? "fixed inset-y-0 left-0 z-40 flex" : "hidden"} app-sidebar w-64 shrink-0 flex-col transition-[width] duration-200 lg:sticky lg:top-0 lg:flex lg:h-screen ${collapsed ? "lg:w-[72px]" : "lg:w-64"}`}>
        <div className={`flex h-20 items-center gap-3 border-b px-5 ${collapsed ? "lg:justify-center lg:px-0" : ""}`}><div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Boxes className="size-5" /></div><div className={collapsed ? "lg:hidden" : ""}><div className="font-display text-base font-semibold">StockSense</div><div className="text-[11px] text-muted-foreground">Inventory workspace</div></div><Button variant="ghost" size="icon" className="ml-auto lg:hidden" onClick={() => setSidebar(false)}><X /></Button></div>
        <div className={`px-5 pb-2 pt-7 text-[10px] font-bold uppercase text-muted-foreground ${collapsed ? "lg:hidden" : ""}`}>Workspace</div><nav className={`flex-1 space-y-1 overflow-y-auto px-3 pb-4 ${collapsed ? "lg:pt-7" : ""}`}>{[...nav, ...(can.warehouses ? managerNav : [])].map((item) => <Button key={item.view} variant="ghost" title={item.label} className={`h-11 w-full justify-start gap-3 ${collapsed ? "lg:justify-center lg:px-0" : ""} ${view === item.view ? "nav-active" : "text-muted-foreground"}`} onClick={() => { setView(item.view); setSidebar(false); }}><item.icon /><span className={collapsed ? "lg:hidden" : ""}>{item.label}</span></Button>)}</nav>
        <div className="border-t p-3"><Button variant="ghost" title={`${user.user_metadata['display_name'] || user.email} · ${role}`} className={`mb-1 h-auto w-full justify-start py-2 ${collapsed ? "lg:justify-center lg:px-0" : ""}`} onClick={() => setView("profile")}><UserRound /><span className={`min-w-0 text-left ${collapsed ? "lg:hidden" : ""}`}><span className="block truncate">{user.user_metadata['display_name'] || user.email}</span><span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{role}</span></span></Button><Button variant="ghost" title="Log out" className={`w-full justify-start text-muted-foreground ${collapsed ? "lg:justify-center lg:px-0" : ""}`} onClick={async () => { await supabase.auth.signOut(); }}><LogOut /><span className={collapsed ? "lg:hidden" : ""}>Log out</span></Button></div>
      </aside>
      {sidebar && <Button aria-label="Close menu" variant="ghost" className="fixed inset-0 z-30 h-auto w-full rounded-none bg-background/70 lg:hidden" onClick={() => setSidebar(false)} />}
      <main className="min-w-0 flex-1">
        <header className="app-header sticky top-0 z-20 flex min-h-20 items-center gap-3 px-4 md:px-8"><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setSidebar(true)}><Menu /></Button><Button variant="ghost" size="icon" className="hidden lg:flex" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button><div className="relative max-w-xl flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"/><input className="field field-search" aria-label="Search inventory" value={search} placeholder="Search products, SKU, or reference…" onChange={(e) => setSearch(e.target.value)} /></div><div className="hidden text-right lg:block"><div className="text-sm font-semibold">{workspace.name}</div><div className="text-xs text-muted-foreground">Inventory workspace</div></div><ThemeToggle />
          {/* Who is signed in right now, not just an initial — name and role, with a live dot. */}
          <button type="button" className="user-chip" onClick={() => setView("profile")} title={`Signed in as ${user.user_metadata['display_name'] || user.email} (${role}) — open profile`}><span className="user-chip-avatar">{(user.user_metadata['display_name'] || user.email || "U")[0].toUpperCase()}<span className="user-chip-dot" aria-hidden="true" /></span><span className="hidden min-w-0 text-left sm:block"><span className="block truncate text-sm font-semibold leading-tight">{user.user_metadata['display_name'] || user.email}</span><span className="block text-[10px] font-bold uppercase tracking-wider text-primary">{role}</span></span><span className="sr-only">Signed in as {user.user_metadata['display_name'] || user.email}, role {role}</span></button></header>
        <div className="p-4 pb-24 md:p-8 lg:pb-8">
          {error && <div role="alert" className="fixed right-4 top-24 z-[70] flex max-w-md items-start justify-between gap-3 rounded-md border border-destructive/40 bg-card p-4 text-sm text-destructive shadow-lg"><span>{error}</span><Button size="icon" variant="ghost" aria-label="Dismiss error" onClick={() => setError("")}><X /></Button></div>}
          {view === "dashboard" && <Dashboard {...contentProps} />}
          {view === "replenishment" && <Replenishment {...contentProps} />}
          {view === "insights" && <WarehouseInsights workspace={workspace} locations={locations} />}
           {view === "products" && <Products {...contentProps} />}
          {["receipts","deliveries","transfers","adjustments"].includes(view) && <Operations {...contentProps} kind={view === "receipts" ? "receipt" : view === "deliveries" ? "delivery" : view === "transfers" ? "transfer" : "adjustment"} />}
          {view === "history" && <HistoryView {...contentProps} />}
          {view === "warehouses" && <Warehouses {...contentProps} />}
          {view === "team" && (can.warehouses ? <Team {...contentProps} /> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-4"/>{STAFF_LOCKED}</p>)}
          {view === "profile" && <Profile user={user} workspace={workspace} role={role} />}
          {busy && <div className="modal-overlay fixed inset-0 z-50 grid place-items-center"><div className="modal-panel px-6 py-5 text-sm">Updating inventory…</div></div>}
        </div>
      </main>
      <nav aria-label="Mobile navigation" className="app-mobile-nav fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 lg:hidden"><Button variant="ghost" className={`h-14 flex-col gap-1 px-1 text-[10px] ${view === "dashboard" ? "text-primary" : "text-muted-foreground"}`} onClick={() => setView("dashboard")}><Gauge />Home</Button><Button variant="ghost" className={`h-14 flex-col gap-1 px-1 text-[10px] ${view === "products" ? "text-primary" : "text-muted-foreground"}`} onClick={() => setView("products")}><Package />Products</Button><Button title="New receipt" aria-label="New receipt" className="mx-auto size-12 rounded-md" onClick={() => setView("receipts")}><Plus /></Button><Button variant="ghost" className={`h-14 flex-col gap-1 px-1 text-[10px] ${view === "history" ? "text-primary" : "text-muted-foreground"}`} onClick={() => setView("history")}><History />History</Button><Button variant="ghost" className="h-14 flex-col gap-1 px-1 text-[10px] text-muted-foreground" onClick={() => setSidebar(true)}><Menu />More</Button></nav>
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,29}$/i;
/**
 * Supabase authenticates by email address only — there is no username credential — so a bare
 * name like "admin" is mapped onto a reserved local domain. Sign-up and sign-in apply the same
 * mapping, so "admin" stays a stable credential. Reserved by RFC 6762, so it can never collide
 * with a real address.
 */
const USERNAME_DOMAIN = "stocksense.local";
function resolveIdentifier(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  if (EMAIL_RE.test(id)) return id;
  if (USERNAME_RE.test(id)) return `${id}@${USERNAME_DOMAIN}`;
  return null;
}
const isUsernameAddress = (address: string) => address.endsWith(`@${USERNAME_DOMAIN}`);
const CONFIRM_HINT = "Turn off “Confirm email” in your backend auth settings (Authentication → Sign In / Providers → Email) to let accounts in immediately.";

type Notice = { tone: "error" | "info"; text: string };
function NoticeBox({tone,text}:Notice) {
  return <p role={tone==="error"?"alert":"status"} className={`notice ${tone==="error"?"notice-error":"notice-info"}`}>{tone==="error"?<TriangleAlert className="mt-px size-4 shrink-0"/>:<Info className="mt-px size-4 shrink-0"/>}<span>{text}</span></p>;
}

type DemoAccount = { username: string; name: string; initial: string; role: "manager" | "staff"; blurb: string };
const DEMO_ACCOUNTS: DemoAccount[] = [
  { username: "admin", name: "Admin User", initial: "A", role: "manager", blurb: "Full access to everything." },
  { username: "manager", name: "Maya Manager", initial: "M", role: "manager", blurb: "Edits catalogue, approves reorders." },
  { username: "staff", name: "Sam Stockroom", initial: "S", role: "staff", blurb: "Records movements only." },
];
const DEMO_PASSWORD = "StockSense#2026";
/** Off by default in a production build: these credentials ship to the browser. */
const DEMO_LOGINS_ENABLED = import.meta.env.DEV || import.meta.env['VITE_ENABLE_DEMO_LOGINS'] === "true";
const DEMO_SETUP_HINT = "Run “bun run scripts/create-demo-users.ts” to create them. If you just changed .env, restart the dev server — Vite only reads it at startup.";

function AuthScreen() {
  const register = useServerFn(registerAccount);
  const [mode, setMode] = useState<"login"|"signup"|"forgot">("login"); const [identifier,setIdentifier]=useState(""); const [password,setPassword]=useState(""); const [name,setName]=useState(""); const [notice,setNotice]=useState<Notice|null>(null); const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState(""); const [demoNotice,setDemoNotice]=useState<Notice|null>(null);
  const fail=(text:string)=>setNotice({tone:"error",text}); const inform=(text:string)=>setNotice({tone:"info",text});

  /**
   * Signs straight in as a demo account, creating it on first use.
   *
   * The account will not exist on a fresh backend, so a failed sign-in is expected rather than
   * exceptional: provision it, then sign in again. If the backend still enforces email
   * confirmation the retry cannot succeed, and that is the one case worth reporting.
   */
  async function enterAs(account: DemoAccount) {
    setPending(account.username); setDemoNotice(null); setNotice(null);
    const email = `${account.username}@${USERNAME_DOMAIN}`;
    const direct = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
    if(!direct.error) return;                      // the auth listener swaps in the workspace
    const created = await supabase.auth.signUp({ email, password: DEMO_PASSWORD, options: { data: { display_name: account.name } } });
    if(created.data.session) return;
    const retry = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
    if(!retry.error) return;
    setPending("");
    setDemoNotice({ tone: "error", text: `Could not enter as ${account.name}: ${retry.error.message}. ${DEMO_SETUP_HINT}` });
  }

  async function submit(e: FormEvent) { e.preventDefault(); setBusy(true); setNotice(null);
    const address = resolveIdentifier(identifier);
    if(!address){ fail("Enter an email address, or a username of 2–30 characters using letters, numbers, dot, dash, or underscore."); setBusy(false); return; }
    if(mode!=="forgot" && password.length<8){ fail("Use a password of at least 8 characters."); setBusy(false); return; }
    if(mode==="forgot") {
      if(isUsernameAddress(address)){ fail("A reset link needs a real email address — a username has no inbox to send it to."); setBusy(false); return; }
      const {error}=await supabase.auth.resetPasswordForEmail(address,{redirectTo:`${window.location.origin}/reset-password`});
      if(error)fail(error.message); else inform("Check your email for the secure reset link."); }
    else if(mode==="signup") {
      // Registration goes through a server function that creates the account already confirmed, so
      // it completes in one step rather than parking the person on "check your email". A new account
      // holds no workspace membership, so it can read nothing until a manager grants a role.
      try { await register({data:{identifier:identifier.trim(),password,displayName:name.trim()||identifier.trim()}}); }
      catch(err){ fail(err instanceof Error?err.message:"Could not create the account."); setBusy(false); return; }
      const {error:signInError}=await supabase.auth.signInWithPassword({email:address,password});
      if(signInError)fail(`Account created, but signing in failed: ${signInError.message}`); else setNotice(null);
    }
    else { const {error}=await supabase.auth.signInWithPassword({email:address,password});
      if(error)fail(/confirm/i.test(error.message)?`This account has not been confirmed yet. ${CONFIRM_HINT}`:error.message); }
    setBusy(false);
  }
  return <div className="auth-grid min-h-screen"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6 md:px-10"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground"><Boxes className="size-5" /></div><h1 className="font-display text-xl font-semibold">StockSense</h1></div><ThemeToggle /></div><div className="mx-auto grid min-h-[calc(100vh-100px)] w-full max-w-6xl items-center gap-12 px-5 pb-12 md:grid-cols-[1fr_430px] md:px-10"><section className="max-w-xl"><p className="eyebrow mb-6">Inventory, in focus</p><h2 className="font-display text-4xl font-semibold leading-[1.2] md:text-5xl">Clarity in every movement.</h2><p className="mt-6 max-w-md text-base leading-7 text-muted-foreground">Know what’s on hand, what needs attention, and where everything is going.</p><div className="mt-10 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="border-l-2 border-primary pl-3">Live stock</span><span className="border-l-2 border-primary pl-3">Every location</span><span className="border-l-2 border-primary pl-3">A clear record</span></div>
  {DEMO_LOGINS_ENABLED&&<div className="mt-12"><p className="eyebrow mb-3">Demo accounts</p><p className="mb-4 max-w-md text-xs leading-5 text-muted-foreground">One click signs you in. Each role has different permissions, enforced by the database rather than by hiding buttons.</p>{demoNotice&&<div className="mb-4 max-w-md"><NoticeBox {...demoNotice}/></div>}<div className="grid gap-3 sm:grid-cols-3">{DEMO_ACCOUNTS.map(a=><button key={a.username} type="button" onClick={()=>enterAs(a)} disabled={!!pending} aria-label={`Sign in as ${a.name}, ${a.role}`} className={`demo-card ${pending===a.username?"demo-card-active":""}`}><span className="flex items-center gap-2.5"><span className="demo-avatar">{a.initial}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{a.name}</span><span className="block text-[11px] text-muted-foreground">@{a.username}</span></span></span><span className={`tag mt-3 ${a.role==="manager"?"tag-in":"tag-draft"}`}>{a.role}</span><span className="mt-2 block text-[11px] leading-4 text-muted-foreground">{a.blurb}</span><span className="demo-cta">{pending===a.username?"Signing in…":"Enter workspace →"}</span></button>)}</div></div>}</section><form onSubmit={submit} className="auth-surface p-7 md:p-9"><p className="eyebrow mb-3">Your workspace</p><h2 className="font-display text-2xl font-semibold">{mode==="login"?"Welcome back":mode==="signup"?"Create your account":"Reset password"}</h2><p className="mb-7 mt-2 text-sm text-muted-foreground">{mode==="forgot"?"We’ll email you a secure recovery link.":mode==="signup"?"Create your account, then ask a manager for access to the workspace.":"Sign in to pick up where you left off."}</p>{mode==="signup"&&<label className="mb-4 block text-xs font-medium">Full name<input className="field mt-2" maxLength={100} value={name} onChange={e=>setName(e.target.value)} required /></label>}<label className="mb-4 block text-xs font-medium">{mode==="forgot"?"Email":"Email or username"}<input className="field mt-2" type={mode==="forgot"?"email":"text"} inputMode="email" autoComplete={mode==="signup"?"username":"email"} spellCheck={false} maxLength={255} value={identifier} onChange={e=>setIdentifier(e.target.value)} required /></label>{mode!=="forgot"&&<label className="mb-5 block text-xs font-medium">Password<input className="field mt-2" type="password" minLength={8} maxLength={72} value={password} onChange={e=>setPassword(e.target.value)} required /></label>}{notice&&<div className="mb-4"><NoticeBox {...notice}/></div>}<Button className="h-11 w-full" disabled={busy}>{busy?"Please wait…":mode==="login"?"Sign in":mode==="signup"?"Create account":"Send reset link"}</Button><div className="mt-6 flex justify-between text-xs"><Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={()=>{setMode(mode==="signup"?"login":"signup");setNotice(null)}}>{mode==="signup"?"Already have an account?":"Create account"}</Button><Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={()=>{setMode(mode==="forgot"?"login":"forgot");setNotice(null)}}>{mode==="forgot"?"Back to sign in":"Forgot password?"}</Button></div></form></div></div>;
}

/** Shown to someone who has requested access but has no role yet, so they see nothing. */
function PendingApproval({user,onRefresh}:{user:User;onRefresh:()=>Promise<void>}) {
  const [checking,setChecking]=useState(false);
  return <div className="auth-grid grid min-h-screen place-items-center p-5"><div className="auth-surface w-full max-w-lg p-7 md:p-8"><p className="eyebrow mb-3">Access requested</p><h1 className="font-display text-2xl font-semibold">Waiting for approval</h1>
  <p className="mt-3 text-sm leading-6 text-muted-foreground">Your account is set up and you have asked to join the workspace. A manager needs to grant you a role before any stock data becomes visible.</p>
  <div className="mt-6 space-y-2 rounded-xl border p-4 text-sm"><div className="flex justify-between gap-4"><span className="text-muted-foreground">Signed in as</span><span className="font-medium">{user.user_metadata['display_name']||user.email}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Email</span><span className="font-medium">{user.email}</span></div><div className="flex justify-between gap-4"><span className="text-muted-foreground">Status</span><span className="tag tag-waiting"><Clock className="size-3"/>Pending</span></div></div>
  <p className="mt-5 text-xs leading-5 text-muted-foreground">This is enforced by the database, not by the screen you are looking at: until a manager assigns your role, every query returns nothing.</p>
  <div className="mt-6 flex gap-2"><Button className="flex-1" disabled={checking} onClick={async()=>{setChecking(true);await onRefresh();setChecking(false);}}>{checking?"Checking…":"Check again"}</Button><Button variant="outline" onClick={async()=>{await supabase.auth.signOut();}}><LogOut/>Sign out</Button></div></div></div>;
}

type Member = { user_id: string; role: string; display_name: string; email: string };
/** Manager-only. Grants the role a newly registered account needs before it can see anything. */
function Team({workspace,userId,load,setBusy,setError}:Common) {
  const [members,setMembers]=useState<Member[]>([]);
  const [loading,setLoading]=useState(true);
  const [notice,setNotice]=useState<Notice|null>(null);

  const refresh=useCallback(async()=>{
    setLoading(true);
    const {data:rows,error}=await supabase.from("workspace_members").select("user_id,role").eq("workspace_id",workspace.id);
    if(error){setError(error.message);setLoading(false);return;}
    const ids=(rows??[]).map(r=>r.user_id);
    const {data:people}=ids.length?await supabase.from("profiles").select("id,display_name,email").in("id",ids):{data:[]};
    const byId=new Map((people??[]).map(p=>[p.id,p]));
    setMembers((rows??[]).map(r=>({user_id:r.user_id,role:r.role,display_name:byId.get(r.user_id)?.display_name||"Unnamed user",email:byId.get(r.user_id)?.email||""}))
      .sort((a,b)=>(a.role==="pending"?0:1)-(b.role==="pending"?0:1)||a.display_name.localeCompare(b.display_name)));
    setLoading(false);
  },[workspace.id,setError]);
  useEffect(()=>{void refresh()},[refresh]);

  async function apply(member:Member,next:string){
    setBusy(true);setNotice(null);
    const {error}=next==="remove"
      ? await supabase.rpc("remove_member",{workspace:workspace.id,target_user:member.user_id})
      : await supabase.rpc("set_member_role",{workspace:workspace.id,target_user:member.user_id,new_role:next});
    if(error)setNotice({tone:"error",text:error.message});
    else setNotice({tone:"info",text:next==="remove"?`${member.display_name} removed from the workspace.`:`${member.display_name} is now ${next}.`});
    await refresh(); await load(); setBusy(false);
  }

  const waiting=members.filter(m=>m.role==="pending").length;
  return <><Heading title="Team" subtitle="Who can reach this workspace, and what each of them is allowed to do."/>
  {notice&&<div className="mb-5 max-w-3xl"><NoticeBox {...notice}/></div>}
  {waiting>0&&<p className="mb-5 flex max-w-3xl items-start gap-2 rounded-xl border border-warning/40 bg-card p-4 text-sm"><Clock className="mt-0.5 size-4 shrink-0 text-warning"/><span><strong className="font-semibold">{waiting} {waiting===1?"person is":"people are"} waiting for access.</strong> They have registered and entered the invite code, but can see nothing until you give them a role.</span></p>}
  <div className="panel table-wrap"><table className="data-table"><thead><tr><th>Person</th><th>Email</th><th>Role</th><th>Grants</th><th>Actions</th></tr></thead><tbody>
    {loading&&<tr><td colSpan={5} className="text-muted-foreground">Loading team…</td></tr>}
    {!loading&&members.map(m=><tr key={m.user_id}>
      <td><div className="font-medium">{m.display_name}{m.user_id===userId&&<span className="ml-2 text-xs text-muted-foreground">(you)</span>}</div></td>
      <td className="text-muted-foreground">{m.email||"—"}</td>
      <td><span className={`tag ${m.role==="manager"?"tag-in":m.role==="staff"?"tag-draft":"tag-waiting"}`}>{m.role}</span></td>
      <td><div className="max-w-64 whitespace-normal text-xs text-muted-foreground">{m.role==="manager"?"Full access, including the catalogue, warehouses, purchasing and reversals.":m.role==="staff"?"Records and validates movements. Cannot change the catalogue or reverse documents.":"No access to any stock data."}</div></td>
      <td><div className="flex flex-wrap gap-2">
        {m.role!=="manager"&&<Button size="sm" variant="outline" onClick={()=>apply(m,"manager")}><UserCheck/>Make manager</Button>}
        {m.role!=="staff"&&<Button size="sm" variant="outline" onClick={()=>apply(m,"staff")}><UserCheck/>{m.role==="pending"?"Approve as staff":"Make staff"}</Button>}
        {m.role!=="pending"&&m.user_id!==userId&&<Button size="sm" variant="ghost" title="Revoke access, keep the account" onClick={()=>apply(m,"pending")}><Lock/>Revoke</Button>}
        {m.user_id!==userId&&<Button size="sm" variant="ghost" title="Remove from workspace" onClick={()=>{if(window.confirm(`Remove ${m.display_name}? Their recorded stock movements stay in the ledger.`))void apply(m,"remove")}}><UserMinus/></Button>}
      </div></td></tr>)}
    {!loading&&!members.length&&<tr><td colSpan={5} className="text-muted-foreground">Nobody else has joined yet.</td></tr>}
  </tbody></table></div>
  <div className="mt-5 max-w-3xl space-y-2 border-t pt-5 text-xs leading-5 text-muted-foreground">
    <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary"/><span>Share the invite code <strong className="font-mono text-primary">{workspace.join_code}</strong> so a new hire can request access. Registering alone gives nobody any visibility.</span></p>
    <p><strong className="font-semibold text-foreground">Enforced in the database.</strong> Roles are checked by row-level security policies, so revoking someone takes effect on their next query whatever screen they happen to be on. A workspace always keeps at least one manager, and you cannot remove your own manager access.</p>
    <p><strong className="font-semibold text-foreground">Removing someone preserves history.</strong> Documents and ledger rows they recorded stay exactly as they are, because stock accounting has to stay auditable.</p>
  </div></>;
}

function WorkspaceSetup({onReady}:{onReady:()=>Promise<void>}) { const [name,setName]=useState(""); const [code,setCode]=useState(""); const [error,setError]=useState(""); async function create(){if(name.trim().length<2)return setError("Enter a workspace name.");const {error}=await supabase.rpc("create_workspace",{workspace_name:name.trim()});if(error)setError(error.message);else await onReady();} async function join(){const {error}=await supabase.rpc("join_workspace",{code:code.trim()});if(error)setError(error.message);else await onReady();} return <div className="auth-grid grid min-h-screen place-items-center p-5"><div className="auth-surface w-full max-w-xl p-7 md:p-8"><div className="mb-6 flex items-center gap-3"><div className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground"><Building2/></div><div><h1 className="font-display text-xl font-semibold">Set up your workspace</h1><p className="text-sm text-muted-foreground">Create a company inventory or join your team.</p></div></div>{error&&<p className="mb-4 text-sm text-destructive">{error}</p>}<div className="grid gap-6 sm:grid-cols-2"><div><label className="text-xs font-medium">Company / workspace name</label><input className="field mt-2" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/><Button className="mt-3 w-full" onClick={create}>Create workspace</Button></div><div className="sm:border-l sm:pl-6"><label className="text-xs font-medium">Invitation code</label><input className="field mt-2 uppercase" maxLength={16} value={code} onChange={e=>setCode(e.target.value)}/><Button variant="outline" className="mt-3 w-full" onClick={join}>Join workspace</Button></div></div></div></div> }

type Common = {workspace:Workspace;products:Product[];locations:Location[];balances:Balance[];operations:Operation[];operationProducts:OperationProduct[];ledger:Ledger[];quantity:(id:string)=>number;demandFor:(id:string)=>ProductDemand;balanceAt:(productId:string,locationId:string)=>number;actors:Record<string,string>;userId:string;role:Role;can:(typeof CAN)[Role];load:()=>Promise<void>;setBusy:(b:boolean)=>void;setError:(s:string)=>void;search:string;setView:(v:View)=>void};
function Heading({title,subtitle,action}:{title:string;subtitle:string;action?:ReactNode}) { return <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{subtitle}</p></div>{action}</div> }
function Dashboard({ products, operations, operationProducts, balances, locations, quantity, demandFor, search, setView }: Common) {
  const [kind, setKind] = useState("all"); const [status, setStatus] = useState("all"); const [location, setLocation] = useState("all"); const [category, setCategory] = useState("all");
  const visibleProducts = products.filter(p => !p.archived && (category === "all" || p.category === category) && `${p.name} ${p.sku}`.toLowerCase().includes(search.toLowerCase()));
  const scopedLocations = location === "all" ? locations.map(l => l.id) : location.startsWith("warehouse:") ? locations.filter(l => l.warehouse_id === location.slice(10)).map(l => l.id) : [location.slice(9)];
  const stockAt = (id: string) => location === "all" ? quantity(id) : balances.filter(b => b.product_id === id && scopedLocations.includes(b.location_id)).reduce((sum,b) => sum + Number(b.quantity), 0);
  const categoryProductIds = new Set(products.filter(p => p.category === category).map(p => p.id));
  // Anything below its threshold *or* projected to run out inside the risk horizon, soonest first.
  const attention = visibleProducts.map(p => { const onHand = stockAt(p.id); return { product: p, onHand, runway: daysToStockout(onHand, demandFor(p.id).dailyDemand) }; })
    .filter(row => row.onHand <= Number(row.product.reorder_point) || (row.runway !== null && row.runway <= RISK_DAYS))
    .sort((a, b) => (a.runway ?? Number.POSITIVE_INFINITY) - (b.runway ?? Number.POSITIVE_INFINITY));
  const visibleOperations = operations.filter(o => (kind === "all" || o.kind === kind) && (status === "all" || o.status === status) && (location === "all" || (o.source_location_id && scopedLocations.includes(o.source_location_id)) || (o.destination_location_id && scopedLocations.includes(o.destination_location_id))) && (category === "all" || operationProducts.some(i => i.operation_id === o.id && categoryProductIds.has(i.product_id))) && `${o.reference} ${o.contact}`.toLowerCase().includes(search.toLowerCase()));
  const cards = [
    { label: "Products in stock", value: visibleProducts.filter(p => stockAt(p.id) > 0).length, icon: Boxes, tone: "text-primary" },
    { label: "Low stock", value: visibleProducts.filter(p => stockAt(p.id)>0 && stockAt(p.id)<=Number(p.reorder_point)).length, icon: TriangleAlert, tone: "text-warning" },
    { label: "Out of stock", value: visibleProducts.filter(p => stockAt(p.id)===0).length, icon: Package, tone: "text-destructive" },
    { label: "Pending receipts", value: visibleOperations.filter(o=>o.kind==="receipt"&&!['done','canceled'].includes(o.status)).length, icon: ArrowDownToLine, tone: "text-info" },
    { label: "Pending deliveries", value: visibleOperations.filter(o=>o.kind==="delivery"&&!['done','canceled'].includes(o.status)).length, icon: ArrowUpFromLine, tone: "text-warning" },
    { label: "Pending transfers", value: visibleOperations.filter(o=>o.kind==="transfer"&&!['done','canceled'].includes(o.status)).length, icon: ArrowLeftRight, tone: "text-primary" },
  ];
  return <><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow mb-3">Overview</p><h1 className="font-display text-3xl font-semibold">Dashboard</h1><p className="mt-2 text-sm text-muted-foreground">A clear view of stock and activity across your workspace.</p></div><span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-success" />Live inventory</span></div><div className="mb-7 grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-6">{cards.map(c=><div className="metric min-h-32 p-4" key={c.label}><div className="mb-5 flex items-start justify-between"><p className="text-xs font-medium text-muted-foreground">{c.label}</p><c.icon className={`size-4 shrink-0 ${c.tone}`}/></div><p className="font-display text-3xl font-semibold">{c.value}</p></div>)}</div><div className="mb-7 border-y py-5"><div className="mb-4 text-xs font-bold uppercase text-muted-foreground">Refine your view</div><div className="grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <Label name="Document type"><select className="field" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">All documents</option>{['receipt','delivery','transfer','adjustment'].map(v=><option value={v} key={v} className="capitalize">{v}</option>)}</select></Label>
    <Label name="Status"><select className="field" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{['draft','waiting','ready','done','canceled'].map(v=><option value={v} key={v}>{v}</option>)}</select></Label>
     <Label name="Warehouse / location"><select className="field" value={location} onChange={e=>setLocation(e.target.value)}><option value="all">All locations</option>{[...new Map(locations.filter(l=>l.warehouses).map(l=>[l.warehouse_id,l.warehouses?.name])).entries()].map(([id,name])=><option key={id} value={`warehouse:${id}`}>{name} · all locations</option>)}{locations.map(l=><option key={l.id} value={`location:${l.id}`}>{l.warehouses?.name} / {l.name}</option>)}</select></Label>
    <Label name="Category"><select className="field" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">All categories</option>{[...new Set(products.map(p=>p.category))].map(v=><option key={v}>{v}</option>)}</select></Label>
  </div></div><div className="grid gap-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]"><section className="min-w-0"><div className="mb-4 flex items-center justify-between"><h2 className="font-display text-lg font-semibold">Recent operations</h2><span className="text-xs text-muted-foreground">{visibleOperations.length} documents</span></div><div className="panel table-wrap"><table className="data-table"><thead><tr><th>Reference</th><th>Type</th><th>Contact</th><th>Status</th></tr></thead><tbody>{visibleOperations.slice(0,8).map(o=><tr key={o.id}><td className="font-medium">{o.reference}</td><td className="capitalize">{o.kind}</td><td>{o.contact||'—'}</td><td><span className={`tag tag-${o.status}`}>{o.status}</span></td></tr>)}{!visibleOperations.length&&<tr><td colSpan={4} className="text-muted-foreground">No matching operations.</td></tr>}</tbody></table></div></section><section><div className="mb-1 flex items-center justify-between"><h2 className="font-display text-lg font-semibold">Time to stockout</h2><TriangleAlert className="size-4 text-warning" /></div><p className="mb-4 text-xs text-muted-foreground">{attention.length} product{attention.length===1?'':'s'} below threshold or projected to run out within {RISK_DAYS} days, at the demand rate of the last {DEMAND_WINDOW_DAYS} days.</p><div className="divide-y border-y">{attention.slice(0,8).map(({product:p,onHand,runway})=><div className="flex min-w-0 items-center gap-3 py-4" key={p.id}><div className="grid size-10 shrink-0 place-items-center rounded-md bg-surface text-primary"><Package className="size-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{p.name}</p><p className="text-xs text-muted-foreground">{onHand} {p.unit} on hand · {p.sku}</p></div><span className={`tag shrink-0 ${runwayTone(runway)}`}>{formatRunway(runway)}</span></div>)}{!visibleProducts.length&&<p className="py-5 text-sm text-muted-foreground">Add products to begin tracking stock.</p>}{visibleProducts.length>0&&!attention.length&&<p className="py-5 text-sm text-muted-foreground">Everything is stocked with runway to spare.</p>}</div>{attention.length>0&&<Button variant="outline" className="mt-4 w-full" onClick={()=>setView("replenishment")}><Timer />Review replenishment</Button>}</section></div></>;
}

const CONFIDENCE_TONE: Record<string,string> = { high: "tag-in", medium: "tag-draft", low: "tag-low" };
function Replenishment({workspace,products,locations,quantity,demandFor,can,load,setBusy,setError,search,setView}:Common) {
  const [destination,setDestination]=useState(""); const [picked,setPicked]=useState<Record<string,boolean>>({}); const [message,setMessage]=useState("");
  const rows=products.filter(p=>!p.archived&&`${p.name} ${p.sku}`.toLowerCase().includes(search.toLowerCase()))
    .map(p=>{const onHand=quantity(p.id);const demand=demandFor(p.id);return {product:p,onHand,demand,runway:daysToStockout(onHand,demand.dailyDemand),suggested:suggestedQuantity(onHand,demand.dailyDemand,Number(p.reorder_point))};})
    .filter(r=>r.suggested>0&&(r.onHand<=Number(r.product.reorder_point)||(r.runway!==null&&r.runway<=RISK_DAYS)))
    .sort((a,b)=>(a.runway??Number.POSITIVE_INFINITY)-(b.runway??Number.POSITIVE_INFINITY));
  const chosen=can.purchase?rows.filter(r=>picked[r.product.id]):[];
  async function draft(){
    setMessage("");
    if(!destination)return setError("Choose where the replenishment stock should arrive.");
    if(!chosen.length)return setError("Select at least one product to reorder.");
    setBusy(true);
    const {data:userData}=await supabase.auth.getUser();
    const reference=`REC/${new Date().getFullYear()}/${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const basis=`Suggested by StockSense replenishment — covers ${COVER_DAYS} days of demand measured over the last ${DEMAND_WINDOW_DAYS} days. Confidence per line: ${chosen.map(r=>`${r.product.sku} ${r.demand.confidence}`).join(", ")}. Review the quantities before validating.`;
    const {data:op,error}=await supabase.from("operations").insert({workspace_id:workspace.id,reference,kind:"receipt",status:"draft",contact:"Replenishment suggestion",destination_location_id:destination,notes:basis,created_by:userData.user?.id??""}).select("id,reference").single();
    if(error){setError(error.message);setBusy(false);return;}
    const {error:lineError}=await supabase.from("operation_items").insert(chosen.map(r=>({workspace_id:workspace.id,operation_id:op.id,product_id:r.product.id,quantity:r.suggested})));
    if(lineError)setError(`Draft opened, but its lines could not be saved: ${lineError.message}`);
    else {setMessage(`Draft receipt ${op.reference} created with ${chosen.length} line${chosen.length===1?"":"s"}. Nothing moved — it stays a draft until someone validates it.`);setPicked({});}
    await load();setBusy(false);
  }
  return <><Heading title="Replenishment" subtitle={`Suggestions from your own movement history, with an honest confidence rating on each line.`} action={<Button variant="outline" onClick={()=>setView("receipts")}><ArrowDownToLine/>Open receipts</Button>}/>
  {message&&<p role="status" className="mb-5 rounded-md border border-success/40 bg-card p-4 text-sm text-success">{message}</p>}
  {can.purchase
    ? <div className="panel mb-5 grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><Label name="Receive replenishment into"><LocationSelect locations={locations} value={destination} onChange={setDestination}/></Label><Button onClick={draft} disabled={!chosen.length||!destination}><Plus/>Create draft receipt{chosen.length?` (${chosen.length})`:""}</Button></div>
    : <p className="mb-5 flex items-center gap-2 text-xs text-muted-foreground"><Lock className="size-3.5"/>{STAFF_LOCKED} Raising a replenishment order is a manager action, so this view is read-only.</p>}
  <div className="panel table-wrap"><table className="data-table"><thead><tr>{can.purchase&&<th><span className="sr-only">Select</span></th>}<th>Product</th><th>On hand</th><th>Time to stockout</th><th>Demand basis</th><th>Confidence</th><th>Suggested order</th></tr></thead><tbody>{rows.map(({product:p,onHand,demand,runway,suggested})=><tr key={p.id}>{can.purchase&&<td><input type="checkbox" aria-label={`Include ${p.name} in the draft receipt`} checked={!!picked[p.id]} onChange={e=>setPicked({...picked,[p.id]:e.target.checked})}/></td>}<td><div className="font-medium">{p.name}</div><div className="text-xs text-muted-foreground">{p.sku}</div></td><td>{onHand} {p.unit}</td><td><span className={`tag ${runwayTone(runway)}`}>{formatRunway(runway)}</span></td><td><div>{demand.dailyDemand>0?`${demand.dailyDemand.toFixed(2)} ${p.unit}/day`:"No outbound demand"}</div><div className="text-xs text-muted-foreground">{demand.movementCount} movement{demand.movementCount===1?"":"s"} in {demand.windowDays} days</div></td><td><span className={`tag ${CONFIDENCE_TONE[demand.confidence]??""}`}>{demand.confidence}</span><div className="mt-1 max-w-56 whitespace-normal text-xs text-muted-foreground">{demand.confidenceReason}</div></td><td className="font-semibold">{suggested} {p.unit}</td></tr>)}{!rows.length&&<tr><td colSpan={can.purchase?7:6} className="text-muted-foreground">Nothing needs replenishing right now.</td></tr>}</tbody></table></div>
  <div className="mt-5 max-w-3xl space-y-2 border-t pt-5 text-xs text-muted-foreground"><p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary"/><span>Suggestions never move stock and are never auto-approved. They open a draft receipt that a person has to validate.</span></p><p><strong className="font-semibold text-foreground">How the numbers are built:</strong> demand is measured only from validated deliveries over the last {DEMAND_WINDOW_DAYS} days — transfers are internal and adjustments are corrections, so neither counts as demand. Suggested order covers {COVER_DAYS} days of that demand and restores the product&rsquo;s low-stock threshold.</p><p><strong className="font-semibold text-foreground">What it does not know:</strong> supplier lead times and minimum order quantities are not tracked yet, so they are not factored in. A <em>low</em> confidence line means the history is thin or erratic and the quantity is a starting point for a human decision, not a forecast.</p></div></>;
}

function Products({workspace,products,locations,balances,quantity,demandFor,can,load,setError,search}:Common) {
  const [open,setOpen]=useState(false); const [showArchived,setShowArchived]=useState(false); const [editing,setEditing]=useState<Product|null>(null); const [stockProduct,setStockProduct]=useState<Product|null>(null);
  const [form,setForm]=useState({name:"",sku:"",category:"General",unit:"Units",reorder:"10",initial:"0",location:""});
  function edit(p:Product){setEditing(p);setForm({name:p.name,sku:p.sku,category:p.category,unit:p.unit,reorder:String(p.reorder_point),initial:"0",location:""});setOpen(true);}
  function create(){setEditing(null);setForm({name:"",sku:"",category:"General",unit:"Units",reorder:"10",initial:"0",location:""});setOpen(true);}
  async function archive(p:Product){if(!window.confirm(`Archive ${p.name}? Stock history will be preserved.`))return;const {error}=await supabase.from("products").update({archived:true}).eq("id",p.id).eq("workspace_id",workspace.id);if(error)setError(error.message);else await load();}
  async function restore(p:Product){const {error}=await supabase.from("products").update({archived:false}).eq("id",p.id).eq("workspace_id",workspace.id);if(error)setError(error.message);else await load();}
  async function save(e:FormEvent){e.preventDefault();const reorder=Number(form.reorder),initial=Number(form.initial);
    if(form.name.trim().length<2||!form.sku.trim()||!form.category.trim()||!form.unit.trim()||!Number.isFinite(reorder)||reorder<0||!Number.isFinite(initial)||initial<0||(!editing&&initial>0&&!form.location))return setError("Enter valid product details and choose a location for initial stock.");
    const values={name:form.name.trim(),sku:form.sku.trim().toUpperCase(),category:form.category.trim(),unit:form.unit.trim(),reorder_point:reorder};
    if(editing){const {error}=await supabase.from("products").update(values).eq("id",editing.id).eq("workspace_id",workspace.id);if(error)return setError(error.message);}
    else {const {data,error}=await supabase.from("products").insert({workspace_id:workspace.id,...values}).select("id").single();if(error)return setError(error.message);
      if(initial>0){const {data:userData}=await supabase.auth.getUser();const {data:op,error:opError}=await supabase.from("operations").insert({workspace_id:workspace.id,reference:`OPEN/${crypto.randomUUID().slice(0,8).toUpperCase()}`,kind:"receipt",status:"draft",contact:"Opening balance",destination_location_id:form.location,created_by:userData.user?.id??""}).select("id").single();if(opError)return setError(`Product created, but opening stock failed: ${opError.message}`);
        const {error:itemError}=await supabase.from("operation_items").insert({workspace_id:workspace.id,operation_id:op.id,product_id:data.id,quantity:initial});if(itemError)return setError(`Product created, but opening stock failed: ${itemError.message}`);
        const {error:stockError}=await supabase.rpc("advance_operation",{op_id:op.id,next_status:"done"});if(stockError)return setError(`Product created, but opening stock failed: ${stockError.message}`);
      }
    }
    setOpen(false);await load();
  }
   return <><Heading title="Products" subtitle="Manage your catalog and replenishment thresholds." action={<div className="flex gap-2"><Button variant="outline" onClick={()=>setShowArchived(!showArchived)}><Archive/>{showArchived?"Active products":"Archived"}</Button>{can.catalogue&&<Button onClick={create}><Plus/>New product</Button>}</div>}/>{!can.catalogue&&<p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><Lock className="size-3.5"/>{STAFF_LOCKED} The catalogue is read-only for you.</p>}<div className="panel table-wrap"><table className="data-table"><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Unit</th><th>On hand</th><th>Runway</th><th>Status</th><th></th></tr></thead><tbody>{products.filter(p=>p.archived===showArchived && `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(search.toLowerCase())).map(p=>{const q=quantity(p.id);const runway=daysToStockout(q,demandFor(p.id).dailyDemand);return <tr key={p.id}><td className="text-muted-foreground">{p.sku}</td><td className="font-medium">{p.name}</td><td>{p.category}</td><td>{p.unit}</td><td>{q}</td><td><span className={runway===null?'text-muted-foreground':''}>{formatRunway(runway)}</span></td><td><span className={`tag ${q===0?'tag-out':q<=Number(p.reorder_point)?'tag-low':'tag-in'}`}>{q===0?'Out of stock':q<=Number(p.reorder_point)?'Low stock':'In stock'}</span></td><td><div className="flex gap-2"><Button size="sm" variant="outline" onClick={()=>setStockProduct(p)}>Locations</Button>{can.catalogue&&<><Button size="sm" variant="outline" onClick={()=>edit(p)}><Pencil/>Edit</Button>{p.archived?<Button size="sm" variant="outline" onClick={()=>restore(p)}>Restore</Button>:<Button size="sm" variant="ghost" title="Archive product" aria-label={`Archive ${p.name}`} onClick={()=>archive(p)}><Archive/></Button>}</>}</div></td></tr>})}{!products.length&&<tr><td colSpan={8} className="text-muted-foreground">No products yet. Create your first product.</td></tr>}</tbody></table></div>{stockProduct&&<Modal title={`${stockProduct.name} · availability`} onClose={()=>setStockProduct(null)}><div className="divide-y border-y">{locations.map(l=><div key={l.id} className="flex justify-between gap-4 py-3 text-sm"><span>{l.warehouses?.name} / {l.name}</span><span className="font-semibold">{balances.find(b=>b.product_id===stockProduct.id&&b.location_id===l.id)?.quantity??0} {stockProduct.unit}</span></div>)}</div></Modal>}{open&&<Modal title={editing?'Edit product':'New product'} onClose={()=>setOpen(false)}><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><Label name="Product name"><input className="field" maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Label><Label name="SKU / code"><input className="field" maxLength={50} value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})}/></Label><Label name="Category"><input className="field" maxLength={80} value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/></Label><Label name="Unit of measure"><input className="field" maxLength={24} value={form.unit} onChange={e=>setForm({...form,unit:e.target.value})}/></Label><Label name="Low-stock threshold"><input className="field" type="number" min="0" max="100000000" step="0.01" value={form.reorder} onChange={e=>setForm({...form,reorder:e.target.value})}/></Label>{!editing&&<><Label name="Initial stock"><input className="field" type="number" min="0" max="100000000" step="0.01" value={form.initial} onChange={e=>setForm({...form,initial:e.target.value})}/></Label>{Number(form.initial)>0&&<Label name="Initial stock location"><LocationSelect locations={locations} value={form.location} onChange={location=>setForm({...form,location})}/></Label>}</>}<div className="flex items-end sm:col-span-2"><Button className="ml-auto">{editing?'Save changes':'Save product'}</Button></div></form></Modal>}</>;
}

function Operations({workspace,products,locations,balances,operations,balanceAt,can,load,setBusy,setError,kind,search}:Common&{kind:string}) {
  const [open,setOpen]=useState(false); const [editingOp,setEditingOp]=useState<Operation|null>(null); const [selected,setSelected]=useState<Operation|null>(null);
  const [items,setItems]=useState([{product:"",quantity:"",counted:""}]);
  const [form,setForm]=useState({contact:"",source:"",destination:"",notes:""});
  const [itemsByOperation,setItemsByOperation]=useState<Record<string,{id:string;product_id:string;quantity:number;counted_quantity:number|null}[]>>({});
  const title=({receipt:"Receipts",delivery:"Deliveries",transfer:"Internal transfers",adjustment:"Adjustments"} as Record<string,string>)[kind]??"Operations";
  const filtered=operations.filter(o=>o.kind===kind && `${o.reference} ${o.contact} ${o.status}`.toLowerCase().includes(search.toLowerCase()));
  function available(product:string,location:string){return balances.find(b=>b.product_id===product&&b.location_id===location)?.quantity??0;}
  async function openDetails(op:Operation){setSelected(op); const {data,error}=await supabase.from("operation_items").select("id,product_id,quantity,counted_quantity").eq("operation_id",op.id);if(error)setError(error.message);else setItemsByOperation(prev=>({...prev,[op.id]:data??[]}));}
  async function editDraft(op:Operation){const {data,error}=await supabase.from("operation_items").select("product_id,quantity,counted_quantity").eq("operation_id",op.id);if(error)return setError(error.message);setEditingOp(op);setForm({contact:op.contact,source:op.source_location_id??"",destination:op.destination_location_id??"",notes:""});setItems((data??[]).map(i=>({product:i.product_id,quantity:String(i.quantity),counted:String(i.counted_quantity??"")})));setSelected(null);setOpen(true);}
  async function discardDraft(op:Operation){if(!window.confirm(`Discard draft ${op.reference}? This cannot be undone.`))return;setBusy(true);const {error}=await supabase.rpc("discard_draft_operation",{op_id:op.id});if(error)setError(error.message);else setSelected(null);await load();setBusy(false);}
  async function create(e:FormEvent){e.preventDefault();const validItems=items.every(i=>i.product&&i.quantity!==""&&Number.isFinite(Number(i.quantity))&&Number(i.quantity)>=0&&(kind==="adjustment"?i.counted!==""&&Number(i.counted)>=0:Number(i.quantity)>0));
    if(!validItems||!items.length||new Set(items.map(i=>i.product)).size!==items.length||((kind==="receipt"||kind==="transfer")&&!form.destination)||(kind!=="receipt"&&!form.source)||(kind==="transfer"&&form.source===form.destination))return setError("Check locations and product quantities; each product can appear once.");
    setBusy(true); let opId=editingOp?.id;
    if(editingOp){const {error}=await supabase.from("operations").update({contact:form.contact.trim(),notes:form.notes.trim(),source_location_id:form.source||null,destination_location_id:form.destination||null}).eq("id",editingOp.id).eq("workspace_id",workspace.id);if(error){setError(error.message);setBusy(false);return;}
      const {error:removeError}=await supabase.from("operation_items").delete().eq("operation_id",editingOp.id);if(removeError){setError(removeError.message);setBusy(false);return;}}
    else {const reference=`${kind.slice(0,3).toUpperCase()}/${new Date().getFullYear()}/${crypto.randomUUID().slice(0,8).toUpperCase()}`;
      const {data,error}=await supabase.from("operations").insert({workspace_id:workspace.id,reference,kind,status:"draft",contact:form.contact.trim(),notes:form.notes.trim(),source_location_id:form.source||null,destination_location_id:form.destination||null,created_by:(await supabase.auth.getUser()).data.user?.id??""}).select("id").single();
      if(error){setError(error.message);setBusy(false);return;}opId=data.id;}
    if(!opId){setError("Could not save the document.");setBusy(false);return;}
    const {error:itemError}=await supabase.from("operation_items").insert(items.map(i=>({workspace_id:workspace.id,operation_id:opId,product_id:i.product,quantity:Number(i.quantity),counted_quantity:kind==="adjustment"?Number(i.counted):null})));
    if(itemError)setError(`Draft saved, but products could not be saved: ${itemError.message}`);else{setOpen(false);setEditingOp(null);setItems([{product:"",quantity:"",counted:""}]);setForm({contact:"",source:"",destination:"",notes:""});await load();}
    setBusy(false);
  }
  async function advance(id:string,status:string){setBusy(true);const {error}=await supabase.rpc("advance_operation",{op_id:id,next_status:status});if(error)setError(error.message);else setSelected(null);await load();setBusy(false);}
  return <><Heading title={title} subtitle="Track and validate inventory movements." action={<Button onClick={()=>{setEditingOp(null);setItems([{product:"",quantity:"",counted:""}]);setForm({contact:"",source:"",destination:"",notes:""});setOpen(true)}} disabled={!products.some(p=>!p.archived)||!locations.length}><Plus/>New {kind}</Button>}/>{(!products.length||!locations.length)&&<p className="mb-4 text-sm text-warning">Create a product and warehouse location first.</p>}
  <div className="panel table-wrap"><table className="data-table"><thead><tr><th>Reference</th><th>{kind==="receipt"?"Supplier":kind==="delivery"?"Customer":"Contact"}</th><th>Created</th><th>Status</th><th>Action</th></tr></thead><tbody>{filtered.map(o=><tr key={o.id}><td><Button variant="link" className="h-auto p-0 font-medium" onClick={()=>openDetails(o)}>{o.reference}</Button></td><td>{o.contact||"—"}</td><td>{new Date(o.created_at).toLocaleDateString()}</td><td><span className={`tag tag-${o.status}`}>{o.status}</span></td><td><Button size="sm" variant="outline" onClick={()=>openDetails(o)}>Open</Button></td></tr>)}{!filtered.length&&<tr><td colSpan={5} className="text-muted-foreground">No {title.toLowerCase()} found.</td></tr>}</tbody></table></div>
  {open&&<Modal title={`${editingOp?"Edit":"New"} ${kind}`} onClose={()=>setOpen(false)}><form onSubmit={create} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><Label name={kind==="receipt"?"Supplier":kind==="delivery"?"Customer":"Contact"}><input className="field" maxLength={120} value={form.contact} onChange={e=>setForm({...form,contact:e.target.value})}/></Label>{kind!=="receipt"&&<Label name={kind==="transfer"?"From location":"Stock location"}><LocationSelect locations={locations} value={form.source} onChange={source=>setForm({...form,source})}/></Label>}{(kind==="receipt"||kind==="transfer")&&<Label name={kind==="transfer"?"To location":"Destination location"}><LocationSelect locations={locations} value={form.destination} onChange={destination=>setForm({...form,destination})}/></Label>}</div><div className="border-t pt-4"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">Products</h3><Button type="button" variant="outline" size="sm" onClick={()=>setItems([...items,{product:"",quantity:"",counted:""}])}><Plus/>Add line</Button></div><div className="space-y-3">{items.map((item,index)=><div key={index} className="grid gap-2 border-b pb-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto]"><Label name="Product"><select className="field" value={item.product} onChange={e=>setItems(items.map((i,n)=>n===index?{...i,product:e.target.value}:i))}><option value="">Select product</option>{products.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></Label><Label name={kind==="adjustment"?"Recorded":"Quantity"}><input className="field" type="number" min="0" max="100000000" step="0.01" value={item.quantity} onChange={e=>setItems(items.map((i,n)=>n===index?{...i,quantity:e.target.value}:i))}/></Label>{kind==="adjustment"&&<Label name="Counted"><input className="field" type="number" min="0" max="100000000" step="0.01" value={item.counted} onChange={e=>setItems(items.map((i,n)=>n===index?{...i,counted:e.target.value}:i))}/></Label>}{kind!=="adjustment"&&<div className="self-end pb-2 text-xs text-muted-foreground">{kind==="receipt"?"Incoming":`${available(item.product,form.source)} available`}</div>}<Button type="button" variant="ghost" size="icon" className="self-end" aria-label="Remove line" disabled={items.length===1} onClick={()=>setItems(items.filter((_,n)=>n!==index))}><X/></Button></div>)}</div></div><Label name="Notes"><textarea className="field min-h-20" maxLength={1000} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></Label><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button>{editingOp?"Save draft":"Create draft"}</Button></div></form></Modal>}
  {selected&&<Modal title={selected.reference} onClose={()=>setSelected(null)}><div className="space-y-5"><div className="flex flex-wrap items-center gap-2 text-xs">{['draft','waiting','ready','done'].map((step,index)=><span key={step} className={`tag ${['draft','waiting','ready','done'].indexOf(selected.status)>=index?'tag-ready':''}`}>{index+1}. {kind==='delivery'?({draft:'Draft',waiting:'Picked',ready:'Packed',done:'Dispatched'} as Record<string,string>)[step]:step}</span>)}</div><div className="grid gap-4 border-y py-4 text-sm sm:grid-cols-2"><div><span className="text-muted-foreground">{kind==='receipt'?'Supplier':kind==='delivery'?'Customer':'Contact'}: </span>{selected.contact||'—'}</div><div><span className="text-muted-foreground">Created: </span>{new Date(selected.created_at).toLocaleString()}</div><div><span className="text-muted-foreground">From: </span>{locations.find(l=>l.id===selected.source_location_id)?.name||'—'}</div><div><span className="text-muted-foreground">To: </span>{locations.find(l=>l.id===selected.destination_location_id)?.name||'—'}</div>{selected.notes&&<div className="sm:col-span-2"><span className="text-muted-foreground">Notes: </span>{selected.notes}</div>}</div>
  {(()=>{const asReversal=parseReversal(selected.notes);const reversedBy=findReversal(operations,selected.reference);
    if(asReversal)return <p className="flex items-start gap-2 rounded-md border border-info/40 bg-card p-3 text-xs"><RotateCcw className="mt-0.5 size-4 shrink-0 text-info"/><span>This document reverses <strong>{asReversal.reference}</strong>.{asReversal.reason?` Reason given: ${asReversal.reason}`:""}</span></p>;
    if(reversedBy)return <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-card p-3 text-xs"><RotateCcw className="mt-0.5 size-4 shrink-0 text-warning"/><span>This document was reversed by <strong>{reversedBy.reference}</strong>. Both entries remain in the ledger.</span></p>;
    return null;})()}{kind==='delivery'&&<div className="grid gap-2 border-y py-3 text-sm"><div>Pick confirmed: {selected.picked_at?new Date(selected.picked_at).toLocaleString():'Not yet'}</div><div>Pack confirmed: {selected.packed_at?new Date(selected.packed_at).toLocaleString():'Not yet'}</div><p className="text-xs text-muted-foreground">Stock is deducted on dispatch and recorded in Move history.</p></div>}<div className="table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>SKU</th><th>Quantity</th>{kind==='adjustment'&&<th>Counted</th>}</tr></thead><tbody>{(itemsByOperation[selected.id]??[]).map(i=><tr key={i.id}><td>{products.find(p=>p.id===i.product_id)?.name}</td><td>{products.find(p=>p.id===i.product_id)?.sku}</td><td>{i.quantity}</td>{kind==='adjustment'&&<td>{i.counted_quantity}</td>}</tr>)}</tbody></table></div><div className="flex flex-wrap items-center justify-end gap-2"><Button variant="outline" onClick={()=>window.print()}>Print</Button><ReverseButton workspace={workspace} operation={selected} operations={operations} balanceAt={balanceAt} allowed={can.reverse} load={load} setBusy={setBusy} setError={setError} onReversed={()=>setSelected(null)}/>{!['done','canceled'].includes(selected.status)&&<Button variant="outline" onClick={()=>advance(selected.id,'canceled')}>Cancel operation</Button>}{selected.status==='draft'&&<><Button variant="outline" onClick={()=>editDraft(selected)}><Pencil/>Edit draft</Button><Button variant="outline" onClick={()=>discardDraft(selected)}><Trash2/>Discard draft</Button></>}{selected.status==='draft'&&<Button variant="outline" onClick={()=>advance(selected.id,'waiting')}>{kind==='delivery'?'Confirm pick':'Mark waiting'}</Button>}{(kind==='delivery'?selected.status==='waiting':['draft','waiting'].includes(selected.status))&&<Button variant="outline" onClick={()=>advance(selected.id,'ready')}>{kind==='delivery'?'Confirm pack':'Mark ready'}</Button>}{(kind==='delivery'?selected.status==='ready':!['done','canceled'].includes(selected.status))&&<Button onClick={()=>advance(selected.id,'done')}>{kind==='delivery'?'Dispatch delivery':'Validate'}</Button>}</div></div></Modal>}</>;
}

function Warehouses({workspace,locations,can,load,setError}:Common) { const [open,setOpen]=useState(false);const [warehouses,setWarehouses]=useState<{id:string;name:string;code:string}[]>([]);const [form,setForm]=useState({name:"",code:"",location:"Main Stock",locationCode:"STOCK"}); const refresh=useCallback(async()=>{const {data}=await supabase.from("warehouses").select("id,name,code").eq("workspace_id",workspace.id).order("name");setWarehouses(data??[])},[workspace.id]);useEffect(()=>{void refresh()},[refresh]); async function save(e:FormEvent){e.preventDefault();if(form.name.trim().length<2||form.code.trim().length<2)return setError("Enter a warehouse name and code.");const {data,error}=await supabase.from("warehouses").insert({workspace_id:workspace.id,name:form.name.trim(),code:form.code.trim().toUpperCase()}).select("id").single();if(error)return setError(error.message);const {error:lError}=await supabase.from("locations").insert({workspace_id:workspace.id,warehouse_id:data.id,name:form.location.trim(),code:form.locationCode.trim().toUpperCase()});if(lError)setError(lError.message);else{setOpen(false);await Promise.all([refresh(),load()]);}} return <><Heading title="Warehouses" subtitle="Configure warehouses and physical stock locations." action={can.warehouses?<Button onClick={()=>setOpen(true)}><Plus/>Add warehouse</Button>:undefined}/>{!can.warehouses&&<p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><Lock className="size-3.5"/>{STAFF_LOCKED} Warehouse setup is read-only for you.</p>}<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{warehouses.map(w=><div className="panel p-5" key={w.id}><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-md bg-accent text-primary"><Warehouse/></div><div><h3 className="font-semibold">{w.name}</h3><p className="text-xs text-muted-foreground">{w.code}</p></div></div><div className="mt-5 border-t pt-4 text-sm"><span className="text-muted-foreground">Locations</span><span className="float-right font-semibold">{locations.filter(l=>l.warehouse_id===w.id).length}</span></div></div>)}{!warehouses.length&&<p className="text-sm text-muted-foreground">No warehouses yet.</p>}</div><LocationManager workspace={workspace} warehouses={warehouses} locations={locations} canEdit={can.warehouses} load={load} setError={setError}/>{open&&<Modal title="Add warehouse" onClose={()=>setOpen(false)}><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><Label name="Warehouse name"><input className="field" maxLength={100} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Label><Label name="Short code"><input className="field" maxLength={24} value={form.code} onChange={e=>setForm({...form,code:e.target.value})}/></Label><Label name="First location"><input className="field" maxLength={100} value={form.location} onChange={e=>setForm({...form,location:e.target.value})}/></Label><Label name="Location code"><input className="field" maxLength={24} value={form.locationCode} onChange={e=>setForm({...form,locationCode:e.target.value})}/></Label><Button className="sm:col-span-2">Create warehouse</Button></form></Modal>}</> }

const MOVEMENT_REASON: Record<string,string> = { receipt:"Goods received into stock", delivery:"Goods shipped out", transfer:"Moved between locations", adjustment:"Physical count correction" };
function describeWhy(row:Ledger):string {
  const notes=(row.operations?.notes??"").trim();
  const reversal=parseReversal(notes);
  if(reversal)return `Reversal of ${reversal.reference}${reversal.reason?` — ${reversal.reason}`:""}`;
  if(notes)return notes;
  return MOVEMENT_REASON[row.operations?.kind??""]??"Stock movement";
}
function describeActor(id:string,actors:Record<string,string>,userId:string):string {
  const name=actors[id];
  if(id===userId)return name?`${name} (you)`:"You";
  return name??`Member ${id.slice(0,6)}`;
}
/** Reverses a validated document by posting a counter-document, never by editing history. */
function ReverseButton({workspace,operation,operations,balanceAt,allowed,load,setBusy,setError,onReversed}:{workspace:Workspace;operation:Operation;operations:Operation[];balanceAt:(p:string,l:string)=>number;allowed:boolean;load:()=>Promise<void>;setBusy:(b:boolean)=>void;setError:(s:string)=>void;onReversed?:(reference:string)=>void}) {
  const [open,setOpen]=useState(false); const [reason,setReason]=useState("");
  const existing=findReversal(operations,operation.reference);
  const isReversal=parseReversal(operation.notes)!==null;
  if(!canReverse(operation)||isReversal)return null;
  if(existing)return <span className="tag tag-canceled" title={`Already reversed by ${existing.reference}`}>Reversed</span>;
  // Matched by an RLS policy that rejects reversal documents from non-managers, so this hides an
  // action that would genuinely be refused rather than pretending it does not exist.
  if(!allowed)return <span className="tag" title="Reversing a validated document is a manager action"><Lock className="size-3"/>Manager only</span>;
  async function submit(e:FormEvent){
    e.preventDefault(); setBusy(true);
    try { const reference=await reverseOperation({workspaceId:workspace.id,operation,reason,balanceAt}); setOpen(false); setReason(""); await load(); onReversed?.(reference); }
    catch(err){ setError(err instanceof Error?err.message:"Could not reverse this document."); }
    finally { setBusy(false); }
  }
  return <><Button size="sm" variant="outline" onClick={()=>setOpen(true)}><RotateCcw/>Reverse</Button>
  {open&&<Modal title={`Reverse ${operation.reference}`} onClose={()=>setOpen(false)}><form onSubmit={submit} className="space-y-4"><p className="text-sm text-muted-foreground">This posts a counter-{operation.kind==="receipt"?"delivery":operation.kind==="delivery"?"receipt":operation.kind} that moves the same quantities back. The original document and its ledger rows stay exactly as they are, so the history still reconciles.</p><Label name="Reason (recorded in the audit trail)"><input className="field" maxLength={300} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Counted wrong, wrong location, duplicate entry…" required minLength={3}/></Label><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button disabled={reason.trim().length<3}><RotateCcw/>Post reversal</Button></div></form></Modal>}</>;
}
function HistoryView({ledger,operations,actors,userId,workspace,balanceAt,can,load,setBusy,setError,search}:Common) {
  const visible=ledger.filter(r=>`${r.operations?.reference} ${r.products?.name} ${r.products?.sku} ${r.locations?.name} ${r.operations?.notes}`.toLowerCase().includes(search.toLowerCase()));
  return <><Heading title="Move history" subtitle="Every validated movement — who made it, when, and why. Nothing here is ever edited or deleted."/>
  <p className="mb-5 flex max-w-3xl items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary"/><span>The ledger is append-only. A mistake is corrected by reversing the document, which posts an equal and opposite movement and leaves both entries visible.</span></p>
  <div className="panel table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Reference</th><th>Type</th><th>Product</th><th>Location</th><th>Change</th><th>Balance</th><th>Who</th><th>Why</th><th>Correction</th></tr></thead><tbody>{visible.map(r=>{const op=operations.find(o=>o.id===r.operation_id);return <tr key={r.id}><td>{new Date(r.created_at).toLocaleString()}</td><td>{r.operations?.reference??"—"}</td><td className="capitalize">{r.operations?.kind??"—"}</td><td>{r.products?.name??"—"}<div className="text-xs text-muted-foreground">{r.products?.sku}</div></td><td>{r.locations?.name??"—"}</td><td className={Number(r.delta)>=0?"text-success":"text-destructive"}>{Number(r.delta)>=0?"+":""}{r.delta}</td><td>{r.balance_after}</td><td>{describeActor(r.created_by,actors,userId)}</td><td><div className="max-w-72 whitespace-normal text-xs">{describeWhy(r)}</div></td><td>{op?<ReverseButton workspace={workspace} operation={op} operations={operations} balanceAt={balanceAt} allowed={can.reverse} load={load} setBusy={setBusy} setError={setError}/>:null}</td></tr>})}{!visible.length&&<tr><td colSpan={10} className="text-muted-foreground">Validated inventory movements will appear here.</td></tr>}</tbody></table></div></>;
}
const ROLE_RIGHTS: Record<Role,{allowed:string[];denied:string[]}> = {
  manager: { allowed: ["Create, edit and archive products","Add warehouses and stock locations","Record and validate every movement","Raise replenishment orders","Reverse validated documents"], denied: [] },
  staff: { allowed: ["Record and validate receipts, deliveries, transfers and adjustments","View stock, replenishment advice and the full audit trail"], denied: ["Create, edit or archive products","Add warehouses or stock locations","Raise replenishment orders","Reverse validated documents"] },
};
function Profile({user,workspace,role}:{user:User;workspace:Workspace;role:Role}) {
  const rights=ROLE_RIGHTS[role];
  return <><Heading title="My profile" subtitle="Your account, role, and workspace details."/><div className="panel max-w-2xl p-6"><div className="flex items-center gap-4"><div className="grid size-14 place-items-center rounded-full bg-primary text-xl font-semibold text-primary-foreground">{(user.user_metadata['display_name']||user.email||"U")[0].toUpperCase()}</div><div><h3 className="font-semibold">{user.user_metadata['display_name']||"Inventory user"}</h3><p className="text-sm text-muted-foreground">{user.email}</p></div><span className={`tag ml-auto ${role==="manager"?"tag-in":"tag-draft"}`}>{role}</span></div><div className="mt-6 grid gap-4 border-t pt-6 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Workspace</p><p className="mt-1 font-medium">{workspace.name}</p></div><div><p className="text-xs text-muted-foreground">Invite code</p><p className="mt-1 font-mono text-primary">{workspace.join_code}</p></div></div>
  <div className="mt-6 grid gap-6 border-t pt-6 sm:grid-cols-2"><div><p className="mb-3 text-xs font-bold uppercase text-muted-foreground">You can</p><ul className="space-y-2 text-sm">{rights.allowed.map(item=><li key={item} className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success"/><span>{item}</span></li>)}</ul></div>{rights.denied.length>0&&<div><p className="mb-3 text-xs font-bold uppercase text-muted-foreground">Managers only</p><ul className="space-y-2 text-sm text-muted-foreground">{rights.denied.map(item=><li key={item} className="flex gap-2"><Lock className="mt-0.5 size-4 shrink-0"/><span>{item}</span></li>)}</ul></div>}</div>
  <p className="mt-6 border-t pt-4 text-xs text-muted-foreground">These limits are enforced by row-level security policies in the database, not by hiding buttons — the server refuses the action regardless of how the request is made.</p></div></>;
}
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) { return <div className="modal-overlay fixed inset-0 z-50 grid place-items-center p-4"><div role="dialog" aria-modal="true" aria-label={title} className="modal-panel max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2><Button variant="ghost" size="icon" onClick={onClose}><X/></Button></div>{children}</div></div> }
function Label({name,children}:{name:string;children:ReactNode}) { return <label className="grid gap-2 text-xs font-medium">{name}{children}</label> }
function LocationSelect({locations,value,onChange}:{locations:Location[];value:string;onChange:(v:string)=>void}) { return <select className="field" value={value} onChange={e=>onChange(e.target.value)}><option value="">Select location</option>{locations.map(l=><option key={l.id} value={l.id}>{l.warehouses?.name} / {l.name}</option>)}</select> }
function LocationManager({workspace,warehouses,locations,canEdit,load,setError}:{workspace:Workspace;warehouses:{id:string;name:string;code:string}[];locations:Location[];canEdit:boolean;load:()=>Promise<void>;setError:(s:string)=>void}) {
  const [open,setOpen]=useState(false); const [name,setName]=useState(""); const [code,setCode]=useState(""); const [warehouse,setWarehouse]=useState("");
  async function save(e:FormEvent) { e.preventDefault(); if(!warehouse||name.trim().length<2||code.trim().length<2)return setError("Choose a warehouse and enter a valid location."); const {error}=await supabase.from("locations").insert({workspace_id:workspace.id,warehouse_id:warehouse,name:name.trim(),code:code.trim().toUpperCase()}); if(error)setError(error.message);else{setOpen(false);setName("");setCode("");await load();} }
  return <section className="mt-8"><Heading title="Locations" subtitle="Shelves, racks, and storage areas within your warehouses." action={canEdit?<Button variant="outline" disabled={!warehouses.length} onClick={()=>setOpen(true)}><Plus/>Add location</Button>:undefined}/><div className="panel table-wrap"><table className="data-table"><thead><tr><th>Location</th><th>Code</th><th>Warehouse</th></tr></thead><tbody>{locations.map(l=><tr key={l.id}><td>{l.name}</td><td>{l.code}</td><td>{l.warehouses?.name}</td></tr>)}{!locations.length&&<tr><td colSpan={3} className="text-muted-foreground">No locations yet.</td></tr>}</tbody></table></div>{open&&<Modal title="Add location" onClose={()=>setOpen(false)}><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><Label name="Warehouse"><select className="field" value={warehouse} onChange={e=>setWarehouse(e.target.value)}><option value="">Select warehouse</option>{warehouses.map(w=><option value={w.id} key={w.id}>{w.name}</option>)}</select></Label><Label name="Location name"><input className="field" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></Label><Label name="Short code"><input className="field" maxLength={24} value={code} onChange={e=>setCode(e.target.value)}/></Label><div className="flex items-end"><Button className="w-full">Save location</Button></div></form></Modal>}</section>
}

const SEVERITY_TONE: Record<string,string> = { critical: "tag-out", warning: "tag-low", healthy: "tag-in" };
function WarehouseInsights({workspace,locations}:{workspace:Workspace;locations:Location[]}) {
  const analyze=useServerFn(analyzeWarehouse);
  const warehouses=Array.from(new Map(locations.map(l=>[l.warehouse_id,l.warehouses?.name??'Warehouse'])).entries());
  const [warehouse,setWarehouse]=useState("");
  const [result,setResult]=useState<WarehouseAnalysis|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [showMethod,setShowMethod]=useState(false);
  async function run(){if(!warehouse)return;setLoading(true);setError("");setResult(null);try{setResult(await analyze({data:{workspaceId:workspace.id,warehouseId:warehouse}}))}catch(err){setError(err instanceof Error?err.message:"Could not analyze this warehouse.")}finally{setLoading(false)}}
  return <><Heading title="Stock insights" subtitle="Warehouse risk and replenishment, computed from your own ledger."/>
  <section className="panel max-w-4xl space-y-5 p-6"><div className="flex items-center gap-3"><div className="grid size-11 place-items-center rounded-xl bg-accent text-primary"><Sparkles/></div><div><h2 className="font-semibold">Spot risk before it becomes a shortage</h2><p className="text-xs text-muted-foreground">Every figure is arithmetic over your movement history — no model, no external service, nothing invented.</p></div></div>
  <div className="flex flex-col gap-3 sm:flex-row"><select className="field sm:max-w-sm" aria-label="Warehouse to analyze" value={warehouse} onChange={e=>{setWarehouse(e.target.value);setResult(null)}}><option value="">Choose a warehouse</option>{warehouses.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select><Button onClick={run} disabled={!warehouse||loading}><Sparkles/>{loading?'Analyzing…':'Analyze warehouse'}</Button></div>
  {error&&<NoticeBox tone="error" text={error}/>}
  {result&&<div className="space-y-6">
    <div><p className="eyebrow mb-3">{result.warehouse}</p><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{result.headline.map(h=><div key={h.label} className="metric p-3"><p className="text-[11px] text-muted-foreground">{h.label}</p><p className="mt-1 font-display text-xl font-semibold">{h.value}</p></div>)}</div></div>
    <div className="space-y-3">{result.findings.map((f,i)=><div key={i} className="rounded-xl border p-4"><div className="flex flex-wrap items-center gap-2"><span className={`tag ${SEVERITY_TONE[f.severity]??""}`}>{f.severity}</span><h3 className="text-sm font-semibold">{f.title}</h3></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{f.detail}</p>{f.items&&<ul className="mt-3 space-y-1.5 border-t pt-3 text-xs">{f.items.map(item=><li key={item} className="flex gap-2"><span className="text-primary">·</span><span>{item}</span></li>)}</ul>}</div>)}</div>
    {result.reorderPlan.length>0&&<div><h3 className="mb-3 font-display text-lg font-semibold">Suggested replenishment</h3><div className="panel table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>On hand</th><th>Time to stockout</th><th>Confidence</th><th>Suggested order</th></tr></thead><tbody>{result.reorderPlan.map(line=><tr key={line.sku}><td><div className="font-medium">{line.name}</div><div className="text-xs text-muted-foreground">{line.sku}</div></td><td>{line.onHand} {line.unit}</td><td><span className={`tag ${runwayTone(line.runwayDays)}`}>{line.runway}</span></td><td><span className={`tag ${CONFIDENCE_TONE[line.confidence]??""}`}>{line.confidence}</span><div className="mt-1 max-w-56 whitespace-normal text-xs text-muted-foreground">{line.confidenceReason}</div></td><td className="font-semibold">{line.suggested} {line.unit}</td></tr>)}</tbody></table></div></div>}
    <div className="border-t pt-4"><Button variant="link" className="h-auto p-0 text-xs" onClick={()=>setShowMethod(!showMethod)}>{showMethod?"Hide":"How is this calculated?"}</Button>{showMethod&&<ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">{result.method.map(m=><li key={m} className="flex gap-2"><span className="text-primary">·</span><span>{m}</span></li>)}</ul>}</div>
  </div>}
  <p className="border-t pt-4 text-xs text-muted-foreground">Suggestions are informational. Review stock and purchasing decisions before acting.</p></section></>;
}
