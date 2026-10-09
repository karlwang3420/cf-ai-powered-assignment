# Local testing

## Safe setup and isolation

Requires Node 24+. Stop `npm run dev` before migration or direct-file billing
CLI operations, especially on Windows (two emulators opening the same SQLite
file can fail with `SQLITE_BUSY`). Never delete existing `.wrangler` state to
try a scenario.

```sh
npm install
npm run db:setup
npm run dev
```

`db:setup` applies pending D1 migrations, including `0003_payments.sql`, without
dropping data. It seeds demo customers/usage **only when customers is empty**;
existing databases are not reseeded. Back up valuable local state while dev is
stopped before upgrading. Setup does not migrate/reset chat or processor data.

Vite starts **both** `billing-assistant` and the `mock-payment-processor`
auxiliary Worker. The processor SQLite Durable Object initializes its tables
on first use; no second process or processor seed command is needed. Both
service bindings work locally: merchant → processor and signed callback →
merchant. Normal persistence is `.wrangler/state/`; the merchant's global D1
owns all financial records, separate from processor and chat Durable Objects.

Chat alone calls remote Workers AI (`npx wrangler login` if using chat). Payment
controls, CLI and tests do not call AI. To experiment with **no remote bindings**
and disposable data, use a newly allocated directory (Git Bash):

```sh
TEST_STATE="$(node -e "console.log(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'billing-demo-')))")"
npm run billing -- setup --persist-to="$TEST_STATE"
PAYMENT_TEST_PERSIST="$TEST_STATE" npm run dev -- --mode payment-test
```

Do not send chat messages in this offline mode. Keep the printed temp path;
stop that dev process before direct-file CLI writes, supplying the **same**
`--persist-to="$TEST_STATE"` each time. Omitting it targets normal user data.

**Reset policy:** there is no processor reset/force-outcome endpoint. Keys and
terminal outcomes are retained indefinitely. To restart a demo, stop its
process and allocate a **new disposable directory** using the commands above;
this resets both merchant and processor by isolation, without deleting old
state. Never reset just the merchant while reusing processor invoice/key IDs.
The legacy `npm run db:reset` is destructive merchant-only tooling, not a
payment reset; do not use it on existing demo data. No reset was run on user
state during implementation/testing. Standalone processor commands and its
separate persistence are in [`processor/README.md`](../processor/README.md);
do not start a duplicate standalone processor alongside Vite.

## Automated verification (no AI)

```sh
npm test
node --test tests/payment-integration.test.mjs
npm run check
npm run types
npx vite build
```

Final reviewed validation: **106/106 tests passed** with the full file set at
bounded concurrency (about eight minutes on the Windows development machine):

```sh
node --test --test-concurrency=2 tests/*.test.mjs
```

One default `npm test` run stalled at a local runtime probe and hit a 600-second
command timeout without a final summary. That invocation did **not** pass.
The suspected runtime file passed independently (2/2), and the full bounded run
passed without omitting tests or forcing process exit. The cause is unproven;
reduced concurrency is a verified workaround, not a claimed root-cause fix.
If a run stalls, inspect its logs and stop only processes proven to belong to
that test invocation, never all Node/workerd processes or an unrelated dev server.

Store/API tests use fresh D1. Runtime tests use new OS-temp persistence, real
local Workflow primitives and actual Workers.
The integration matrix runs success, soft decline/recovery, hard decline/card
update, four-attempt exhaustion (including manual resume), lost response,
missing/duplicate webhook, pending, late success after needs-review, and full
credit during card timeout. It verifies one payment per successful invoice,
balanced transactions, preserved reservations and real bidirectional bindings.
`payment-workflow-runtime.test.mjs` additionally verifies early event buffering,
type matching, timeout exceptions, actual outage step retries and automatic
invoice-to-collection startup.

Two explicit **test-only fixtures** avoid adding unsafe production controls:

- A real processor pending charge is created in a fresh isolated processor,
  stopped, and its `resolve_at` delayed 140 seconds before Vite starts. Payload,
  key and payment ID stay unchanged. The test must observe needs-review,
  reserved money and an ended Workflow before its real alarm/signed callback
  posts late success. It does not forge a success webhook or force a terminal
  outcome. The normal `unresolved_pending` preset never resolves by itself.
- A Vite transform local to the harness calls unchanged `issueCredit(env.DB)`
  with one fixed approved fixture while the real Workflow waits for a card.
  It exists only in the test-created server, not normal dev/build. This retains
  real D1 batch atomicity without AI or a public credit endpoint. Explorer's
  current SQL “batch” implementation loops separate statements and **must not**
  substitute for a financial `db.batch()` transaction.

The browser fixture test runs real Chrome/Edge when available (override with
`PAYMENT_UI_BROWSER`); it may skip elsewhere. The integration harness also
checks the fully styled real app at 390px and 1280px, light/dark, with a long
customer name and expanded IDs: no document overflow or clipped header controls.
It reports `PAYMENT_LAYOUT_OK` or an explicit browser-unavailable skip. The
integration harness can hold
its isolated server briefly with `PAYMENT_BROWSER_HOLD_MS=60000` for a local
`browse` smoke pass; it prints `ISOLATED_PAYMENT_ORIGIN`. Never point that pass
at existing demo state. Unit/fake-step crash tests are not claims that every
physical crash was injected into the real Vite runtime.

## Payment walkthrough

Use an existing **finalized, uncollected** invoice, or prepare one via the CLI
with dev stopped. CLI finalization intentionally does not start a Workflow:

```sh
npm run billing -- invoice cus_acme 2026-09
npm run dev
```

For isolated demos append `--persist-to="$TEST_STATE"` to the invoice command
and use `payment-test` mode as above. The seeded Acme September invoice is
$11.76; immutable replay returns the same invoice. In contrast, the UI's
**Run invoice** automatically starts collection after finalization; default
processor success may pay it before you can select a different scenario.

1. Open <http://localhost:5173>, select the customer, then **Payment details &
   controls** on the invoice. Existing invoice lines, credits and usage remain.
2. Expand **Mock scenario controls**, choose a preset and **Save scenario
   queue**. This affects future new keys only, not historical attempts.
3. **Collect payment** starts/reuses the bounded generation. It is not a
   force-retry. Inspect authoritative paid/reserved/due/creditable amounts and
   `n/4` attempts; reserved money is still unresolved, not failed.
4. Soft decline → success waits 3 seconds. Later slots are 6 and 9 seconds
   (production day-1/3/7 labels). Hard decline requires **Simulate card update**
   within the fixed 30-second wait. Duplicate updates cannot reset budget or
   extend the deadline. After an ended run, opt into bounded resume explicitly.
5. **Reconcile payments** drains unapplied inbox and looks up original keys.
   The unchecked **Also resume bounded collection** option may start a new run
   and charge the remaining balance; it never bypasses unresolved money or the
   four-attempt limit. Read unresolved/error/conflict checks even when internal
   invariant issues are empty.
6. Pending normally succeeds after 2 seconds. Unresolved pending reaches
   needs-review after three 30-second checks and keeps its reservation. The
   **Needs attention** section includes reservations and merchant unapplied
   events, not merely Workflow failures. A real late result can still post
   after the old Workflow ends; no unsafe manual force-success UI is provided.
7. Expand attempts/timeline for immutable keys, method versions, processor IDs,
   notices, deadlines and Workflow IDs. Continue polling financial state:
   Workflow completion alone is not payment proof.

Credits remain approved operations: chat proposals require approval; the local
operator CLI can issue an explicitly approved credit with dev stopped. Credits
cannot exceed total minus credits, payments and unresolved reservations. A paid
invoice has no remaining creditability (refunds are not implemented). To test
approval/rejection with live AI manually, choose an uncollected invoice; tests
cover approval without making any model call.

## CLI inspection and recovery

The payment commands call the **running local HTTP API**, never a second D1
emulator. Default is `http://localhost:5173`; use `--url=http://127.0.0.1:PORT`
when Vite chooses another port. Only HTTP loopback targets are accepted. Output
is authoritative JSON; reconcile exits nonzero for unresolved/error/conflict
checks or unapplied inbox entries as well as internal issues.

```sh
npm run billing -- payments cus_acme
npm run billing -- payment inv_cus_acme_2026-09
npm run billing -- payment-timeline inv_cus_acme_2026-09
npm run billing -- payment-processor inv_cus_acme_2026-09
npm run billing -- collect inv_cus_acme_2026-09
npm run billing -- reconcile-payments inv_cus_acme_2026-09
npm run billing -- reconcile-payments inv_cus_acme_2026-09 --resume
```

Omitting invoice ID from `reconcile-payments` reconciles all collections; resume
is still opt-in. This action is the explicit retry owner for unapplied inbox,
missing webhooks and ended Workflows; there is no assumed background queue.

Legacy commands (`customers`, `usage`, `record`, `invoice`, `invoices`, `show`,
`credit`, `reconcile`) open local D1 directly: **stop dev first**. `reconcile`
checks only internal ledger/payment/reservation invariants; it does not contact
the processor. `record` rejects closed invoice periods and changed-payload
idempotency replays. No AI is involved in CLI arithmetic or mutations.

## Explorer, correlation logs and traces

See [`observability.md`](observability.md) for actual verified routes and query
examples. Explorer is developer-only and can mutate local resources: prefer
read-only inspection. Never use raw SQL to “repair” a payment or reservation.

## Demo security boundary

No real money, card data, email, or payment network is involved. Billing/chat
and payment controls have **no authentication**; customer selection is scoping,
not authorization. Processor bearer and HMAC values in Wrangler/shared protocol
are deliberately public demo fixtures, **not secrets**. Signed callbacks test
integrity/deduplication mechanics, not production security. Keep dev on loopback;
do not expose this demo or Explorer publicly. This work does not deploy anything.
