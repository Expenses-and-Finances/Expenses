"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const wrap = { maxWidth: 480, margin: "0 auto", padding: 16 };

// Loads Plaid's official Link script once, only when the button is pressed.
function loadPlaid() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = () => resolve(window.Plaid);
    s.onerror = () => reject(new Error("Could not load Plaid"));
    document.head.appendChild(s);
  });
}

function ConnectBank({ session, onChange }) {
  const [msg, setMsg] = useState("");
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.access_token}` };

  async function connect() {
    try {
      setMsg("Opening Plaid...");
      const res = await fetch("/api/plaid/link-token", { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) return setMsg(`Could not start: ${data.error || res.status}`);
      const Plaid = await loadPlaid();
      Plaid.create({
        token: data.link_token,
        onSuccess: async (public_token, metadata) => {
          setMsg("Saving connection and loading transactions...");
          const r = await fetch("/api/plaid/exchange", {
            method: "POST",
            headers,
            body: JSON.stringify({ public_token, institution: metadata?.institution?.name }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return setMsg("Connection failed at the last step.");
          setMsg(d.added ? `Connected. Loaded ${d.added} transactions.` : "Connected. The bank is still preparing transactions; press Refresh in a minute.");
          onChange();
        },
        onExit: (err) => setMsg(err ? "Plaid closed with an error." : ""),
      }).open();
    } catch {
      setMsg("Something went wrong. Try again.");
    }
  }

  return (
    <div style={{ margin: "12px 0" }}>
      <button onClick={connect} style={{ padding: "10px 14px", fontSize: 16 }}>Connect bank</button>
      {msg && <p style={{ color: "#6b7280" }}>{msg}</p>}
    </div>
  );
}

export default function Home() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendLink(e) {
    e.preventDefault();
    setStatus("Sending...");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setStatus(error ? "Could not send the link. Check the address and try again." : "Check your email for a sign-in link.");
  }

  if (checking) {
    return <main style={wrap}><p>Loading...</p></main>;
  }

  if (!supabase) {
    return (
      <main style={wrap}>
        <h1 style={{ fontSize: 24 }}>Expenses</h1>
        <p>The app is missing its connection settings. Ask for the setup steps.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main style={wrap}>
        <h1 style={{ fontSize: 24 }}>Expenses</h1>
        <p style={{ color: "#6b7280" }}>Sign in with your email. We'll send you a one-time link.</p>
        <form onSubmit={sendLink} style={{ display: "flex", gap: 8 }}>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{ flex: 1, padding: 10, fontSize: 16 }}
          />
          <button type="submit" style={{ padding: "10px 14px", fontSize: 16 }}>Send link</button>
        </form>
        {status && <p style={{ color: "#6b7280" }}>{status}</p>}
      </main>
    );
  }

  return <Dashboard session={session} />;
}

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

function Dashboard({ session }) {
  const [txns, setTxns] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [msg, setMsg] = useState("");

  async function load() {
    const [a, t] = await Promise.all([
      supabase.from("accounts").select("id, name, mask"),
      supabase.from("transactions").select("id, posted_date, merchant, amount, pending, plaid_category, account_id, is_transfer").order("posted_date", { ascending: false }).limit(300),
    ]);
    if (t.error) return setMsg("Could not load transactions.");
    setAccounts(Object.fromEntries((a.data || []).map((x) => [x.id, x])));
    setTxns(t.data);
  }

  async function refresh() {
    setMsg("Refreshing from your banks...");
    const r = await fetch("/api/plaid/sync", { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `Up to date. ${d.added} new, ${d.modified} changed, ${d.removed} removed.` : "Refresh failed. Try again.");
    load();
  }

  useEffect(() => { load(); }, []);

  // Spending = money out in the last 30 days, not counting transfers between your own accounts.
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const spent = (txns || []).filter((t) => t.amount > 0 && !t.is_transfer && t.posted_date >= since).reduce((s, t) => s + Number(t.amount), 0);

  return (
    <main style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 24 }}>Expenses</h1>
        <button onClick={() => supabase.auth.signOut()} style={{ padding: "6px 10px" }}>Sign out</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <ConnectBank session={session} onChange={load} />
        <button onClick={refresh} style={{ padding: "10px 14px", fontSize: 16, margin: "12px 0" }}>Refresh</button>
      </div>
      {msg && <p style={{ color: "#6b7280" }}>{msg}</p>}

      {txns === null ? (
        <p>Loading...</p>
      ) : txns.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No transactions yet. Connect a bank to get started.</p>
      ) : (
        <>
          <p style={{ fontWeight: 600 }}>Spent in the last 30 days: {money(spent)}</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {txns.map((t) => {
              const acct = accounts[t.account_id];
              return (
                <li key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid #e5e7eb" }}>
                  <span>
                    {t.merchant || "Unknown"}
                    {t.pending && <small style={{ color: "#b45309" }}> · pending</small>}
                    <br />
                    <small style={{ color: "#6b7280" }}>
                      {t.posted_date}
                      {acct ? ` · ${acct.name}${acct.mask ? " ••" + acct.mask : ""}` : ""}
                      {t.plaid_category ? ` · ${t.plaid_category.replace(/_/g, " ").toLowerCase()}` : ""}
                    </small>
                  </span>
                  <strong style={{ color: t.amount < 0 ? "#15803d" : undefined, whiteSpace: "nowrap" }}>
                    {t.amount < 0 ? "+" + money(-Number(t.amount)) : money(Number(t.amount))}
                  </strong>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
