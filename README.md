Expenses
A private expense tracker, built as an installable web app (PWA).
Security rules
This repo is public. Never commit secrets, real transactions, statements, account numbers, or personal data.
Secrets (Plaid secret, Supabase service-role key, database password) live only in environment variables, never in code.
Plaid calls and access-token handling happen on the server only. The browser never sees access tokens.
Every Supabase table must have Row Level Security enabled before it holds real data.
Use fake data for tests and screenshots.
If a secret is committed by mistake, rotate it immediately in the provider's dashboard. Deleting the commit is not enough.
Status
Phase 1: connection and basic UI. Nothing is built yet beyond this setup.
