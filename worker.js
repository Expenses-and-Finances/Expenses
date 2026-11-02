// Server side of the app. Runs on Cloudflare, not in the browser,
// so Plaid secrets stay here and never reach the page.
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
  return { ok: res.ok, data: await res.json() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/plaid/")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const user = await requireOwner(request, env);
      if (!user) return json({ error: "not signed in as owner" }, 401);

      if (url.pathname === "/api/plaid/link-token") {
        const { ok, data } = await plaid(env, "/link/token/create", {
          client_name: "Expenses",
          language: "en",
          country_codes: ["US"],
          user: { client_user_id: user.id },
          products: ["transactions"],
        });
        return ok ? json({ link_token: data.link_token }) : json({ error: "plaid error" }, 502);
      }

      if (url.pathname === "/api/plaid/exchange") {
        const { public_token } = await request.json();
        if (!public_token) return json({ error: "missing public_token" }, 400);
        const { ok } = await plaid(env, "/item/public_token/exchange", { public_token });
        // Access token is intentionally not stored yet; storage comes with the transaction sync step.
        return ok ? json({ connected: true }) : json({ error: "plaid error" }, 502);
      }

      return json({ error: "not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
