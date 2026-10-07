# Local testing

Everything here runs against a local SQLite copy of the D1 billing database in
`.wrangler/state/`, and the invoice Workflow also runs locally. Nothing touches
your Cloudflare account except the chat, which calls Workers AI remotely
(`npx wrangler login` once).

## Setup

```sh
npm install
npm run db:setup     # apply migrations and load demo data (safe to re-run)
```

To start over at any point (also works while `npm run dev` is running):

```sh
npm run db:reset     # drop all local billing tables, then setup
```

## Automated tests

```sh
npm test             # ~30s; billing tests use a fresh in-memory D1 per test
npm run check        # formatting, lint, and type checking
```

## Manual walkthrough

`npm run billing` is a local-only CLI that calls the billing code in
`src/billing/` directly. Run `npm run billing` with no arguments for help.
Run the steps in order after a fresh `npm run db:reset`; expected results are
shown below each command.

### 1. Inspect the demo data

```sh
npm run billing -- customers
npm run billing -- usage cus_acme 2026-09
```

Three customers with $0.00 balances. Acme used 21,525,000 requests and 600,000
AI neurons in September (30 events each).

### 2. Invoice a month

```sh
npm run billing -- invoice cus_acme 2026-09
```

Total **$11.76**: the $5.00 fee, $3.30 for 300,000 neurons over the allowance
at $0.011 per 1,000, and $3.46 for 11,525,000 requests over the allowance at
$0.30 per million (345.75¢ rounded half-up).

Run it again: the same invoice comes back unchanged, with no new ledger
entries.

```sh
npm run billing -- invoice cus_acme 2026-10
```

Fails with `period_open`: October has not ended.

### 3. Usage rules

```sh
npm run billing -- record cus_acme workers_requests 5000 --at=2026-09-30T23:00:00Z
```

Fails with `period_closed`: September is invoiced, so late usage cannot change
it.

```sh
npm run billing -- record cus_acme workers_requests 5000 --id=demo-evt-1 --at=2026-10-07T09:00:00Z
npm run billing -- record cus_acme workers_requests 5000 --id=demo-evt-1 --at=2026-10-07T09:00:00Z
npm run billing -- record cus_acme workers_requests 9000 --id=demo-evt-1 --at=2026-10-07T09:00:00Z
```

`recorded`, then `duplicate` (a retry is a no-op), then `conflict` (same event
id, different data). Without `--at`, each run uses the current time, so a
repeat is a different event and also returns `conflict`.

### 4. Credits

```sh
npm run billing -- credit inv_cus_acme_2026-09 10.00 Outage on Sep 15 --id=demo-credit-1
npm run billing -- credit inv_cus_acme_2026-09 10.00 Outage on Sep 15 --id=demo-credit-1
npm run billing -- credit inv_cus_acme_2026-09 5.00 Goodwill
npm run billing -- invoices cus_acme
npm run billing -- customers
```

`issued`, then `duplicate`, then `conflict`: only $1.76 of the $11.76 invoice
is left to credit. The invoice shows $10.00 credited and Acme's balance is
**$1.76**.

### 5. Ledger and reconciliation

```sh
npm run billing -- reconcile
npx wrangler d1 execute billing --local --command "SELECT transaction_id, account, amount_cents FROM ledger_entries ORDER BY id"
```

Reconciliation passes. The ledger has four entries: the invoice (receivable
+1176, revenue -1176) and the credit (credits issued +1000, receivable -1000).
Each transaction sums to zero.

```sh
npx wrangler d1 execute billing --local --command "UPDATE ledger_entries SET amount_cents = 1"
```

Fails with `ledger entries are immutable`.

```sh
npx wrangler d1 execute billing --local --command "INSERT INTO ledger_entries (transaction_id, account, customer_id, amount_cents, description, created_at) VALUES ('manual:1', 'revenue', 'cus_acme', -500, 'one-sided entry', '2026-10-07T00:00:00.000Z')"
npm run billing -- reconcile
```

Reconciliation now reports `unbalanced_transaction manual:1` and exits with
an error. Run `npm run db:reset` to clean up.

### 6. UI

```sh
npm run dev
```

Open <http://localhost:5173>. Run this after a fresh `npm run db:reset`.

1. **Run an invoice.** With Acme Robotics selected, choose September 2026 and
   click **Run invoice**. The Workflow finishes in a few seconds; the invoice
   ($11.76) appears and the balance updates. Click it to see the lines.
2. **Ask why the bill changed.** Run August too, then click the suggestion
   "Why did my bill change from August 2026 to September 2026?". The
   assistant should cite usage up 141.9% (AI) and 177.7% (requests), $3.30
   and $3.46 in usage charges, and a total up $6.76 from $5.00 to $11.76.
   Expand the tool lines to see the exact data it received.
3. **Find a spike.** Switch to Nimbus Labs and ask "Was there a usage spike
   in September 2026?". It should name Sep 15–20 at 3,000,000 neurons a day
   against a median of 250,000.
4. **Approve a credit.** Ask for "$5.00 on my September 2026 invoice for the
   outage on the 16th" (invoice September first). Click **Approve**: the
   credit is applied and the panel's balance drops by $5.00.
5. **Reject a credit.** Ask again and click **Reject**: nothing changes.
6. **Over the limit.** Ask for a $500 credit: it is refused, with how much
   can still be credited.

Each customer has their own chat history. **Clear chat** resets it.

## Inspecting the database directly

```sh
npx wrangler d1 execute billing --local --command "SELECT * FROM invoices"
```

Or open the `.sqlite` file under `.wrangler/state/v3/d1/` with the `sqlite3`
CLI or DB Browser for SQLite.
