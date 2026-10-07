-- Demo customers with daily usage from 2026-08-01 through 2026-10-06.
-- Safe to re-run: every row has a fixed id and is inserted OR IGNORE.
--
-- Expected invoices (see tests/billing-store.test.mjs):
--   Acme Robotics  Aug $5.00, Sep $11.76  (requests and AI both grow past the allowance)
--   Nimbus Labs    Aug $200.00, Sep $330.00  (AI spike on Sep 15-20)
--   Orbit Coffee   Aug $5.00, Sep $5.00  (light usage, fee only)

INSERT OR IGNORE INTO customers (id, name, email, plan_id, created_at) VALUES
  ('cus_acme', 'Acme Robotics', 'billing@acme.example', 'standard', '2026-07-15T00:00:00.000Z'),
  ('cus_nimbus', 'Nimbus Labs', 'finance@nimbus.example', 'scale', '2026-07-15T00:00:00.000Z'),
  ('cus_orbit', 'Orbit Coffee', 'owner@orbit.example', 'standard', '2026-07-15T00:00:00.000Z');

WITH RECURSIVE
  days(d) AS (SELECT 0 UNION ALL SELECT d + 1 FROM days WHERE d < 66),
  dates(day, dom) AS (
    SELECT date('2026-08-01', '+' || d || ' days'),
      CAST(strftime('%d', date('2026-08-01', '+' || d || ' days')) AS INTEGER)
    FROM days
  ),
  usage(customer_id, meter_id, day, quantity) AS (
    SELECT 'cus_acme', 'workers_requests', day, CASE
      WHEN day < '2026-09-01' THEN 250000
      WHEN day < '2026-10-01' THEN 500000 + 15000 * (dom - 1)
      ELSE 700000 END FROM dates
    UNION ALL
    SELECT 'cus_acme', 'ai_neurons', day, CASE
      WHEN day < '2026-09-01' THEN 8000
      WHEN day < '2026-10-01' THEN 20000
      ELSE 22000 END FROM dates
    UNION ALL
    SELECT 'cus_nimbus', 'workers_requests', day, CASE
      WHEN day < '2026-09-01' THEN 2000000
      ELSE 4000000 END FROM dates
    UNION ALL
    SELECT 'cus_nimbus', 'ai_neurons', day, CASE
      WHEN day < '2026-09-01' THEN 200000
      WHEN day BETWEEN '2026-09-15' AND '2026-09-20' THEN 3000000
      ELSE 250000 END FROM dates
    UNION ALL
    SELECT 'cus_orbit', 'workers_requests', day, 50000 FROM dates
  )
INSERT OR IGNORE INTO usage_events (id, customer_id, meter_id, quantity, occurred_at, received_at)
SELECT 'seed:' || customer_id || ':' || meter_id || ':' || day, customer_id, meter_id,
  quantity, day || 'T12:00:00.000Z', day || 'T12:05:00.000Z'
FROM usage;
