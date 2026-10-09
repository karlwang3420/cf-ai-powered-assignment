import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

export default defineConfig(({ mode }) => {
  const isolated = mode === "payment-test";
  if (isolated && !process.env.PAYMENT_TEST_PERSIST) {
    throw new Error(
      "payment-test mode requires an isolated PAYMENT_TEST_PERSIST directory"
    );
  }
  return {
    plugins: [
      agents(),
      react(),
      cloudflare({
        auxiliaryWorkers: [{ configPath: "processor/wrangler.jsonc" }],
        // Integration tests must never touch demo state or connect to Workers AI.
        ...(isolated
          ? {
              persistState: { path: process.env.PAYMENT_TEST_PERSIST! },
              // Shorten demo waits (30s pending/card, 3/6/9s dunning) for tests.
              config: (config) => ({
                vars: {
                  ...config.vars,
                  PAYMENT_TIME_SCALE: process.env.PAYMENT_TIME_SCALE ?? "0.2"
                }
              }),
              remoteBindings: false,
              inspectorPort: false
            }
          : {})
      }),
      tailwindcss()
    ]
  };
});
