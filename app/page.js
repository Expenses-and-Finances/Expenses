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

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (d) => d.toISOString().slice(0, 10);

// Rule patterns use % for "anything", like the database. Matching ignores capitals.
const likeToRegex = (pattern) =>
  new RegExp("^" + pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");

// Rent paid near the end of a month (day 25 or later) counts for the next month.
function rentMonths(payments, months = 12) {
  const byMonth = {};
  for (const t of payments) {
    const [y, m, d] = t.posted_date.split("-").map(Number);
    const key = d >= 25 ? (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`) : `${y}-${String(m).padStart(2, "0")}`;
    (byMonth[key] = byMonth[key] || []).push(t);
  }
  const now = new Date();
  const out = [];
  for (let i = 0; i < months; i++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: dt.toLocaleString("en-US", { month: "short", year: "numeric" }), items: byMonth[key] || [] });
  }
  return out;
}
const PERIODS = {
  "30d": { label: "Last 30 days", range: () => [day(new Date(Date.now() - 30 * 864e5)), day(new Date())] },
  month: { label: "This month", range: () => { const n = new Date(); return [day(new Date(n.getFullYear(), n.getMonth(), 1)), day(n)]; } },
  last: { label: "Last month", range: () => { const n = new Date(); return [day(new Date(n.getFullYear(), n.getMonth() - 1, 1)), day(new Date(n.getFullYear(), n.getMonth(), 0))]; } },
  "90d": { label: "Last 90 days", range: () => [day(new Date(Date.now() - 90 * 864e5)), day(new Date())] },
  year: { label: "This year", range: () => { const n = new Date(); return [`${n.getFullYear()}-01-01`, day(n)]; } },
};

// The database returns at most 1,000 rows per request, so read transactions in pages.
async function loadAllTransactions() {
  const cols = "id, posted_date, merchant, amount, pending, plaid_category, plaid_category_detailed, account_id, category_id, is_transfer, auto_transfer, property_id, auto_property_id";
  let all = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await supabase.from("transactions").select(cols)
      .order("posted_date", { ascending: false }).order("id").range(from, from + 999);
    if (error) return { data: null, error };
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  return { data: all, error: null };
}

function Dashboard({ session }) {
  const [txns, setTxns] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [cats, setCats] = useState([]);
  const [props, setProps] = useState([]);
  const [rules, setRules] = useState([]);
  const [filterProp, setFilterProp] = useState(null); // null = all, "household", or a property id
  const [period, setPeriod] = useState("30d");
  const [filterCat, setFilterCat] = useState(null);
  const [msg, setMsg] = useState("");

  async function load() {
    const [a, c, p, r, t] = await Promise.all([
      supabase.from("accounts").select("id, name, mask, property_id"),
      supabase.from("categories").select("id, name, plaid_codes, sort").order("sort"),
      supabase.from("properties").select("id, name, sort").order("sort"),
      supabase.from("rules").select("id, pattern, property_id, category_id, is_transfer, note").order("created_at"),
      loadAllTransactions(),
    ]);
    if (t.error) return setMsg("Could not load transactions.");
    setAccounts(Object.fromEntries((a.data || []).map((x) => [x.id, x])));
    setCats(c.data || []);
    setProps(p.data || []);
    setRules((r.data || []).map((x) => ({ ...x, re: likeToRegex(x.pattern) })));
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

  // Payee rules sit between your manual choice and the automatic labels.
  const ruleFor = (t) => rules.find((r) => r.re.test(t.merchant || ""));

  // Your manual choice wins, then a payee rule, then the automatic label from the bank sync.
  const autoTransfer = (t) => ruleFor(t)?.is_transfer ?? t.auto_transfer;
  const transfer = (t) => (t.is_transfer ?? autoTransfer(t)) === true;

  // Automatic category: a specific Plaid label beats a broad one; anything unmatched goes to "Other".
  const byCode = {};
  for (const c of cats) for (const code of c.plaid_codes || []) byCode[code] = c;
  const other = cats.find((c) => c.name === "Other");
  const autoCat = (t) => {
    const rc = ruleFor(t)?.category_id;
    return (rc && cats.find((c) => c.id === rc)) || byCode[t.plaid_category_detailed] || byCode[t.plaid_category] || other;
  };
  const catOf = (t) => cats.find((c) => c.id === t.category_id) || autoCat(t);

  // Belongs to: your manual choice, else a matched loan payment, else the account's property, else Household (null).
  // "Household" is a real choice so a property item can be moved back to it.
  const householdId = props.find((p) => p.name === "Household")?.id;
  const autoProp = (t) => ruleFor(t)?.property_id || t.auto_property_id || accounts[t.account_id]?.property_id || null;
  const rawProp = (t) => t.property_id || autoProp(t);
  const propOf = (t) => { const p = rawProp(t); return p === householdId ? null : p; };
  const realProps = props.filter((p) => p.id !== householdId);

  async function save(t, changes) {
    setTxns((list) => list.map((x) => (x.id === t.id ? { ...x, ...changes } : x)));
    const { error } = await supabase.from("transactions").update(changes).eq("id", t.id);
    if (error) { setMsg("Could not save that change."); load(); }
  }

  function toggleTransfer(t) {
    const next = !transfer(t);
    // Setting it back to match the automatic label clears the manual choice.
    save(t, { is_transfer: next === Boolean(autoTransfer(t)) ? null : next });
  }

  function setProperty(t, id) {
    const auto = autoProp(t) || householdId;
    // Choosing the automatic option clears the manual choice, so future matching still applies.
    save(t, { property_id: id === auto ? null : id });
  }

  function setCategory(t, id) {
    // Picking the automatic category clears the manual choice, so future label fixes still apply.
    save(t, { category_id: id === autoCat(t)?.id ? null : id });
  }

  const [from, to] = PERIODS[period].range();
  const inPeriod = (txns || []).filter((t) => t.posted_date >= from && t.posted_date <= to);
  const real = inPeriod.filter((t) => !transfer(t));
  const household = real.filter((t) => !propOf(t));
  const spending = household.filter((t) => t.amount > 0);
  const spent = spending.reduce((s, t) => s + Number(t.amount), 0);
  const moved = inPeriod.filter((t) => t.amount > 0 && transfer(t)).reduce((s, t) => s + Number(t.amount), 0);

  // Each property: costs (money out), income (money in, e.g. rent), and net.
  const propRows = realProps.map((p) => {
    const items = real.filter((t) => propOf(t) === p.id);
    const costs = items.filter((t) => t.amount > 0).reduce((s, t) => s + Number(t.amount), 0);
    const income = items.filter((t) => t.amount < 0).reduce((s, t) => s - Number(t.amount), 0);
    return { ...p, costs, income, net: income - costs, count: items.length };
  });

  const totals = {};
  for (const t of spending) { const c = catOf(t); if (c) totals[c.id] = (totals[c.id] || 0) + Number(t.amount); }
  const breakdown = cats.filter((c) => totals[c.id]).map((c) => ({ ...c, total: totals[c.id] })).sort((x, y) => y.total - x.total);
  const top = breakdown[0]?.total || 1;

  let shown = inPeriod;
  if (filterCat) shown = spending.filter((t) => catOf(t)?.id === filterCat);
  else if (filterProp === "household") shown = household;
  else if (filterProp) shown = real.filter((t) => propOf(t) === filterProp);
  const pick = (cat, prop) => { setFilterCat(cat); setFilterProp(prop); };

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
          <select value={period} onChange={(e) => { setPeriod(e.target.value); pick(null, null); }} style={{ padding: 8, fontSize: 16, marginBottom: 8 }}>
            {Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>

          <p style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 2px", cursor: "pointer" }} onClick={() => pick(null, filterProp === "household" ? null : "household")}>
            Household spent: {money(spent)}
          </p>
          <p style={{ color: "#6b7280", marginTop: 0 }}><small>Not counted: {money(moved)} moved between your accounts</small></p>

          <section style={{ margin: "12px 0 20px" }}>
            {breakdown.map((c) => (
              <button
                key={c.id}
                onClick={() => pick(filterCat === c.id ? null : c.id, null)}
                style={{ display: "block", width: "100%", textAlign: "left", background: filterCat === c.id ? "#eef2ff" : "transparent", border: "none", padding: "6px 4px", cursor: "pointer", borderRadius: 6 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
                  <span>{c.name}</span>
                  <span>{money(c.total)} <small style={{ color: "#6b7280" }}>{Math.round((c.total / spent) * 100)}%</small></span>
                </div>
                <div style={{ height: 8, background: "#e5e7eb", borderRadius: 4, marginTop: 4 }}>
                  <div style={{ height: 8, width: `${(c.total / top) * 100}%`, background: "#4f46e5", borderRadius: 4 }} />
                </div>
              </button>
            ))}
          </section>

          <h2 style={{ fontSize: 17, margin: "8px 0 6px" }}>Properties</h2>
          <section style={{ marginBottom: 20 }}>
            {propRows.map((p) => (
              <button
                key={p.id}
                onClick={() => pick(null, filterProp === p.id ? null : p.id)}
                style={{ display: "flex", justifyContent: "space-between", width: "100%", textAlign: "left", background: filterProp === p.id ? "#eef2ff" : "transparent", border: "none", borderBottom: "1px solid #e5e7eb", padding: "8px 4px", cursor: "pointer", gap: 8 }}
              >
                <span style={{ fontSize: 15 }}>{p.name}</span>
                <span style={{ fontSize: 13, textAlign: "right", whiteSpace: "nowrap" }}>
                  {p.income > 0 && <span style={{ color: "#15803d" }}>in {money(p.income)} · </span>}
                  <span>out {money(p.costs)}</span>
                  <br />
                  <strong style={{ color: p.net >= 0 ? "#15803d" : "#b91c1c" }}>net {p.net >= 0 ? "+" : ""}{money(p.net)}</strong>
                </span>
              </button>
            ))}
          </section>

          {(() => {
            const rentRule = rules.find((r) => /rent/i.test(r.note || ""));
            if (!rentRule) return null;
            const pays = (txns || []).filter((t) => t.amount > 0 && rentRule.re.test(t.merchant || ""));
            return (
              <>
                <h2 style={{ fontSize: 17, margin: "8px 0 6px" }}>Rent</h2>
                <p style={{ color: "#6b7280", marginTop: 0 }}><small>{rentRule.note}. Paid on the 25th or later counts for next month. Only payments from connected accounts show here.</small></p>
                <section style={{ marginBottom: 20 }}>
                  {rentMonths(pays).map((m) => {
                    const total = m.items.reduce((s, t) => s + Number(t.amount), 0);
                    return (
                      <div key={m.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 4px", borderBottom: "1px solid #e5e7eb", fontSize: 14 }}>
                        <span>{m.label}</span>
                        {m.items.length ? (
                          <span style={{ textAlign: "right" }}>
                            <span style={{ color: "#15803d" }}>✓ {money(total)}</span>
                            <br />
                            <small style={{ color: "#6b7280" }}>
                              {m.items.map((t) => `${t.posted_date}${accounts[t.account_id]?.mask ? " ••" + accounts[t.account_id].mask : ""}`).join(", ")}
                            </small>
                          </span>
                        ) : (
                          <span style={{ color: "#b45309" }}>not paid from these accounts</span>
                        )}
                      </div>
                    );
                  })}
                </section>
              </>
            );
          })()}

          {(filterCat || filterProp) && (
            <p style={{ color: "#4f46e5" }}>
              Showing {filterCat ? cats.find((c) => c.id === filterCat)?.name : filterProp === "household" ? "Household" : props.find((p) => p.id === filterProp)?.name} only ·{" "}
              <button onClick={() => pick(null, null)} style={{ border: "none", background: "none", color: "#4f46e5", textDecoration: "underline", cursor: "pointer", padding: 0 }}>show all</button>
            </p>
          )}

          <ul style={{ listStyle: "none", padding: 0 }}>
            {shown.map((t) => {
              const acct = accounts[t.account_id];
              const isT = transfer(t);
              const cat = catOf(t);
              return (
                <li key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid #e5e7eb", opacity: isT ? 0.55 : 1 }}>
                  <span style={{ minWidth: 0 }}>
                    {t.merchant || "Unknown"}
                    {t.pending && <small style={{ color: "#b45309" }}> · pending</small>}
                    <br />
                    <small style={{ color: "#6b7280" }}>
                      {t.posted_date}
                      {acct ? ` · ${acct.name}${acct.mask ? " ••" + acct.mask : ""}` : ""}
                    </small>
                    <br />
                    {t.amount > 0 && !isT && (
                      <select
                        value={cat?.id || ""}
                        onChange={(e) => setCategory(t, e.target.value)}
                        style={{ marginTop: 4, fontSize: 13, padding: "2px 4px", maxWidth: "100%", border: "1px solid #d1d5db", borderRadius: 6, background: t.category_id ? "#eef2ff" : "#fff" }}
                      >
                        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                    {t.amount < 0 && !isT && <small style={{ color: "#15803d" }}>money in </small>}
                    {!isT && (
                      <select
                        value={propOf(t) || householdId || ""}
                        onChange={(e) => setProperty(t, e.target.value)}
                        style={{ marginTop: 4, marginLeft: 4, fontSize: 13, padding: "2px 4px", maxWidth: "100%", border: "1px solid #d1d5db", borderRadius: 6, background: t.property_id ? "#eef2ff" : "#fff" }}
                      >
                        {householdId && <option value={householdId}>Household</option>}
                        {realProps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </span>
                  <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <strong style={{ color: t.amount < 0 ? "#15803d" : undefined }}>
                      {t.amount < 0 ? "+" + money(-Number(t.amount)) : money(Number(t.amount))}
                    </strong>
                    <br />
                    <button
                      onClick={() => toggleTransfer(t)}
                      style={{ marginTop: 4, padding: "2px 8px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 12, background: isT ? "#e5e7eb" : "#fff", color: "#374151" }}
                    >
                      {isT ? "Transfer ✓" : "Transfer?"}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
