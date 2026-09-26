/**
 * Creates the demo sign-in accounts through the Supabase Auth Admin API.
 *
 *   bun run scripts/create-demo-users.ts
 *
 * Why the API and not SQL: GoTrue owns the shape of auth.users. Writing those rows by hand leaves
 * NULLs in columns it scans into non-nullable strings, which takes down the whole auth API with
 * 500s and cannot be undone through the API afterwards. `email_confirm: true` here also means the
 * accounts work while email confirmation stays switched on for everyone else.
 *
 * Safe to re-run: existing accounts have their password reset and address confirmed instead of
 * erroring, and workspace membership is upserted.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env. The service key bypasses row-level
 * security, so this is a local operator tool — never import it into application code.
 */

const USERNAME_DOMAIN = "stocksense.local";
const DEMO_PASSWORD = "StockSense#2026";

const ACCOUNTS = [
  { username: "admin", displayName: "Admin User", role: "manager" },
  { username: "manager", displayName: "Maya Manager", role: "manager" },
  { username: "staff", displayName: "Sam Stockroom", role: "staff" },
] as const;

function readEnv(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? process.env["SUPABASE_SECRET_KEY"];
  if (!url || !key) {
    console.error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Bun loads .env automatically; check that both are set there.",
    );
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ""), key };
}

const { url, key } = readEnv();

// Supabase rejects secret keys on requests that look browser-originated, so send a plain
// non-browser user agent.
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "User-Agent": "StockSense-Setup/1.0",
};

async function request(method: string, path: string, body?: unknown, prefer?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: prefer ? { ...headers, Prefer: prefer } : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "msg" in parsed
        ? String((parsed as { msg: unknown }).msg)
        : text;
    throw new Error(`${method} ${path} -> ${response.status}: ${message}`);
  }
  return parsed;
}

/** Finds an existing account by email, paging until it runs out of users. */
async function findUser(email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page++) {
    const body = (await request("GET", `/auth/v1/admin/users?page=${page}&per_page=200`)) as {
      users?: { id: string; email?: string }[];
    };
    const users = body.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return { id: hit.id };
    if (users.length < 200) return null;
  }
  return null;
}

async function main() {
  console.log(`Target: ${url}\n`);

  const workspaces = (await request(
    "GET",
    "/rest/v1/workspaces?select=id,name&order=created_at.asc&limit=1",
  )) as { id: string; name: string }[] | null;
  let workspace = workspaces?.[0];

  if (!workspace) {
    // return=representation, or PostgREST answers 201 with an empty body.
    const created = (await request(
      "POST",
      "/rest/v1/workspaces",
      { name: "StockSense Demo" },
      "return=representation",
    )) as { id: string; name: string }[] | null;
    workspace = created?.[0];
    if (!workspace)
      throw new Error("Could not create a workspace. Has scripts/schema.sql been run?");
    console.log(`Created workspace "${workspace.name}"`);
  }
  console.log(`Workspace: ${workspace.name} (${workspace.id})\n`);

  for (const account of ACCOUNTS) {
    const email = `${account.username}@${USERNAME_DOMAIN}`;
    const existing = await findUser(email);

    let userId: string;
    if (existing) {
      await request("PUT", `/auth/v1/admin/users/${existing.id}`, {
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: account.displayName },
      });
      userId = existing.id;
      console.log(`updated  ${email}`);
    } else {
      const created = (await request("POST", "/auth/v1/admin/users", {
        email,
        password: DEMO_PASSWORD,
        email_confirm: true, // usable immediately, without relaxing confirmation for real sign-ups
        user_metadata: { display_name: account.displayName },
      })) as { id: string };
      userId = created.id;
      console.log(`created  ${email}`);
    }

    // The on_auth_user_created trigger inserts the profile; this keeps the name right on re-runs.
    // resolution=merge-duplicates turns the POST into an upsert instead of a conflict error.
    await request(
      "POST",
      "/rest/v1/profiles?on_conflict=id",
      { id: userId, display_name: account.displayName },
      "resolution=merge-duplicates",
    );
    await request(
      "POST",
      "/rest/v1/workspace_members?on_conflict=workspace_id,user_id",
      { workspace_id: workspace.id, user_id: userId, role: account.role },
      "resolution=merge-duplicates",
    );
  }

  console.log(`\nDone. Sign in with admin / manager / staff and password ${DEMO_PASSWORD}`);
  console.log("Drop these accounts before the app faces real users: the password is in this file.");
}

main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
