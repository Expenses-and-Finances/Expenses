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

// Plaid key sets: "primary" (yours), "wife" (PLAID_CLIENT_ID_2 / PLAID_SECRET_2), "silvina" (PLAID_CLIENT_ID_3 / PLAID_SECRET_3); "mariana" uses Silvina's keys.
function plaidKeys(env, profile) {
  if (profile === "wife") {
    if (!env.PLAID_CLIENT_ID_2 || !env.PLAID_SECRET_2) throw new Error("wife's Plaid keys are not set up");
    return { client_id: env.PLAID_CLIENT_ID_2, secret: env.PLAID_SECRET_2 };
  }
  // Silvina's Plaid account (PLAID_CLIENT_ID_3 / PLAID_SECRET_3). Mariana's banks are connected through it too;
  // the profile name only decides whose accounts they are.
  if (profile === "silvina" || profile === "mariana") {
    if (!env.PLAID_CLIENT_ID_3 || !env.PLAID_SECRET_3) throw new Error("Silvina's Plaid keys are not set up");
    return { client_id: env.PLAID_CLIENT_ID_3, secret: env.PLAID_SECRET_3 };
  }
  return { client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET };
}

async function plaid(env, path, body, profile = "primary") {
  const base = PLAID_BASES[env.PLAID_ENV] || PLAID_BASES.sandbox;
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...plaidKeys(env, profile), ...body }),
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
// Cash withdrawals and Venmo/Zelle-type payments count as spending; tap "Transfer?" in the app for ones to your own accounts.
const TRANSFER_PRIMARY = ["TRANSFER_IN", "TRANSFER_OUT"];
const TRANSFER_DETAILED = ["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
const SPENDING_DETAILED = ["TRANSFER_OUT_WITHDRAWAL", "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS"];
function isTransfer(t) {
  const c = t.personal_finance_category || {};
  if (SPENDING_DETAILED.includes(c.detailed)) return false;
  return TRANSFER_PRIMARY.includes(c.primary) || TRANSFER_DETAILED.includes(c.detailed);
}

// Pull new, changed and removed transactions for one bank connection.
async function syncItem(env, item) {
  const profile = item.plaid_profile || "primary";
  const accessToken = await decryptToken(env, item.access_token);
  if (!item.access_token.startsWith(ENC_PREFIX)) {
    await db(env, "PATCH", `plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, { access_token: await encryptToken(env, accessToken) });
  }
  let cursor = item.sync_cursor || undefined;
  let added = [], modified = [], removed = [];
  for (let page = 0; page < 10; page++) {
    const data = await plaid(env, "/transactions/sync", { access_token: accessToken, cursor, count: 500 }, profile);
    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removed = removed.concat(data.removed);
    cursor = data.next_cursor;
    if (!data.has_more) break;
  }

  // Ask Plaid for every account on this login (checking, savings, loans, mortgages...), not just the ones in this batch.
  const { accounts } = await plaid(env, "/accounts/get", { access_token: accessToken }, profile);
  const accountIds = {};
  if (accounts.length) {
    const rows = await db(env, "POST", "accounts?on_conflict=plaid_account_id", accounts.map((a) => ({
      plaid_account_id: a.account_id,
      plaid_item_id: item.item_id,
      owner_person: ({ wife: "Wife", silvina: "Silvina", mariana: "Mariana" })[profile] || "You",
      name: a.official_name || a.name,
      institution: item.institution,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      current_balance: a.balances?.current ?? null,
      available_balance: a.balances?.available ?? null,
      currency: a.balances?.iso_currency_code || a.balances?.unofficial_currency_code || null,
      balance_updated_at: new Date().toISOString(),
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

  const statementCopies = await retireStatementRows(env, Object.values(accountIds));

  await db(env, "PATCH", `plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, { sync_cursor: cursor || null });
  return { added: added.length, modified: modified.length, removed: gone.length, statement_copies_hidden: statementCopies };
}

// Lines imported from a bank statement fill gaps while the bank's feed is behind. Once the bank sends the same
// transaction (same account, same amount, within 4 days), the imported line is marked stale so it isn't counted twice.
async function retireStatementRows(env, accountIdList) {
  if (!accountIdList.length) return 0;
  const inAccts = encodeURIComponent(accountIdList.join(","));
  const stmt = await db(env, "GET", `transactions?select=id,account_id,amount,posted_date&source=eq.statement&stale=is.null&account_id=in.(${inAccts})&order=posted_date&limit=2000`);
  if (!stmt.length) return 0;
  const shift = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const from = shift(stmt[0].posted_date, -4), to = shift(stmt[stmt.length - 1].posted_date, 4);
  let bank = [];
  for (let off = 0; ; off += 1000) {
    const rows = await db(env, "GET", `transactions?select=id,account_id,amount,posted_date&plaid_transaction_id=not.is.null&pending=is.false&account_id=in.(${inAccts})&posted_date=gte.${from}&posted_date=lte.${to}&order=posted_date&limit=1000&offset=${off}`);
    bank = bank.concat(rows);
    if (rows.length < 1000) break;
  }
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  const usedBank = new Set();
  const retire = [];
  for (const s of stmt) {
    const hit = bank.find((b) => !usedBank.has(b.id) && b.account_id === s.account_id
      && Math.abs(Number(b.amount) - Number(s.amount)) < 0.005 && days(b.posted_date, s.posted_date) <= 4);
    if (hit) { usedBank.add(hit.id); retire.push(s.id); }
  }
  for (let i = 0; i < retire.length; i += 80) {
    await db(env, "PATCH", `transactions?id=in.(${encodeURIComponent(retire.slice(i, i + 80).join(","))})`, { stale: true }, "return=minimal");
  }
  return retire.length;
}

// Value Coinbase holdings with Coinbase's public exchange rates (one request, no login).
// Coins Coinbase no longer prices keep their last known price.
async function updateCrypto(env) {
  const holdings = await db(env, "GET", "crypto_holdings?select=id,symbol,quantity,last_price");
  if (!holdings.length) return { coins: 0 };
  const res = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
  if (!res.ok) throw new Error(`coinbase prices: ${res.status}`);
  const rates = (await res.json()).data?.rates || {};
  const now = new Date().toISOString();
  let total = 0, priced = 0;
  const rows = holdings.map((h) => {
    const r = Number(rates[h.symbol]);
    const price = h.symbol === "USDC" ? 1 : r > 0 ? 1 / r : h.last_price == null ? null : Number(h.last_price);
    if (r > 0 || h.symbol === "USDC") priced++;
    const value = price == null ? null : Math.round(Number(h.quantity) * price * 100) / 100;
    total += value || 0;
    return { symbol: h.symbol, quantity: h.quantity, last_price: price, last_value: value, price_updated_at: r > 0 ? now : undefined };
  });
  await db(env, "POST", "crypto_holdings?on_conflict=symbol", rows, "resolution=merge-duplicates,return=minimal");
  await db(env, "PATCH", "accounts?institution=eq.Coinbase%20(holdings)", {
    current_balance: Math.round(total * 100) / 100, balance_updated_at: now,
  });
  return { coins: holdings.length, priced, total: Math.round(total * 100) / 100 };
}

// Link loan payments from checking to the property whose loan they paid (logic lives in the database).
async function matchProperties(env) {
  await db(env, "POST", "rpc/match_property_payments", {});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const user = await requireOwner(request, env);
      if (!user) return json({ error: "not signed in as owner" }, 401);

      try {
        const body = request.headers.get("content-type")?.includes("json") ? await request.json().catch(() => ({})) : {};
        const profile = ["wife", "silvina", "mariana"].includes(body.profile) ? body.profile : "primary";

        if (url.pathname === "/api/plaid/link-token" && body.item_id) {
          // Reconnect ("update mode"): same connection, fresh bank login, no new slot used.
          const [item] = await db(env, "GET", `plaid_items?select=item_id,access_token,plaid_profile&item_id=eq.${encodeURIComponent(body.item_id)}`);
          if (!item) return json({ error: "not found" }, 404);
          const data = await plaid(env, "/link/token/create", {
            client_name: "Expenses",
            language: "en",
            country_codes: ["US"],
            user: { client_user_id: user.id },
            access_token: await decryptToken(env, item.access_token),
          }, item.plaid_profile || "primary");
          // Start the next sync from scratch so anything missed comes back in.
          await db(env, "PATCH", `plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, { sync_cursor: null });
          return json({ link_token: data.link_token });
        }

        if (url.pathname === "/api/plaid/link-token") {
          const data = await plaid(env, "/link/token/create", {
            client_name: "Expenses",
            language: "en",
            country_codes: ["US"],
            user: { client_user_id: user.id },
            products: ["transactions"],
            transactions: { days_requested: 730 },
          }, profile);
          return json({ link_token: data.link_token });
        }

        if (url.pathname === "/api/plaid/exchange") {
          const { public_token, institution } = body;
          if (!public_token) return json({ error: "missing public_token" }, 400);
          const data = await plaid(env, "/item/public_token/exchange", { public_token }, profile);
          const [item] = await db(env, "POST", "plaid_items?on_conflict=item_id", [{
            item_id: data.item_id,
            access_token: await encryptToken(env, data.access_token),
            institution: typeof institution === "string" ? institution.slice(0, 100) : null,
            plaid_profile: profile,
          }], UPSERT);
          const result = await syncItem(env, item);
          await matchProperties(env);
          return json({ connected: true, ...result });
        }

        // Bank list for Refresh (no tokens). The page syncs one bank per request to stay within Cloudflare's limits.
        if (url.pathname === "/api/plaid/items") {
          const items = await db(env, "GET", "plaid_items?select=item_id,institution&order=created_at");
          return json({ items });
        }

        if (url.pathname === "/api/plaid/sync") {
          if (!body.item_id) return json({ error: "missing item_id" }, 400);
          const [item] = await db(env, "GET", `plaid_items?select=item_id,access_token,institution,sync_cursor,plaid_profile&item_id=eq.${encodeURIComponent(body.item_id)}`);
          if (!item) return json({ error: "not found" }, 404);
          return json(await syncItem(env, item));
        }

        if (url.pathname === "/api/plaid/status") {
          // Read-only health check: when Plaid last pulled from each bank, and any bank-side problem.
          const items = await db(env, "GET", "plaid_items?select=item_id,access_token,institution,plaid_profile&order=created_at");
          const out = [];
          for (const it of items.filter((i) => !body.item_id || i.item_id === body.item_id)) {
            try {
              const prof = it.plaid_profile || "primary";
              const g = await plaid(env, "/item/get", { access_token: await decryptToken(env, it.access_token) }, prof);
              const row = {
                institution: it.institution,
                item_error: g.item?.error ? `${g.item.error.error_code}: ${g.item.error.error_message}` : null,
                last_successful_update: g.status?.transactions?.last_successful_update || null,
                last_failed_update: g.status?.transactions?.last_failed_update || null,
                consent_expires: g.item?.consent_expiration_time || null,
              };
              if (g.item?.institution_id) {
                try {
                  const ins = await plaid(env, "/institutions/get_by_id", { institution_id: g.item.institution_id, country_codes: ["US"], options: { include_status: true } }, prof);
                  const st = ins.institution?.status || {};
                  row.bank_feed = {
                    transactions: st.transactions_updates?.status || null,
                    transactions_success_rate: st.transactions_updates?.breakdown?.success ?? null,
                    login: st.item_logins?.status || null,
                  };
                } catch { row.bank_feed = null; }
              }
              out.push(row);
            } catch (e) {
              out.push({ institution: it.institution, check_failed: true });
            }
          }
          return json({ items: out });
        }

        // Duplicate check: ask Plaid for its full current list for one bank (without moving the sync cursor)
        // and mark stored copies Plaid no longer has as stale. Nothing is deleted; apply=false only reports.
        if (url.pathname === "/api/plaid/audit") {
          if (!body.item_id) return json({ error: "missing item_id" }, 400);
          const [item] = await db(env, "GET", `plaid_items?select=item_id,access_token,plaid_profile&item_id=eq.${encodeURIComponent(body.item_id)}`);
          if (!item) return json({ error: "not found" }, 404);
          const prof = item.plaid_profile || "primary";
          const token = await decryptToken(env, item.access_token);
          const live = new Set();
          let cursor, complete = false;
          for (let page = 0; page < 20; page++) {
            const d = await plaid(env, "/transactions/sync", { access_token: token, cursor, count: 500 }, prof);
            for (const t of d.added) live.add(t.transaction_id);
            for (const t of d.modified) live.add(t.transaction_id);
            cursor = d.next_cursor;
            if (!d.has_more) { complete = true; break; }
          }
          if (!complete || live.size === 0) return json({ error: "Plaid list incomplete, nothing changed", live: live.size }, 409);
          const accts = await db(env, "GET", `accounts?select=plaid_account_id&plaid_item_id=eq.${encodeURIComponent(item.item_id)}`);
          const ids = accts.map((a) => a.plaid_account_id).filter(Boolean);
          let stored = [];
          if (ids.length) {
            const inList = encodeURIComponent(ids.map((i) => `"${i}"`).join(","));
            for (let off = 0; ; off += 1000) {
              const rows = await db(env, "GET", `transactions?select=plaid_transaction_id,stale&plaid_account_id=in.(${inList})&order=id&limit=1000&offset=${off}`);
              stored = stored.concat(rows);
              if (rows.length < 1000) break;
            }
          }
          const stale = stored.filter((r) => r.plaid_transaction_id && !live.has(r.plaid_transaction_id)).map((r) => r.plaid_transaction_id);
          const revive = stored.filter((r) => r.stale && live.has(r.plaid_transaction_id)).map((r) => r.plaid_transaction_id);
          if (body.apply) {
            const mark = async (list, value) => {
              for (let i = 0; i < list.length; i += 80) {
                const q = encodeURIComponent(list.slice(i, i + 80).map((x) => `"${x}"`).join(","));
                await db(env, "PATCH", `transactions?plaid_transaction_id=in.(${q})`, { stale: value }, "return=minimal");
              }
            };
            await mark(stale, true);
            await mark(revive, null);
          }
          return json({ plaid_has: live.size, stored: stored.length, stale: stale.length, revived: revive.length, applied: !!body.apply });
        }

        if (url.pathname === "/api/plaid/match") {
          await matchProperties(env);
          return json({ ok: true });
        }

        if (url.pathname === "/api/crypto/update") {
          return json(await updateCrypto(env));
        }
      } catch (e) {
        // Log details on the server only; the browser gets a generic message.
        console.error(e.message);
        // Plaid error codes (e.g. INVALID_API_KEYS) and missing-key notices say nothing secret, so show them to you.
        const safe = /^plaid \/[\w/.-]+: [A-Z_0-9]+$/.test(e.message) || /keys are not set up$/.test(e.message);
        return json({ error: safe ? e.message : "server error" }, 502);
      }

      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  // Runs on the schedule in wrangler.jsonc (1st of each month): refresh Coinbase prices.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateCrypto(env).catch((e) => console.error(e.message)));
  },
};
