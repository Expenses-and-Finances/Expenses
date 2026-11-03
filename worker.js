// Server side of the app. Runs on Cloudflare, not in the browser,
// so Plaid secrets, Plaid access tokens and the database service key stay here.
const PLAID_BASES = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Accept a request only if it carries a valid Supabase login for the owner's email.
async function requireOwner(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: auth, apikey: env.SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user.email || user.email.toLowerCase() !== (env.OWNER_EMAIL || "").toLowerCase()) return null;
  return user;
}

async function plaid(env, path, body) {
  const base = PLAID_BASES[env.PLAID_ENV] || PLAID_BASES.sandbox;
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`plaid ${path}: ${data.error_code || res.status}`);
  return data;
}

// Database access with the service key. Never sent to the browser.
async function db(env, method, path, body, prefer) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "content-type": "application/json" };
  // Older "service_role" keys are JWTs and also go in Authorization; newer sb_secret_ keys go only in apikey.
  if (key && key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const UPSERT = "resolution=merge-duplicates,return=representation";

// Bank access tokens are stored encrypted (AES-256-GCM). The key lives only in Cloudflare as TOKEN_ENCRYPTION_KEY,
// so a copy of the database alone cannot be used to reach your bank data.
const ENC_PREFIX = "enc:v1:";
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function tokenKey(env) {
  const raw = env.TOKEN_ENCRYPTION_KEY ? unb64(env.TOKEN_ENCRYPTION_KEY.trim()) : null;
  if (!raw || raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY missing or not 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return ENC_PREFIX + b64(out);
}

async function decryptToken(env, stored) {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // older plain value; re-encrypted on next sync
  const data = unb64(stored.slice(ENC_PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, await tokenKey(env), data.slice(12));
  return new TextDecoder().decode(pt);
}

// Money moving between your own accounts: transfers and credit card payments.
// Mortgage and other loan payments still count as spending.
const TRANSFER_PRIMARY = ["TRANSFER_IN", "TRANSFER_OUT"];
const TRANSFER_DETAILED = ["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
function isTransfer(t) {
  const c = t.personal_finance_category || {};
  return TRANSFER_PRIMARY.includes(c.primary) || TRANSFER_DETAILED.includes(c.detailed);
}

// Pull new, changed and removed transactions for one bank connection.
async function syncItem(env, item) {
  const accessToken = await decryptToken(env, item.access_token);
  if (!item.access_token.startsWith(ENC_PREFIX)) {
    await db(env, "PATCH", `plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, { access_token: await encryptToken(env, accessToken) });
  }
  let cursor = item.sync_cursor || undefined;
  let added = [], modified = [], removed = [];
  for (let page = 0; page < 10; page++) {
    const data = await plaid(env, "/transactions/sync", { access_token: accessToken, cursor, count: 500 });
    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removed = removed.concat(data.removed);
    cursor = data.next_cursor;
    if (!data.has_more) break;
  }

  // Ask Plaid for every account on this login (checking, savings, loans, mortgages...), not just the ones in this batch.
  const { accounts } = await plaid(env, "/accounts/get", { access_token: accessToken });
  const accountIds = {};
  if (accounts.length) {
    const rows = await db(env, "POST", "accounts?on_conflict=plaid_account_id", accounts.map((a) => ({
      plaid_account_id: a.account_id,
      plaid_item_id: item.item_id,
      name: a.official_name || a.name,
      institution: item.institution,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
    })), UPSERT);
    for (const r of rows) accountIds[r.plaid_account_id] = r.id;
  }

  // Plaid amounts: positive = money out, negative = money in. Category, tags and your manual transfer choice are left alone.
  const changed = added.concat(modified).map((t) => ({
    auto_transfer: isTransfer(t),
    plaid_category_detailed: t.personal_finance_category?.detailed || null,
    plaid_transaction_id: t.transaction_id,
    plaid_account_id: t.account_id,
    account_id: accountIds[t.account_id] || null,
    posted_date: t.date,
    merchant: t.merchant_name || t.name,
    amount: t.amount,
    pending: t.pending,
    plaid_category: t.personal_finance_category?.primary || null,
  }));
  for (let i = 0; i < changed.length; i += 500) {
    await db(env, "POST", "transactions?on_conflict=plaid_transaction_id", changed.slice(i, i + 500), "resolution=merge-duplicates,return=minimal");
  }

  const gone = removed.map((r) => r.transaction_id).filter(Boolean);
  if (gone.length) {
    const list = gone.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    await db(env, "DELETE", `transactions?plaid_transaction_id=in.(${encodeURIComponent(list)})`);
  }

  await db(env, "PATCH", `plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, { sync_cursor: cursor || null });
  return { added: added.length, modified: modified.length, removed: gone.length };
}

async function syncAll(env) {
  const items = await db(env, "GET", "plaid_items?select=item_id,access_token,institution,sync_cursor");
  const totals = { connections: items.length, added: 0, modified: 0, removed: 0 };
  for (const item of items) {
    const r = await syncItem(env, item);
    totals.added += r.added;
    totals.modified += r.modified;
    totals.removed += r.removed;
  }
  return totals;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/plaid/")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const user = await requireOwner(request, env);
      if (!user) return json({ error: "not signed in as owner" }, 401);

      try {
        if (url.pathname === "/api/plaid/link-token") {
          const data = await plaid(env, "/link/token/create", {
            client_name: "Expenses",
            language: "en",
            country_codes: ["US"],
            user: { client_user_id: user.id },
            products: ["transactions"],
            transactions: { days_requested: 730 },
          });
          return json({ link_token: data.link_token });
        }

        if (url.pathname === "/api/plaid/exchange") {
          const { public_token, institution } = await request.json();
          if (!public_token) return json({ error: "missing public_token" }, 400);
          const data = await plaid(env, "/item/public_token/exchange", { public_token });
          const [item] = await db(env, "POST", "plaid_items?on_conflict=item_id", [{
            item_id: data.item_id,
            access_token: await encryptToken(env, data.access_token),
            institution: typeof institution === "string" ? institution.slice(0, 100) : null,
          }], UPSERT);
          const result = await syncItem(env, item);
          return json({ connected: true, ...result });
        }

        if (url.pathname === "/api/plaid/sync") {
          return json(await syncAll(env));
        }
      } catch (e) {
        // Log details on the server only; the browser gets a generic message.
        console.error(e.message);
        return json({ error: "server error" }, 502);
      }

      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
