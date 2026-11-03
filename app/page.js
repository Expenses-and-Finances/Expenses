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

// Reconnect an existing bank (Plaid update mode), then reload its transactions.
function ReconnectBank({ session, item, onDone }) {
  const [msg, setMsg] = useState("");
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.access_token}` };
  async function go() {
    try {
      setMsg("Opening Plaid...");
      const res = await fetch("/api/plaid/link-token", { method: "POST", headers, body: JSON.stringify({ item_id: item.item_id }) });
      const data = await res.json();
      if (!res.ok) return setMsg("Could not start the reconnect.");
      const Plaid = await loadPlaid();
      Plaid.create({
        token: data.link_token,
        onSuccess: async () => {
          setMsg("Reconnected. Reloading transactions...");
          const r = await fetch("/api/plaid/sync", { method: "POST", headers, body: JSON.stringify({ item_id: item.item_id }) });
          const d = await r.json().catch(() => ({}));
          setMsg(r.ok ? `Done. ${d.added || 0} new, ${d.modified || 0} updated.` : "Reconnected, but loading failed. Press Refresh.");
          onDone();
        },
        onExit: (err) => setMsg(err ? "Plaid closed with an error." : ""),
      }).open();
    } catch {
      setMsg("Something went wrong. Try again.");
    }
  }
  return (
    <span>
      <button onClick={go} style={{ fontSize: 12, padding: "2px 8px", marginLeft: 6 }}>Reconnect</button>
      {msg && <small style={{ color: "#6b7280", marginLeft: 6 }}>{msg}</small>}
    </span>
  );
}

function ConnectBank({ session, onChange, profile = "primary", label = "Connect bank" }) {
  const [msg, setMsg] = useState("");
  const headers = { "content-type": "application/json", authorization: `Bearer ${session.access_token}` };

  async function connect() {
    try {
      setMsg("Opening Plaid...");
      const res = await fetch("/api/plaid/link-token", { method: "POST", headers, body: JSON.stringify({ profile }) });
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
            body: JSON.stringify({ public_token, institution: metadata?.institution?.name, profile }),
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
      <button onClick={connect} style={{ padding: "10px 14px", fontSize: 16 }}>{label}</button>
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

// Estimate a fixed-rate loan from its last statement: each matching payment after the statement date
// pays that period's interest (balance x rate x days / 365) first, and the rest reduces the balance.
// Level 2: Plaid's detailed label without its broad prefix, e.g. GENERAL_MERCHANDISE_SUPERSTORES -> "Superstores".
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-\/&])\w/g, (c) => c.toUpperCase());
function subLabel(t) {
  const d = t.plaid_category_detailed || "";
  const p = t.plaid_category || "";
  if (!d) return "Other";
  return titleCase((d.startsWith(p + "_") ? d.slice(p.length + 1) : d).replace(/_/g, " "));
}

// Group store variants together: "SAFEWAY #1234 SAN JOSE" and "Safeway" -> "Safeway".
function merchantKey(t) {
  const m = (t.merchant || "Unknown")
    .replace(/^(sq|tst|sp|pp|paypal)\s*\*\s*/i, "")
    .replace(/\s*(#|store\s*#?|no\.?)\s*\d+.*$/i, "")
    .replace(/\s+\d{3,}.*$/, "")
    .replace(/[*].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = titleCase(m || "Unknown");
  const alias = [[/^amzn|^amazon/i, "Amazon"], [/^costco/i, "Costco"], [/^wal-?mart/i, "Walmart"], [/^target\b/i, "Target"], [/^uber\s*eats/i, "Uber Eats"], [/^uber\b/i, "Uber"], [/^lyft/i, "Lyft"], [/^safeway/i, "Safeway"], [/^whole\s*foods|^wfm/i, "Whole Foods"], [/^trader\s*joe/i, "Trader Joe's"]];
  for (const [re, to] of alias) if (re.test(name)) return to;
  return name;
}

function groupBy(list, keyFn) {
  const out = {};
  for (const t of list) {
    const k = keyFn(t);
    out[k] = out[k] || { key: k, total: 0, count: 0 };
    out[k].total += Number(t.amount);
    out[k].count += 1;
  }
  return Object.values(out).sort((a, b) => b.total - a.total);
}

function estimateLoan(account, txns) {
  if (!account.is_manual || !account.apr || !account.payment_amount || account.current_balance == null) return null;
  const re = likeToRegex(account.payment_pattern || "%");
  const start = String(account.balance_updated_at || "").slice(0, 10);
  const pays = txns
    .filter((t) => t.posted_date > start && Math.abs(Number(t.amount) - Number(account.payment_amount)) < 0.005 && re.test(t.merchant || ""))
    .sort((a, b) => a.posted_date.localeCompare(b.posted_date));
  let balance = Number(account.current_balance), last = start, interest = 0, principal = 0;
  const rows = [];
  for (const t of pays) {
    const days = Math.max(1, Math.round((new Date(t.posted_date) - new Date(last)) / 864e5));
    const i = Math.round(balance * Number(account.apr) * days / 365 * 100) / 100;
    const p = Math.round((Number(t.amount) - i) * 100) / 100;
    balance = Math.round((balance - p) * 100) / 100;
    interest += i; principal += p; last = t.posted_date;
    rows.push({ date: t.posted_date, interest: i, principal: p, balance });
  }
  return { balance, payments: rows.length, interest, principal, rows };
}

const monthsOld = (d) => (d ? (Date.now() - new Date(d)) / (30.44 * 864e5) : 0);

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

// Every connected account, grouped by bank, with last 4 digits and the balance from the latest sync.
// Loans and credit cards show what you owe.
function AccountsList({ accounts, txns, crypto = [], session, onChange }) {
  const banks = {};
  for (const a of accounts) (banks[a.institution || "Other"] = banks[a.institution || "Other"] || []).push(a);
  const order = { depository: 1, credit: 2, loan: 3, investment: 4 };
  const label = (a) => (a.subtype || a.type || "").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <section style={{ marginBottom: 16, border: "1px solid #e5e7eb", borderRadius: 8, padding: "4px 10px" }}>
      {Object.entries(banks).sort().map(([bank, list]) => (
        <div key={bank} style={{ padding: "6px 0" }}>
          <strong>{bank}</strong> <small style={{ color: "#6b7280" }}>· {list.length} accounts</small>
          {(() => {
            const ids = new Set(list.map((a) => a.id));
            const last = txns.filter((t) => ids.has(t.account_id)).reduce((m, t) => (t.posted_date > m ? t.posted_date : m), "");
            const stale = last && (Date.now() - new Date(last).getTime()) / 864e5 > 14;
            const itemId = list.find((a) => a.plaid_item_id)?.plaid_item_id;
            return (
              <>
                {last && <small style={{ color: stale ? "#b45309" : "#6b7280" }}> · latest {last}{stale ? " ⚠️" : ""}</small>}
                {itemId && <ReconnectBank session={session} item={{ item_id: itemId }} onDone={onChange} />}
              </>
            );
          })()}
          {list.sort((x, y) => (order[x.type] || 9) - (order[y.type] || 9)).map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", borderBottom: "1px solid #f3f4f6", fontSize: 14 }}>
              <span>
                {a.name} {a.mask && <span style={{ color: "#6b7280" }}>••{a.mask}</span>}
                {a.owner_person === "Wife" && <small style={{ marginLeft: 6, padding: "0 6px", borderRadius: 8, background: "#fce7f3", color: "#9d174d" }}>Wife</small>}
                <br />
                <small style={{ color: "#6b7280" }}>
                  {label(a)}
                  {a.is_manual && ` · from statement, as of ${String(a.balance_updated_at || "").slice(0, 10)}`}
                </small>
                {a.is_manual && a.balance_note && <><br /><small style={{ color: "#6b7280" }}>{a.balance_note}</small></>}
                {a.institution === "Coinbase (holdings)" && crypto.length > 0 && (
                  <><br /><small style={{ color: "#6b7280" }}>
                    {crypto.filter((h) => Number(h.last_value) >= 1).map((h) => `${h.symbol} ${Number(h.quantity)} = ${money(Number(h.last_value))}`).join(" · ")}
                    {crypto.some((h) => !(Number(h.last_value) >= 1)) && ` · ${crypto.filter((h) => !(Number(h.last_value) >= 1)).length} small coins under $1`}
                  </small></>
                )}
                {(() => {
                  const e = estimateLoan(a, txns);
                  if (!e) return null;
                  return (
                    <><br /><small style={{ color: "#4f46e5" }}>
                      {e.payments
                        ? `Estimated now: ${money(e.balance)} after ${e.payments} payment${e.payments > 1 ? "s" : ""} since the statement (interest ${money(e.interest)}, principal ${money(e.principal)}, at ${(Number(a.apr) * 100).toFixed(2)}%)`
                        : `No payments since the statement yet. Next estimate uses ${(Number(a.apr) * 100).toFixed(2)}% on each ${money(Number(a.payment_amount))} payment.`}
                    </small></>
                  );
                })()}
              </span>
              <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {a.current_balance == null ? <small style={{ color: "#6b7280" }}>press Refresh</small> : (
                  <>
                    <strong style={{ color: a.type === "loan" || a.type === "credit" ? "#b91c1c" : undefined }}>
                      {a.type === "loan" || a.type === "credit" ? "owe " : ""}{money(Number(a.current_balance))}
                    </strong>
                    {a.available_balance != null && a.type === "depository" && Number(a.available_balance) !== Number(a.current_balance) && (
                      <><br /><small style={{ color: "#6b7280" }}>available {money(Number(a.available_balance))}</small></>
                    )}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
      <p style={{ color: "#6b7280", margin: "6px 0" }}><small>Connected balances update each time you press Refresh, and banks may report them with a short delay. Accounts marked "from statement" update when a new statement is entered.</small></p>
    </section>
  );
}

function Dashboard({ session }) {
  const [txns, setTxns] = useState(null);
  const [accounts, setAccounts] = useState({});
  const [cats, setCats] = useState([]);
  const [props, setProps] = useState([]);
  const [rules, setRules] = useState([]);
  const [crypto, setCrypto] = useState([]);
  const [filterProp, setFilterProp] = useState(null); // null = all, "household", or a property id
  const [period, setPeriod] = useState("30d");
  const [filterCat, setFilterCat] = useState(null);
  const [drill, setDrill] = useState(null); // { kind: "sub" | "merchant", key } inside the chosen category
  const [allMerchants, setAllMerchants] = useState(false);
  const [msg, setMsg] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);

  async function load() {
    const [a, c, p, cr, r, t] = await Promise.all([
      supabase.from("accounts").select("id, name, mask, plaid_item_id, property_id, owner_person, type, subtype, institution, current_balance, available_balance, balance_updated_at, is_manual, balance_note, apr, payment_amount, payment_pattern"),
      supabase.from("categories").select("id, name, plaid_codes, sort").order("sort"),
      supabase.from("properties").select("id, name, sort").order("sort"),
      supabase.from("crypto_holdings").select("symbol, quantity, last_price, last_value, price_updated_at").order("last_value", { ascending: false, nullsFirst: false }),
      supabase.from("rules").select("id, pattern, property_id, category_id, is_transfer, note, direction, label").order("created_at"),
      loadAllTransactions(),
    ]);
    if (t.error) return setMsg("Could not load transactions.");
    setAccounts(Object.fromEntries((a.data || []).map((x) => [x.id, x])));
    setCats(c.data || []);
    setProps(p.data || []);
    setCrypto(cr.data || []);
    setRules((r.data || []).map((x) => ({ ...x, re: likeToRegex(x.pattern) })));
    setTxns(t.data);
  }

  // Refresh one bank per request (stays within Cloudflare's free-plan limits), then match properties and price crypto.
  async function refresh() {
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.access_token}` };
    const post = (path, body) => fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) }).then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }));
    setMsg("Refreshing...");
    const list = await post("/api/plaid/items");
    if (!list.ok) return setMsg("Refresh failed. Try again.");
    const totals = { added: 0, modified: 0, removed: 0 }, failed = [];
    for (const [i, item] of list.d.items.entries()) {
      setMsg(`Refreshing ${i + 1} of ${list.d.items.length}: ${item.institution || "bank"}...`);
      const r = await post("/api/plaid/sync", { item_id: item.item_id });
      if (r.ok) { totals.added += r.d.added; totals.modified += r.d.modified; totals.removed += r.d.removed; }
      else failed.push(item.institution || "a bank");
    }
    await post("/api/plaid/match");
    await post("/api/crypto/update");
    setMsg(`Up to date. ${totals.added} new, ${totals.modified} changed, ${totals.removed} removed.` + (failed.length ? ` Could not refresh: ${failed.join(", ")}.` : ""));
    load();
  }

  useEffect(() => { load(); }, []);

  // Payee rules sit between your manual choice and the automatic labels.
  // A rule can be limited to money in (e.g. rent deposits) or money out.
  const ruleFor = (t) => rules.find((r) =>
    (!r.direction || (r.direction === "in" ? t.amount < 0 : t.amount > 0)) && r.re.test(t.merchant || ""));

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

  // After a fix, offer to remember it for every purchase from the same store.
  const [offer, setOffer] = useState(null); // { txnId, merchant, catId }
  async function rememberForMerchant() {
    const { merchant, catId } = offer;
    const pattern = "%" + merchant.replace(/[%_]/g, "") + "%";
    const { error } = await supabase.from("rules").insert({ pattern, category_id: catId, direction: "out", note: "Set from the app: " + merchant });
    setOffer(null);
    if (error) return setMsg("Could not save that rule.");
    // The rule now covers this purchase too, so the one-off choice is no longer needed.
    const re = likeToRegex(pattern);
    const same = (txns || []).filter((x) => x.category_id === catId && re.test(x.merchant || ""));
    for (const x of same) await supabase.from("transactions").update({ category_id: null }).eq("id", x.id);
    setMsg(`Got it: everything from ${merchant} now goes to ${cats.find((c) => c.id === catId)?.name}.`);
    load();
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
  const inCat = filterCat ? spending.filter((t) => catOf(t)?.id === filterCat) : [];
  const subOf = (t) => ruleFor(t)?.label || subLabel(t);
  const subs = groupBy(inCat, subOf);
  const merchants = groupBy(inCat, merchantKey);
  if (filterCat) {
    shown = inCat;
    if (drill?.kind === "sub") shown = inCat.filter((t) => subOf(t) === drill.key);
    if (drill?.kind === "merchant") shown = inCat.filter((t) => merchantKey(t) === drill.key);
  }
  else if (filterProp === "household") shown = household;
  else if (filterProp) shown = real.filter((t) => propOf(t) === filterProp);
  const pick = (cat, prop) => { setFilterCat(cat); setFilterProp(prop); setDrill(null); setAllMerchants(false); };
  const toggleDrill = (kind, key) => setDrill(drill?.kind === kind && drill.key === key ? null : { kind, key });
  const catTotal = inCat.reduce((s, t) => s + Number(t.amount), 0) || 1;
  const lines = (list) => (
    <div style={{ margin: "2px 0 8px 10px" }}>
      {list.slice().sort((a, b) => (a.posted_date < b.posted_date ? 1 : -1)).map((t) => (
        <div key={t.id} style={{ padding: "6px 4px", borderBottom: "1px dashed #e5e7eb", fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{t.posted_date.slice(5)} · {t.merchant}{accounts[t.account_id]?.mask ? <small style={{ color: "#6b7280" }}> ••{accounts[t.account_id].mask}</small> : null}</span>
            <strong style={{ whiteSpace: "nowrap" }}>{money(Number(t.amount))}</strong>
          </div>
          <label style={{ fontSize: 12, color: "#6b7280" }}>
            Wrong section? Move to{" "}
            <select
              value={catOf(t)?.id || ""}
              onChange={(e) => { setCategory(t, e.target.value); setOffer({ txnId: t.id, merchant: merchantKey(t), catId: e.target.value }); }}
              style={{ fontSize: 12, padding: "1px 2px", maxWidth: 170 }}
            >
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {offer?.txnId === t.id && (
            <div style={{ marginTop: 4, fontSize: 12, background: "#ecfdf5", padding: "4px 6px", borderRadius: 4 }}>
              Moved. Do the same for every purchase from <b>{offer.merchant}</b>?{" "}
              <button onClick={rememberForMerchant} style={{ fontSize: 12, padding: "1px 6px" }}>Yes, always</button>{" "}
              <button onClick={() => setOffer(null)} style={{ fontSize: 12, padding: "1px 6px" }}>Just this one</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
  const row = (kind, g) => (
    <div key={kind + g.key}>
    <button
      onClick={() => toggleDrill(kind, g.key)}
      style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8, textAlign: "left", background: drill?.kind === kind && drill.key === g.key ? "#e0e7ff" : "transparent", border: "none", borderBottom: "1px solid #eef2ff", padding: "5px 4px", cursor: "pointer", fontSize: 14 }}
    >
      <span>{g.key} <small style={{ color: "#6b7280" }}>×{g.count}</small></span>
      <span style={{ whiteSpace: "nowrap" }}>{money(g.total)} <small style={{ color: "#6b7280" }}>{Math.round((g.total / catTotal) * 100)}%</small> {drill?.kind === kind && drill.key === g.key ? "▾" : "▸"}</span>
    </button>
    {drill?.kind === kind && drill.key === g.key && lines(shown)}
    </div>
  );
  const details = filterCat && (
    <div style={{ margin: "4px 0 10px 12px", padding: "6px 8px", borderLeft: "3px solid #c7d2fe" }}>
      {subs.length > 1 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", margin: "2px 0" }}>BY TYPE</div>
          {subs.map((g) => row("sub", g))}
        </>
      )}
      <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", margin: "8px 0 2px" }}>WHERE</div>
      {(allMerchants ? merchants : merchants.slice(0, 8)).map((g) => row("merchant", g))}
      {merchants.length > 8 && (
        <button onClick={() => setAllMerchants(!allMerchants)} style={{ border: "none", background: "none", color: "#4f46e5", textDecoration: "underline", cursor: "pointer", padding: "4px 0", fontSize: 13 }}>
          {allMerchants ? "show top 8" : `show all ${merchants.length}`}
        </button>
      )}
    </div>
  );

  return (
    <main style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 24 }}>Expenses</h1>
        <button onClick={() => supabase.auth.signOut()} style={{ padding: "6px 10px" }}>Sign out</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <ConnectBank session={session} onChange={load} />
        <ConnectBank session={session} onChange={load} profile="wife" label="Connect wife's bank" />
        <button onClick={refresh} style={{ padding: "10px 14px", fontSize: 16, margin: "12px 0" }}>Refresh</button>
      </div>
      {msg && <p style={{ color: "#6b7280" }}>{msg}</p>}

      <button onClick={() => setShowAccounts(!showAccounts)} style={{ padding: "6px 10px", marginBottom: 8 }}>
        {showAccounts ? "Hide accounts" : `Connected accounts (${Object.keys(accounts).length})`}
      </button>
      {showAccounts && <AccountsList accounts={Object.values(accounts)} txns={txns || []} crypto={crypto} session={session} onChange={load} />}
      {Object.values(accounts).some((a) => a.is_manual && monthsOld(a.balance_updated_at) >= 6) && (
        <p style={{ background: "#fef3c7", padding: "8px 10px", borderRadius: 6, fontSize: 14 }}>
          📄 Time for a new statement: {Object.values(accounts).filter((a) => a.is_manual && monthsOld(a.balance_updated_at) >= 6).map((a) => a.name).join(", ")}
        </p>
      )}

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
              <div key={c.id}>
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
              {filterCat === c.id && details}
              </div>
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
              Showing {filterCat ? cats.find((c) => c.id === filterCat)?.name + (drill ? " › " + drill.key : "") : filterProp === "household" ? "Household" : props.find((p) => p.id === filterProp)?.name} only ·{" "}
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
