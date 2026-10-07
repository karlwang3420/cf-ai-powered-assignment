-- Plans, meters, and prices. Loosely modeled on Cloudflare's public Workers
-- and Workers AI pricing, simplified to monthly allowances.

INSERT INTO meters (id, name, unit) VALUES
  ('workers_requests', 'Workers requests', 'requests'),
  ('ai_neurons', 'Workers AI', 'neurons');

INSERT INTO plans (id, name, monthly_fee_cents) VALUES
  ('standard', 'Standard', 500),
  ('scale', 'Scale', 20000);

-- unit_price_micros is the price of one block: 300000 per 1000000 requests
-- is $0.30 per million.
INSERT INTO price_tiers (plan_id, meter_id, from_quantity, unit_price_micros, block_size) VALUES
  ('standard', 'workers_requests', 0, 0, 1000000),
  ('standard', 'workers_requests', 10000000, 300000, 1000000),
  ('standard', 'ai_neurons', 0, 0, 1000),
  ('standard', 'ai_neurons', 300000, 11000, 1000),
  ('scale', 'workers_requests', 0, 0, 1000000),
  ('scale', 'workers_requests', 100000000, 200000, 1000000),
  ('scale', 'ai_neurons', 0, 0, 1000),
  ('scale', 'ai_neurons', 10000000, 9000, 1000);
