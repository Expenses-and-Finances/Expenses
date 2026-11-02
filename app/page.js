"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// Fake sample data only. Real transactions come later, from the database, for signed-in owner only.
const sampleTransactions = [
  { id: 1, date: "2026-10-28", merchant: "Sample Grocery", category: "Groceries", amount: 84.12 },
  { id: 2, date: "2026-10-29", merchant: "Sample Streaming", category: "Subscriptions", amount: 15.99 },
  { id: 3, date: "2026-10-30", merchant: "Sample Restaurant", category: "Dining", amount: 42.5 },
];

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

function ConnectBank({ session }) {
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
        onSuccess: async (public_token) => {
          setMsg("Finishing connection...");
          const r = await fetch("/api/plaid/exchange", { method: "POST", headers, body: JSON.stringify({ public_token }) });
          setMsg(r.ok ? "Connected (sandbox test). Saving transactions comes next." : "Connection failed at the last step.");
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

  const total = sampleTransactions.reduce((sum, t) => sum + t.amount, 0);

  return (
    <main style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 24 }}>Expenses</h1>
        <button onClick={() => supabase.auth.signOut()} style={{ padding: "6px 10px" }}>Sign out</button>
      </div>
      <p style={{ color: "#6b7280" }}>Sample data only. Not connected to any accounts yet.</p>
      <ConnectBank session={session} />

      <ul style={{ listStyle: "none", padding: 0 }}>
        {sampleTransactions.map((t) => (
          <li key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #e5e7eb" }}>
            <span>
              {t.merchant}
              <br />
              <small style={{ color: "#6b7280" }}>{t.date} · {t.category}</small>
            </span>
            <strong>${t.amount.toFixed(2)}</strong>
          </li>
        ))}
      </ul>

      <p style={{ fontWeight: 600 }}>Total: ${total.toFixed(2)}</p>
    </main>
  );
}
