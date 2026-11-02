// Fake sample data only. Real transactions will come from the server after login is added.
const sampleTransactions = [
  { id: 1, date: "2026-10-28", merchant: "Sample Grocery", category: "Groceries", amount: 84.12 },
  { id: 2, date: "2026-10-29", merchant: "Sample Streaming", category: "Subscriptions", amount: 15.99 },
  { id: 3, date: "2026-10-30", merchant: "Sample Restaurant", category: "Dining", amount: 42.5 },
];

export default function Home() {
  const total = sampleTransactions.reduce((sum, t) => sum + t.amount, 0);

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 24 }}>Expenses</h1>
      <p style={{ color: "#6b7280" }}>Sample data only. Not connected to any accounts yet.</p>

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
