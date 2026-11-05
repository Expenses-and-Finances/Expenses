"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";


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
    <>
      <button onClick={go} className="btn btn-small">Reconnect</button>
      {msg && <span className="acct-note">{msg}</span>}
    </>
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
    <div>
      <button onClick={connect} className="btn">{label}</button>
      {msg && <p className="status" style={{ marginTop: 6 }}>{msg}</p>}
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
    return <main className="app"><p className="status">Loading...</p></main>;
  }

  if (!supabase) {
    return (
      <main className="signin">
        <h1>Expenses</h1>
        <p>The app is missing its connection settings. Ask for the setup steps.</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="signin">
        <h1>Expenses</h1>
        <p>Sign in with your email. We'll send you a one-time link.</p>
        <form onSubmit={sendLink}>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button type="submit" className="btn btn-primary">Send link</button>
        </form>
        {status && <p>{status}</p>}
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
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-\/&])\w/g, (c) => c.toUpperCase()).replace(/ (And|Or|Of|The|For|To|In) /g, (w) => w.toLowerCase());
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

const nextMonth = (y, m) => (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`);
// Which month a rent payment is for: a month set by hand wins, otherwise day 25 or later counts for the next month.
const rentKeyOf = (t) => {
  const [y, m, d] = t.posted_date.split("-").map(Number);
  return t.rent_month || (d >= 25 ? nextMonth(y, m) : `${y}-${String(m).padStart(2, "0")}`);
};
const short$ = (n) => (n >= 9950 ? `$${(n / 1000).toFixed(0)}k` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);
// Fixed order of series colors for the trends chart; the 8th slot is "everything else".
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
const OTHER_COLOR = "#b4bcb6";

// Rent paid near the end of a month (day 25 or later) counts for the next month, unless a month was set by hand.
// Returned payments come in as negative amounts and cancel out the payment they reverse.
function rentMonths(payments, months = 12) {
  const byMonth = {};
  for (const t of payments) {
    const key = rentKeyOf(t);
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

// Small line drawings for each category, picked by name.
const ICONS = [
  [/grocer/i, <><path d="M3 4h2l2.3 10.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.1" /><circle cx="9" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /><path d="M9 8V6.2a1.6 1.6 0 0 1 3.2 0V8" /><path d="M13.5 8V4.5h3V8" /><path d="M7.5 11h11" /></>],
  [/shop/i, <><path d="M5.5 8h13l-1.1 12H6.6z" /><path d="M9 10V6.5a3 3 0 0 1 6 0V10" /></>],
  [/home|utilit/i, <><path d="M3.5 11 12 4l8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></>],
  [/health|personal/i, <><path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z" /><path d="M7.5 12h2.5l1.2-2 1.6 4 1.2-2h2.5" /></>],
  [/gift/i, <><path d="M7.5 6.2 17.8 4.4a1.4 1.4 0 0 1 1.6 1.1l1 5.6" /><rect x="3" y="8.5" width="15" height="10" rx="1.6" /><path d="M3 12h15" /><path d="M6 15.5h3.5" /></>],
  [/entertain/i, <><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z" /><path d="M14 7v2.5M14 12v.5M14 15v2" /></>],
  [/travel/i, <><path transform="rotate(45 12 12)" d="M12 2.5c1 0 1.6 1 1.6 2.4V9l7 4.2V15l-7-2.2v4.6l2.2 1.7v1.4L12 19.6l-3.8.9v-1.4l2.2-1.7v-4.6l-7 2.2v-1.8l7-4.2V4.9C10.4 3.5 11 2.5 12 2.5z" /></>],
  [/dining|coffee|food/i, <><path d="M5 9h11v4.5A5.5 5.5 0 0 1 10.5 19A5.5 5.5 0 0 1 5 13.5z" /><path d="M16 10.5h1.6a2.2 2.2 0 0 1 0 4.4H16" /><path d="M8.5 3.5v2.5M11.5 3.5v2.5" /></>],
  [/fee|tax|donat/i, <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 11.5h6M9 15h3.5" /></>],
  [/transport|\bcar\b/i, <><path d="M3.5 15.5V12l2-5h13l2 5v3.5z" /><path d="M3.5 12h17" /><circle cx="7.5" cy="15.5" r="1.8" /><circle cx="16.5" cy="15.5" r="1.8" /></>],
  [/servic|subscri/i, <><path d="M19.5 10.5A7.5 7.5 0 0 0 6 6.6L4.5 8" /><path d="M4.5 4v4h4" /><path d="M4.5 13.5A7.5 7.5 0 0 0 18 17.4l1.5-1.4" /><path d="M19.5 20v-4h-4" /></>],
  [/sofia/i, <><circle cx="12" cy="9" r="4.2" /><path d="M8 8c2.6.3 5.6-.6 7-2.4" /><path d="M7.9 7.4c-1.8.2-2.8 1.8-2.4 3.8.9-.3 1.7-1 2.2-1.9M16.1 7.4c1.8.2 2.8 1.8 2.4 3.8-.9-.3-1.7-1-2.2-1.9" /><path d="M10.4 10.4h.01M13.6 10.4h.01" /><path d="M5 20.5c.6-3.5 3.5-5.5 7-5.5s6.4 2 7 5.5" /></>],
  [/tomas/i, <><circle cx="12" cy="9.2" r="4.2" /><path d="M7.9 8.6C8.2 6 9.8 4.8 12 4.8s3.8 1.2 4.1 3.8c-1.6-.2-3.1-1-4.1-2.3-1 1.3-2.5 2.1-4.1 2.3z" /><path d="M10.4 10.6h.01M13.6 10.6h.01" /><path d="M5 20.5c.6-3.5 3.5-5.5 7-5.5s6.4 2 7 5.5" /></>],
  [/kid|activit/i, <><path d="M12 3.5a5 5 0 0 1 5 5c0 3.8-5 6.8-5 6.8S7 12.3 7 8.5a5 5 0 0 1 5-5z" /><path d="M12 15.3c-.8 1.6 1.4 2.4.4 4.2" /></>],
  [/loan|mortgage/i, <><path d="M3.5 9 12 4.5 20.5 9z" /><path d="M6 10.5v6.5M10 10.5v6.5M14 10.5v6.5M18 10.5v6.5" /><path d="M3.5 19.5h17" /></>],
  [/card/i, <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 14.5h4" /></>],
  [/rent|income/i, <><circle cx="8" cy="12" r="3.5" /><path d="M11.5 12H21M18 12v3M15.5 12v2" /></>],
];
const OTHER_ICON = <><circle cx="12" cy="12" r="8" /><circle cx="8.5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="15.5" cy="12" r=".8" /></>;
function CatIcon({ name }) {
  const found = ICONS.find(([re]) => re.test(name || ""));
  return (
    <span className="cat-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {found ? found[1] : OTHER_ICON}
      </svg>
    </span>
  );
}

// The database returns at most 1,000 rows per request, so read transactions in pages.
async function loadAllTransactions() {
  const cols = "id, posted_date, merchant, amount, pending, plaid_category, plaid_category_detailed, account_id, category_id, is_transfer, auto_transfer, property_id, auto_property_id, shared, stale, rent_month";
  let all = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await supabase.from("transactions").select(cols)
      .order("posted_date", { ascending: false }).order("id").range(from, from + 999);
    if (error) return { data: null, error };
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  // Copies the bank no longer lists (found by the duplicate check) are left out.
  return { data: all.filter((t) => !t.stale), error: null };
}

// Every connected account, grouped by bank, with last 4 digits and the balance from the latest sync.
// Loans and credit cards show what you owe.
function AccountsList({ accounts, txns, crypto = [], session, onChange, onSeparate, dupes = new Set() }) {
  const banks = {};
  for (const a of accounts) (banks[a.institution || "Other"] = banks[a.institution || "Other"] || []).push(a);
  const order = { depository: 1, credit: 2, loan: 3, investment: 4 };
  const label = (a) => (a.subtype || a.type || "").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <section className="section">
      <div className="sheet">
        <div className="connect">
          <ConnectBank session={session} onChange={onChange} />
          <ConnectBank session={session} onChange={onChange} profile="wife" label="Connect wife's bank" />
          <ConnectBank session={session} onChange={onChange} profile="silvina" label="Connect Silvina's bank" />
          <ConnectBank session={session} onChange={onChange} profile="mariana" label="Connect Mariana's bank" />
        </div>
        {Object.entries(banks).sort().map(([bank, list]) => {
          const ids = new Set(list.map((a) => a.id));
          const last = txns.filter((t) => ids.has(t.account_id)).reduce((m, t) => (t.posted_date > m ? t.posted_date : m), "");
          const stale = last && (Date.now() - new Date(last).getTime()) / 864e5 > 14;
          const itemId = list.find((a) => a.plaid_item_id)?.plaid_item_id;
          return (
            <div key={bank} className="bank">
              <div className="bank-head">
                <span className="bank-name">{bank}</span>
                <span className="acct-note">{list.length} {list.length === 1 ? "account" : "accounts"}</span>
                {last && <span className={"acct-note" + (stale ? " stale" : "")}>{stale ? "No new activity since " : "Latest "}{last}</span>}
                {itemId && <ReconnectBank session={session} item={{ item_id: itemId }} onDone={onChange} />}
              </div>
              {list.sort((x, y) => (order[x.type] || 9) - (order[y.type] || 9)).map((a) => {
                const owe = (a.type === "loan" || a.type === "credit") && Number(a.current_balance) > 0;
                const e = estimateLoan(a, txns);
                return (
                  <div key={a.id} className="acct">
                    <div style={{ minWidth: 0 }}>
                      <div>
                        {a.name} {a.mask && <span className="acct-note">••{a.mask}</span>}{" "}
                        {a.owner_person === "Wife" && <span className="tag wife">Wife</span>}{" "}
                        {a.owner_person === "Silvina" && <span className="tag silvina">Silvina</span>}{" "}
                        {a.owner_person === "Mariana" && <span className="tag mariana">Mariana</span>}{" "}
                        {dupes.has(a.id) && <span className="tag">Duplicate, not counted</span>}
                      </div>
                      <div className="acct-note">
                        {label(a)}
                        {a.is_manual && `, from statement as of ${String(a.balance_updated_at || "").slice(0, 10)}`}
                      </div>
                      {!a.is_manual && (
                        <div className="seg" role="group" aria-label="Counts in household">
                          <button aria-pressed={a.responsibility !== "theirs"} onClick={() => onSeparate(a, false)}>Joint</button>
                          <button aria-pressed={a.responsibility === "theirs"} onClick={() => onSeparate(a, true)}>Separate</button>
                        </div>
                      )}
                      {a.is_manual && a.balance_note && <div className="acct-note">{a.balance_note}</div>}
                      {a.institution === "Coinbase (holdings)" && crypto.length > 0 && (
                        <div className="acct-note">
                          {crypto.filter((h) => Number(h.last_value) >= 1).map((h) => `${h.symbol} ${Number(h.quantity)} = ${money(Number(h.last_value))}`).join(", ")}
                          {crypto.some((h) => !(Number(h.last_value) >= 1)) && `, plus ${crypto.filter((h) => !(Number(h.last_value) >= 1)).length} coins under $1`}
                        </div>
                      )}
                      {e && (
                        <div className="acct-est">
                          {e.payments
                            ? `Estimated now ${money(e.balance)} after ${e.payments} payment${e.payments > 1 ? "s" : ""} since the statement (interest ${money(e.interest)}, principal ${money(e.principal)}, at ${(Number(a.apr) * 100).toFixed(2)}%)`
                            : `No payments since the statement yet. Each ${money(Number(a.payment_amount))} payment will be split at ${(Number(a.apr) * 100).toFixed(2)}%.`}
                        </div>
                      )}
                    </div>
                    <div className={"acct-bal" + (owe ? " owe" : "")}>
                      {a.current_balance == null ? <span className="acct-note">Press Refresh</span> : (
                        <>
                          {owe ? "owe " : ""}{money(Number(a.current_balance))}
                          {a.available_balance != null && a.type === "depository" && Number(a.available_balance) !== Number(a.current_balance) && (
                            <div className="acct-note">available {money(Number(a.available_balance))}</div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        <p className="acct-note" style={{ padding: "8px 0" }}>Connected balances update when you press Refresh. Accounts marked "from statement" update when a new statement is entered.</p>
        <p style={{ padding: "0 0 10px", margin: 0 }}><button onClick={() => supabase.auth.signOut()} className="btn btn-small btn-quiet">Sign out</button></p>
      </div>
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
  const [showCardCheck, setShowCardCheck] = useState(false);
  const [tab, setTab] = useState("household"); // "household", "trends" or a person's name
  const [trendMonth, setTrendMonth] = useState(null); // month picked in the trends chart
  const [trendCat, setTrendCat] = useState(null); // category row opened in trends

  async function load() {
    const [a, c, p, cr, r, t] = await Promise.all([
      supabase.from("accounts").select("id, name, mask, responsibility, owner_override, plaid_item_id, property_id, owner_person, type, subtype, institution, current_balance, available_balance, balance_updated_at, is_manual, balance_note, apr, payment_amount, payment_pattern"),
      supabase.from("categories").select("id, name, plaid_codes, sort").order("sort"),
      supabase.from("properties").select("id, name, sort").order("sort"),
      supabase.from("crypto_holdings").select("symbol, quantity, last_price, last_value, price_updated_at").order("last_value", { ascending: false, nullsFirst: false }),
      supabase.from("rules").select("id, pattern, property_id, category_id, is_transfer, note, direction, label").order("created_at"),
      loadAllTransactions(),
    ]);
    if (t.error) return setMsg("Could not load transactions.");
    // owner_override (set by hand, e.g. Mariana's account connected through your Plaid) wins over the Plaid login's owner.
    setAccounts(Object.fromEntries((a.data || []).map((x) => [x.id, { ...x, owner_person: x.owner_override || x.owner_person }])));
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
  // Why a transaction is left out of the totals, in plain words.
  const whyNot = (t) => {
    if (t.is_transfer === true) return "you marked it";
    const r = ruleFor(t);
    if (r?.is_transfer) return r.note || "your rule";
    if (t.plaid_category_detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return "credit card payment";
    if (t.plaid_category === "LOAN_PAYMENTS") return "loan principal paydown";
    if (t.plaid_category === "TRANSFER_IN" || t.plaid_category === "TRANSFER_OUT") return "bank says: between your accounts";
    return "marked automatically";
  };

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
  const autoProp = (t) => ruleFor(t)?.property_id || t.auto_property_id || accounts[t.account_id]?.property_id || inheritedProp[t.account_id] || null;
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

  function setOurs(t, ours) {
    // Matching what the account would do anyway clears the one-off choice.
    save(t, { shared: ours === ownDefault(t) ? null : ours });
  }

  async function setSeparate(a, isSeparate) {
    const responsibility = isSeparate ? "theirs" : "shared";
    setAccounts((m) => ({ ...m, [a.id]: { ...m[a.id], responsibility } }));
    const { error } = await supabase.from("accounts").update({ responsibility }).eq("id", a.id);
    if (error) { setMsg("Could not save that change."); load(); }
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
  // The same bank account connected twice (e.g. a joint account through both Plaid logins):
  // use whichever connection has the newest transactions, ignore the other one.
  const dupes = new Set();
  const inheritedProp = {};
  {
    const latest = {};
    for (const t of txns || []) if (!latest[t.account_id] || t.posted_date > latest[t.account_id]) latest[t.account_id] = t.posted_date;
    const groups = {};
    for (const a of Object.values(accounts)) {
      if (a.is_manual || !a.mask) continue;
      const k = (a.institution || "") + "|" + a.mask + "|" + (a.type || "");
      (groups[k] = groups[k] || []).push(a);
    }
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue;
      list.sort((x, y) => (latest[y.id] || "").localeCompare(latest[x.id] || "") || (({ You: 0, Wife: 1, Silvina: 2, Mariana: 3 })[x.owner_person] ?? 0) - (({ You: 0, Wife: 1, Silvina: 2, Mariana: 3 })[y.owner_person] ?? 0));
      for (const a of list.slice(1)) dupes.add(a.id);
      const withProp = list.find((a) => a.property_id);
      if (withProp && !list[0].property_id) inheritedProp[list[0].id] = withProp.property_id;
    }
  }
  // Separate accounts (someone else's own money) aren't counted, except rent paid from them,
  // which is still a household cost and still shows in the rent tracker.
  const rentRule = rules.find((r) => /rent/i.test(r.note || ""));
  const isRentPay = (t) => !!rentRule && t.amount > 0 && rentRule.re.test(t.merchant || "");
  const separate = (t) => accounts[t.account_id]?.responsibility === "theirs";
  // Your call on a single purchase wins: shared true = household, false = theirs. Otherwise the account decides.
  const ownDefault = (t) => (separate(t) ? isRentPay(t) : true);
  const isOurs = (t) => (t.shared ?? ownDefault(t)) === true;
  const liveTxns = (txns || []).filter((t) => !dupes.has(t.account_id) && isOurs(t));
  const inPeriod = liveTxns.filter((t) => t.posted_date >= from && t.posted_date <= to);
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
  else if (filterProp === "transfers") shown = inPeriod.filter(transfer);
  else if (filterProp === "household") shown = household;
  else if (filterProp) shown = real.filter((t) => propOf(t) === filterProp);
  const pick = (cat, prop) => { setFilterCat(cat); setFilterProp(prop); setDrill(null); setAllMerchants(false); };
  const toggleDrill = (kind, key) => setDrill(drill?.kind === kind && drill.key === key ? null : { kind, key });
  const catTotal = inCat.reduce((s, t) => s + Number(t.amount), 0) || 1;
  const amountText = (t) => (t.amount < 0 ? "+" + money(-Number(t.amount)) : money(Number(t.amount)));
  const acctText = (t) => { const a = accounts[t.account_id]; return a ? `${a.name}${a.mask ? " ••" + a.mask : ""}` : ""; };
  const shortDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Purchases inside a store or type, with the "wrong section?" fix.
  const lines = (list) => (
    <div style={{ padding: "0 6px 6px" }}>
      {list.slice().sort((a, b) => (a.posted_date < b.posted_date ? 1 : -1)).map((t) => (
        <div key={t.id} className="txn">
          <div className="txn-main">
            <div className="txn-name">
              {t.merchant}
              <div className="txn-meta">{shortDate(t.posted_date)}{accounts[t.account_id]?.mask ? `, ••${accounts[t.account_id].mask}` : ""}</div>
            </div>
            <div className="txn-amt">{money(Number(t.amount))}</div>
          </div>
          <div className="txn-controls">
            <span className="txn-meta">Wrong section? Move to</span>
            <select
              className="pill-select"
              value={catOf(t)?.id || ""}
              onChange={(e) => { setCategory(t, e.target.value); setOffer({ txnId: t.id, merchant: merchantKey(t), catId: e.target.value }); }}
            >
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {offer?.txnId === t.id && (
            <div className="offer">
              <span>Moved. Do the same for every purchase from <b>{offer.merchant}</b>?</span>
              <button onClick={rememberForMerchant} className="btn btn-small btn-primary">Yes, always</button>
              <button onClick={() => setOffer(null)} className="btn btn-small">Just this one</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
  const row = (kind, g) => {
    const open = drill?.kind === kind && drill.key === g.key;
    return (
      <div key={kind + g.key}>
        <button className="drill-row" aria-expanded={open} onClick={() => toggleDrill(kind, g.key)}>
          <span>{g.key}<span className="count">×{g.count}</span></span>
          <span style={{ whiteSpace: "nowrap" }}>{money(g.total)}<span className="pct">{Math.round((g.total / catTotal) * 100)}%</span><span className="caret">{open ? "▾" : "▸"}</span></span>
        </button>
        {open && lines(shown)}
      </div>
    );
  };
  const details = filterCat && (
    <div className="drill">
      {subs.length > 1 && (
        <>
          <div className="drill-label">By type</div>
          {subs.map((g) => row("sub", g))}
        </>
      )}
      <div className="drill-label">Where</div>
      {(allMerchants ? merchants : merchants.slice(0, 8)).map((g) => row("merchant", g))}
      {merchants.length > 8 && (
        <button onClick={() => setAllMerchants(!allMerchants)} className="link" style={{ fontSize: 13, margin: "6px 6px 0" }}>
          {allMerchants ? "Show top 8" : `Show all ${merchants.length} places`}
        </button>
      )}
    </div>
  );

  // Card payments check: every payment leaving a bank account toward a card should show up
  // as a payment received on one of the connected cards (same amount, within 5 days), and the other way round.
  const isBank = (t) => accounts[t.account_id]?.type === "depository";
  const isCard = (t) => accounts[t.account_id]?.type === "credit";
  const looksLikeCardPayment = (t) => !/zelle/i.test(t.merchant || "") &&
    (t.plaid_category_detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" || /card/i.test(ruleFor(t)?.note || ""));
  // "ACH Debit WELLS FARGO CARD - CCPYMT" -> "Wells Fargo Card"
  const payee = (t) => titleCase((t.merchant || "Unknown")
    .replace(/^(ach|online|web)\s+(debit|withdrawal|pmt|payment)\s*/i, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\b(autopay|auto pay|payment|pymt|ccpymt|epay|online|mobile|recurring|thank you)\b.*$/i, "")
    .trim() || t.merchant);
  const bankPays = liveTxns.filter((t) => isBank(t) && t.amount > 0 && looksLikeCardPayment(t));
  const cardGets = liveTxns.filter((t) => isCard(t) && t.amount < 0 && (transfer(t) || looksLikeCardPayment(t)));
  const matchOf = {};
  {
    const used = new Set();
    const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
    for (const b of bankPays.slice().sort((x, y) => x.posted_date.localeCompare(y.posted_date))) {
      const c = cardGets
        .filter((c) => !used.has(c.id) && Math.abs(Number(b.amount) + Number(c.amount)) < 0.01 && days(b.posted_date, c.posted_date) <= 5)
        .sort((x, y) => days(b.posted_date, x.posted_date) - days(b.posted_date, y.posted_date))[0];
      if (c) { used.add(c.id); matchOf[b.id] = c; matchOf[c.id] = b; }
    }
  }
  const recent = (t) => (Date.now() - new Date(t.posted_date)) / 864e5 < 4;
  // Which connected card a bank payment is aimed at, from the payee text. Discover cards now sit under Capital One.
  const ISSUERS = [[/capital one/i, /capital one/i], [/discover/i, /discover|capital one/i], [/amex|american express/i, /american express/i],
    [/bank of america|bk of amer/i, /bank of america/i], [/robinhood/i, /robinhood/i], [/citi/i, /citi/i], [/chase/i, /chase/i],
    [/wells|\bwf\b/i, /wells/i], [/barclay/i, /barclay/i], [/apple card|goldman/i, /apple|goldman/i], [/target/i, /target|td bank/i]];
  const cardAccts = Object.values(accounts).filter((a) => a.type === "credit" && !dupes.has(a.id));
  const firstSeen = {};
  for (const t of liveTxns) if (isCard(t) && (!firstSeen[t.account_id] || t.posted_date < firstSeen[t.account_id])) firstSeen[t.account_id] = t.posted_date;
  const targetCards = (t) => {
    const hit = ISSUERS.find(([re]) => re.test(t.merchant || ""));
    return hit ? cardAccts.filter((a) => hit[1].test(a.institution || "")) : [];
  };
  // A payment from before the card's history starts can't be checked, so it isn't flagged.
  const beforeHistory = (t) => {
    const cards = targetCards(t);
    if (!cards.length) return false;
    const start = cards.map((a) => firstSeen[a.id]).filter(Boolean).sort()[0];
    return !start || t.posted_date < start;
  };
  const unmatchedBank = bankPays.filter((t) => !matchOf[t.id] && !beforeHistory(t) && t.posted_date >= from && t.posted_date <= to);
  const unmatchedCard = cardGets.filter((t) => !matchOf[t.id] && t.posted_date >= from && t.posted_date <= to);
  const matchedCount = bankPays.filter((t) => matchOf[t.id] && t.posted_date >= from && t.posted_date <= to).length;
  const cardIssue = (t) => {
    if (matchOf[t.id]) return null;
    if (isBank(t) && beforeHistory(t)) return null;
    if (isBank(t)) return recent(t) ? "No matching card payment yet (may still be posting)" : "No matching payment on any connected card";
    if (isCard(t)) return recent(t) ? "No matching bank payment yet" : "Paid from an account the app doesn't see";
    return null;
  };

  // One tab per person whose own accounts are connected (Silvina and Mariana always get one).
  const people = [...new Set(["Silvina", "Mariana", ...Object.values(accounts).map((a) => a.owner_person).filter((o) => o && o !== "You" && o !== "Wife")])];
  const personTxns = tab === "household" ? [] : (txns || [])
    .filter((t) => !dupes.has(t.account_id) && accounts[t.account_id]?.owner_person === tab && t.posted_date >= from && t.posted_date <= to && t.amount > 0 && !transfer(t))
    .sort((a, b) => (a.posted_date < b.posted_date ? 1 : -1));
  const personTheirs = personTxns.filter((t) => !isOurs(t));
  const personOurs = personTxns.filter(isOurs);
  const sum = (l) => l.reduce((s, t) => s + Number(t.amount), 0);
  const personHasAccounts = Object.values(accounts).some((a) => a.owner_person === tab);
  const personView = tab === "household" ? null : (
    <>
      <section className="hero">
        <p className="hero-label">{tab} spent on her own, {PERIODS[period].label.toLowerCase()}</p>
        <div className="hero-amount" style={{ cursor: "default" }}>
          {money(sum(personTheirs)).split(".")[0]}<span className="cents">.{money(sum(personTheirs)).split(".")[1]}</span>
        </div>
        <div className="moved">
          {personOurs.length
            ? `${money(sum(personOurs))} from her accounts counts as household (${personOurs.length} purchase${personOurs.length > 1 ? "s" : ""}).`
            : "Nothing from her accounts counts as household yet."}
        </div>
      </section>
      {!personHasAccounts ? (
        <p className="status">No accounts connected for {tab} yet. Open Accounts and tap "Connect {tab}'s bank".</p>
      ) : (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Her purchases</h2>
            <span className="section-note">Tap "Ours" on anything that's for the household</span>
          </div>
          <div className="sheet">
            {personTxns.length === 0 && <p className="status" style={{ padding: "10px 0" }}>No purchases in this period.</p>}
            {personTxns.map((t) => {
              const ours = isOurs(t);
              return (
                <div key={t.id} className="txn">
                  <div className="txn-main">
                    <div className="txn-name">
                      {t.merchant || "Unknown"} {t.pending && <span className="tag pending">Pending</span>}
                      <div className="txn-meta">{shortDate(t.posted_date)}, {acctText(t)}{ours ? `, ${catOf(t)?.name || ""}` : ""}</div>
                    </div>
                    <div className="txn-amt">{money(Number(t.amount))}</div>
                  </div>
                  <div className="txn-controls">
                    <div className="seg" role="group" aria-label="Whose purchase">
                      <button aria-pressed={!ours} onClick={() => setOurs(t, false)}>Hers</button>
                      <button aria-pressed={ours} onClick={() => setOurs(t, true)}>Ours</button>
                    </div>
                    {ours && (
                      <select className={"pill-select" + (t.category_id ? " set" : "")} value={catOf(t)?.id || ""} onChange={(e) => setCategory(t, e.target.value)} aria-label="Category">
                        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                    {isRentPay(t) && <span className="tag">Rent</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );


  // Trends: household spending in each of the last six full months, split by category.
  const trendsView = tab !== "trends" ? null : (() => {
    const now = new Date();
    const months = [];
    for (let i = 6; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleString("en-US", { month: "short" }), long: d.toLocaleString("en-US", { month: "long", year: "numeric" }) });
    }
    const keys = new Set(months.map((m) => m.key));
    // Same rules as the household total; rent is placed in the month it pays for.
    const monthOf = (t) => (rentRule && rentRule.re.test(t.merchant || "") ? rentKeyOf(t) : t.posted_date.slice(0, 7));
    const cell = {}; // cell[catId][monthKey]
    const monthTotal = {};
    for (const t of liveTxns) {
      if (!(t.amount > 0) || transfer(t) || propOf(t)) continue;
      const mk = monthOf(t);
      if (!keys.has(mk)) continue;
      const c = catOf(t);
      const id = c?.id || "none";
      (cell[id] = cell[id] || {})[mk] = (cell[id][mk] || 0) + Number(t.amount);
      monthTotal[mk] = (monthTotal[mk] || 0) + Number(t.amount);
    }
    const n = months.length;
    const rows = Object.keys(cell).map((id) => {
      const c = cats.find((x) => x.id === id);
      const total = Object.values(cell[id]).reduce((a, b) => a + b, 0);
      return { id, name: c?.name || "Uncategorized", byMonth: cell[id], total, avg: total / n };
    }).sort((a, b) => b.total - a.total);
    rows.forEach((r, i) => { r.color = i < SERIES.length ? SERIES[i] : OTHER_COLOR; });
    const top = rows.slice(0, SERIES.length);
    const rest = rows.slice(SERIES.length);
    const avgTotal = rows.reduce((s, r) => s + r.avg, 0);
    // Bars: each month plus the average, stacked by the top categories and "everything else".
    const stackOf = (get) => [...top.map((r) => ({ id: r.id, name: r.name, color: r.color, v: get(r) })),
      { id: "rest", name: "Everything else", color: OTHER_COLOR, v: rest.reduce((s, r) => s + get(r), 0) }].filter((x) => x.v > 0);
    const bars = [...months.map((m) => ({ key: m.key, label: m.label, long: m.long, total: monthTotal[m.key] || 0, stack: stackOf((r) => r.byMonth[m.key] || 0) })),
      { key: "avg", label: "Avg", long: "Six-month average", total: avgTotal, stack: stackOf((r) => r.avg), avg: true }];
    const max = Math.max(...bars.map((b) => b.total), 1);
    const sel = bars.find((b) => b.key === trendMonth) || bars[bars.length - 1];
    const selVal = (r) => (sel.avg ? r.avg : r.byMonth[sel.key] || 0);
    const H = 180;
    const [d1, c1] = money(sel.total).split(".");
    return (
      <>
        <section className="hero">
          <p className="hero-label">{sel.avg ? `Average month, ${months[0].label} to ${months[n - 1].long}` : `Household spent in ${sel.long}`}</p>
          <div className="hero-amount" style={{ cursor: "default" }}>{d1}<span className="cents">.{c1}</span></div>
          <div className="moved">
            {sel.avg ? `Six full months; ${now.toLocaleString("en-US", { month: "long" })} is left out until it ends.`
              : `${sel.total >= avgTotal ? money(sel.total - avgTotal) + " more" : money(avgTotal - sel.total) + " less"} than the six-month average of ${money(avgTotal)}.`}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Month by month</h2>
            <span className="section-note">Tap a month</span>
          </div>
          <div className="sheet trend-sheet">
            <div className="trend-chart" style={{ height: H + 44 }}>
              {bars.map((b) => (
                <button key={b.key} className={"trend-col" + (b.avg ? " avg" : "")} aria-pressed={sel.key === b.key}
                  onClick={() => setTrendMonth(b.key)} aria-label={`${b.long}: ${money(b.total)}`}>
                  <span className="trend-total">{short$(b.total)}</span>
                  <span className="trend-stack" style={{ height: Math.max(2, (b.total / max) * H) }}>
                    {b.stack.slice().reverse().map((s) => (
                      <i key={s.id} style={{ flexGrow: s.v, background: s.color }} title={`${s.name}: ${money(s.v)}`} />
                    ))}
                  </span>
                  <span className="trend-label">{b.label}</span>
                </button>
              ))}
            </div>
            <div className="legend">
              {[...top, ...(rest.length ? [{ id: "rest", name: "Everything else", color: OTHER_COLOR }] : [])].map((r) => (
                <span key={r.id}><i style={{ background: r.color }} />{r.name}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">{sel.avg ? "Average month by category" : `${sel.long} by category`}</h2>
            <span className="section-note">{sel.avg ? "Bars show each month" : "Compared with the average"}</span>
          </div>
          <div className="sheet">
            {rows.map((r) => {
              const v = selVal(r);
              const peak = Math.max(...months.map((m) => r.byMonth[m.key] || 0), 1);
              const diff = v - r.avg;
              const open = trendCat === r.id;
              return (
                <div key={r.id}>
                  <button className="cat trend-row" aria-expanded={open} onClick={() => setTrendCat(open ? null : r.id)}>
                    <CatIcon name={r.name} />
                    <span className="cat-body">
                      <span className="cat-row">
                        <span className="cat-name"><i className="swatch" style={{ background: r.color }} />{r.name}</span>
                        <span className="cat-amt">{money(v).replace(/\.\d\d$/, "")}</span>
                      </span>
                      <span className="trend-sub">
                        <span className="spark" aria-hidden="true">
                          {months.map((m) => (
                            <i key={m.key} className={sel.key === m.key ? "on" : ""} style={{ height: `${Math.max(6, ((r.byMonth[m.key] || 0) / peak) * 100)}%`, opacity: r.byMonth[m.key] ? 1 : 0.25 }} />
                          ))}
                        </span>
                        <span className="txn-meta">
                          {sel.avg ? `${Math.round((r.avg / (avgTotal || 1)) * 100)}% of an average month`
                            : Math.abs(diff) < 1 ? "Same as average" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff)).replace(/\.\d\d$/, "")} vs avg ${money(r.avg).replace(/\.\d\d$/, "")}`}
                        </span>
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div className="drill trend-months">
                      {months.map((m) => (
                        <div key={m.key} className="acct"><span>{m.long}</span><span className="acct-bal">{money(r.byMonth[m.key] || 0)}</span></div>
                      ))}
                      <div className="acct"><span><b>Average</b></span><span className="acct-bal">{money(r.avg)}</span></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </>
    );
  })();

  const [dollars, cents] = money(spent).split(".");
  const transfersCount = inPeriod.filter(transfer).length;
  const dueStatements = Object.values(accounts).filter((a) => a.is_manual && monthsOld(a.balance_updated_at) >= 6);
  const filterName = filterCat ? cats.find((c) => c.id === filterCat)?.name + (drill ? " › " + drill.key : "")
    : filterProp === "household" ? "Household" : props.find((p) => p.id === filterProp)?.name;

  return (
    <main className="app">
      <header className="top">
        <h1 className="brand">Expenses</h1>
        <div className="top-actions">
          <button onClick={() => setShowAccounts(!showAccounts)} className="btn" aria-pressed={showAccounts}>
            {showAccounts ? "Close accounts" : `Accounts (${Object.keys(accounts).length})`}
          </button>
          <button onClick={refresh} className="btn btn-primary">Refresh</button>
        </div>
      </header>
      {msg && <p className="status">{msg}</p>}

      {showAccounts && <AccountsList accounts={Object.values(accounts)} txns={txns || []} crypto={crypto} session={session} onChange={load} onSeparate={setSeparate} dupes={dupes} />}
      {dueStatements.length > 0 && (
        <p className="notice">Time for a new statement: {dueStatements.map((a) => a.name).join(", ")}</p>
      )}

      {txns === null ? (
        <p className="status">Loading...</p>
      ) : txns.length === 0 ? (
        <p className="status">No transactions yet. Open Accounts and connect a bank to get started.</p>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {["household", "trends", ...people].map((p) => (
              <button key={p} role="tab" aria-selected={tab === p} className="tab" onClick={() => { setTab(p); pick(null, null); }}>
                {p === "household" ? "Household" : p === "trends" ? "Trends" : p}
              </button>
            ))}
          </div>
          {tab !== "trends" && <div className="periods" role="group" aria-label="Period">
            {Object.entries(PERIODS).map(([k, v]) => (
              <button key={k} className="chip" aria-pressed={period === k} onClick={() => { setPeriod(k); pick(null, null); }}>{v.label}</button>
            ))}
          </div>}

          {tab === "household" ? (<>
          <section className="hero">
            <p className="hero-label">Household spent, {PERIODS[period].label.toLowerCase()}</p>
            <button className="hero-amount" aria-pressed={filterProp === "household"} onClick={() => pick(null, filterProp === "household" ? null : "household")} title="Show household purchases">
              {dollars}<span className="cents">.{cents}</span>
            </button>
            <div className="moved">
              {money(moved)} moved between your own accounts isn't counted.{" "}
              <button className="link" onClick={() => pick(null, filterProp === "transfers" ? null : "transfers")}>
                {filterProp === "transfers" ? "Hide" : `Review ${transfersCount}`}
              </button>
            </div>
          </section>

          {(bankPays.length > 0 || cardGets.length > 0) && (
            <section className="section">
              <button className={"check" + (unmatchedBank.length + unmatchedCard.length ? " warn" : " ok")} onClick={() => setShowCardCheck(!showCardCheck)} aria-expanded={showCardCheck}>
                <span className="check-dot" aria-hidden="true">{unmatchedBank.length + unmatchedCard.length ? "!" : "✓"}</span>
                <span style={{ flex: 1 }}>
                  <b>Card payments check</b>
                  <span className="txn-meta" style={{ display: "block" }}>
                    {unmatchedBank.length + unmatchedCard.length
                      ? `${matchedCount} matched, ${unmatchedBank.length + unmatchedCard.length} need a look`
                      : `All ${matchedCount} card payments match a connected card`}
                  </span>
                </span>
                <span className="caret">{showCardCheck ? "▾" : "▸"}</span>
              </button>
              {showCardCheck && (unmatchedBank.length + unmatchedCard.length > 0) && (() => {
                const groups = {};
                for (const t of unmatchedBank) {
                  const k = "b:" + payee(t);
                  const connected = targetCards(t).length > 0;
                  (groups[k] = groups[k] || {
                    title: `Paid to ${payee(t)}`,
                    note: connected ? "That card is connected, but no payment with this amount and date showed up on it." : "This card isn't connected, so the payment can't be checked.",
                    items: [],
                  }).items.push(t);
                }
                for (const t of unmatchedCard) {
                  const k = "c:" + t.account_id;
                  (groups[k] = groups[k] || { title: `Payments into ${acctText(t)}`, note: "Paid from an account the app doesn't see (for example Stanford while it's stuck).", items: [] }).items.push(t);
                }
                const list = Object.entries(groups).map(([k, g]) => ({ k, ...g, total: g.items.reduce((s, t) => s + Math.abs(Number(t.amount)), 0), last: g.items.reduce((m, t) => (t.posted_date > m ? t.posted_date : m), "") }))
                  .sort((a, b) => b.total - a.total);
                return (
                  <div className="sheet" style={{ marginTop: 8 }}>
                    {list.map((g) => (
                      <details key={g.k} className="txn">
                        <summary className="txn-main" style={{ cursor: "pointer", listStyle: "none" }}>
                          <div className="txn-name">
                            {g.title}
                            <div className="txn-meta">{g.items.length} payment{g.items.length > 1 ? "s" : ""}, latest {shortDate(g.last)}</div>
                            <div className="why flag">{g.note}</div>
                          </div>
                          <div className="txn-amt">{money(g.total)}</div>
                        </summary>
                        {g.items.slice().sort((a, b) => (a.posted_date < b.posted_date ? 1 : -1)).map((t) => (
                          <div key={t.id} className="txn-meta" style={{ display: "flex", justifyContent: "space-between", padding: "3px 0 3px 10px" }}>
                            <span>{shortDate(t.posted_date)}, {acctText(t)}</span><span>{money(Math.abs(Number(t.amount)))}</span>
                          </div>
                        ))}
                      </details>
                    ))}
                  </div>
                );
              })()}
            </section>
          )}

          {filterProp === "transfers" && (
            <section className="section">
              <div className="sheet">
                {shown.length === 0 && <p className="status" style={{ padding: "10px 0" }}>Nothing left out in this period.</p>}
                {shown.slice().sort((a, b) => (a.posted_date < b.posted_date ? 1 : -1)).map((t) => (
                  <div key={t.id} className="txn">
                    <div className="txn-main">
                      <div className="txn-name">
                        {t.merchant}
                        <div className="txn-meta">{shortDate(t.posted_date)}{accounts[t.account_id]?.mask ? `, ••${accounts[t.account_id].mask}` : ""}</div>
                        <div className="why">Why: {whyNot(t)}</div>
                        {cardIssue(t) && <div className="why flag">{cardIssue(t)}</div>}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className={"txn-amt" + (t.amount < 0 ? " in" : "")}>{amountText(t)}</div>
                        <button onClick={() => toggleTransfer(t)} className="btn btn-small" style={{ marginTop: 4 }}>Count it</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Where it went</h2>
              <span className="section-note">Tap a category for detail</span>
            </div>
            <div className="sheet">
              {breakdown.map((c) => (
                <div key={c.id}>
                  <button className="cat" aria-expanded={filterCat === c.id} onClick={() => pick(filterCat === c.id ? null : c.id, null)}>
                    <CatIcon name={c.name} />
                    <span className="cat-body">
                      <span className="cat-row">
                        <span className="cat-name">{c.name}</span>
                        <span className="cat-amt">{money(c.total)}<span className="pct">{Math.round((c.total / spent) * 100)}%</span></span>
                      </span>
                      <span className="bar"><i style={{ width: `${(c.total / top) * 100}%` }} /></span>
                    </span>
                  </button>
                  {filterCat === c.id && details}
                </div>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Properties</h2>
              <span className="section-note">In, out and net</span>
            </div>
            <div className="sheet">
              {propRows.map((p) => (
                <button key={p.id} className="prop" aria-pressed={filterProp === p.id} onClick={() => pick(null, filterProp === p.id ? null : p.id)}>
                  <span className="prop-name">{p.name}</span>
                  <span className="prop-figs">
                    {p.count === 0 ? "No activity" : (
                      <>
                        <span className={"net " + (p.net >= 0 ? "pos" : "neg")}>{p.net >= 0 ? "+" : ""}{money(p.net)}</span>
                        {p.income > 0 ? `in ${money(p.income)}, ` : ""}out {money(p.costs)}
                      </>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {(() => {
            if (!rentRule) return null;
            const pays = liveTxns.filter((t) => rentRule.re.test(t.merchant || ""));
            return (
              <section className="section">
                <div className="section-head">
                  <h2 className="section-title">Rent</h2>
                  <span className="section-note">Paid on the 25th or later counts for the next month</span>
                </div>
                <div className="months">
                  {rentMonths(pays).reverse().map((m) => {
                    const total = m.items.reduce((s, t) => s + Number(t.amount), 0);
                    const paid = total > 0.5;
                    const returned = m.items.some((t) => Number(t.amount) < 0);
                    return (
                      <div key={m.key} className={"month " + (paid ? "paid" : "gap")} title={m.items.map((t) => `${t.posted_date} ${Number(t.amount) < 0 ? "returned " : ""}${money(Math.abs(t.amount))}${accounts[t.account_id]?.mask ? " ••" + accounts[t.account_id].mask : ""}`).join(", ")}>
                        <b>{m.label.replace(/ \d{4}$/, "")} <span className="count">’{m.label.slice(-2)}</span></b>
                        <span className="m-amt">{paid ? money(total).replace(/\.\d\d$/, "") : m.items.length ? "Returned" : "Not found"}</span>
                        {paid && returned && <span className="count">after a return</span>}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })()}

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Transactions</h2>
              <span className="section-note">{shown.length}</span>
            </div>
            {(filterCat || (filterProp && filterProp !== "transfers")) && (
              <div className="filter">
                <span>Showing {filterName} only</span>
                <button onClick={() => pick(null, null)} className="link">Show all</button>
              </div>
            )}
            <div className="sheet">
              {(filterProp === "transfers" ? inPeriod : shown).map((t) => {
                const isT = transfer(t);
                const cat = catOf(t);
                return (
                  <div key={t.id} className="txn">
                    <div className="txn-main">
                      <div className="txn-name">
                        {t.merchant || "Unknown"} {t.pending && <span className="tag pending">Pending</span>}
                        <div className="txn-meta">{shortDate(t.posted_date)}{acctText(t) ? `, ${acctText(t)}` : ""}</div>
                      </div>
                      <div className={"txn-amt" + (isT ? " off" : t.amount < 0 ? " in" : "")}>{amountText(t)}</div>
                    </div>
                    <div className="txn-controls">
                      {t.amount > 0 && !isT && (
                        <select className={"pill-select" + (t.category_id ? " set" : "")} value={cat?.id || ""} onChange={(e) => setCategory(t, e.target.value)} aria-label="Category">
                          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                      {t.amount < 0 && !isT && <span className="tag">Money in</span>}
                      {!isT && (
                        <select className={"pill-select" + (t.property_id ? " set" : "")} value={propOf(t) || householdId || ""} onChange={(e) => setProperty(t, e.target.value)} aria-label="Belongs to">
                          {householdId && <option value={householdId}>Household</option>}
                          {realProps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                      <button
                        onClick={() => toggleTransfer(t)}
                        className={"toggle" + (isT ? " on" : "")}
                        title={isT ? "Tap to count this again" : "Tap if this is money moving between your own accounts"}
                      >
                        {isT ? "Transfer, not counted" : "Mark as transfer"}
                      </button>
                      {isT && <span className="why">Why: {whyNot(t)}</span>}
                      {!isT && t.amount > 0 && ["Silvina", "Mariana"].includes(accounts[t.account_id]?.owner_person) && (
                        <button className="toggle" onClick={() => setOurs(t, false)} title="Move this to her own spending">Hers, not ours</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          </>) : tab === "trends" ? trendsView : personView}
        </>
      )}
    </main>
  );
}
