// Deploys the hosted demo: the mock processor (no public URL), then the app
// behind Cloudflare Access. Create the Access application first; see
// docs/deploy.md. Usage:
//   DEMO_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
//   DEMO_ACCESS_AUD=<application audience tag> npm run deploy:demo
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const MAIN = "billing-assistant";
const PROCESSOR_CONFIG = "dist/mock_payment_processor/wrangler.json";
const team = process.env.DEMO_ACCESS_TEAM_DOMAIN?.trim();
const aud = process.env.DEMO_ACCESS_AUD?.trim();
if (!team || !aud || /[\s:/]/.test(team) || /[\s:]/.test(aud)) {
  console.error(
    "Set DEMO_ACCESS_TEAM_DOMAIN (e.g. myteam.cloudflareaccess.com) and\n" +
      "DEMO_ACCESS_AUD (the Access application's audience tag). Without them\n" +
      "the deployed app refuses every request. See docs/deploy.md."
  );
  process.exit(1);
}

function run(command, args, { allowFailure = false, quiet = false } = {}) {
  const bin = {
    vite: "node_modules/vite/bin/vite.js",
    wrangler: "node_modules/wrangler/bin/wrangler.js"
  }[command];
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [bin, ...args], {
    stdio: quiet ? "pipe" : "inherit"
  });
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1);
  return result.status === 0;
}

run("vite", ["build"]);

// Each Worker binds to the other, and a binding's target must already exist.
// On the first deploy the processor goes up once without its callback binding.
const mainExists = run("wrangler", ["deployments", "list", "--name", MAIN], {
  allowFailure: true,
  quiet: true
});
if (!mainExists) {
  const bootstrap = PROCESSOR_CONFIG.replace(".json", ".bootstrap.json");
  const config = JSON.parse(readFileSync(PROCESSOR_CONFIG, "utf8"));
  delete config.services;
  writeFileSync(bootstrap, JSON.stringify(config));
  run("wrangler", ["deploy", "--config", bootstrap]);
}

// The vite build redirects this to dist/billing_assistant/wrangler.json
run("wrangler", [
  "deploy",
  "--var",
  `DEMO_ACCESS_TEAM_DOMAIN:${team}`,
  "--var",
  `DEMO_ACCESS_AUD:${aud}`
]);
run("wrangler", ["deploy", "--config", PROCESSOR_CONFIG]);

console.log(
  "\nDeployed. The first signed-in request seeds the database. Open the app's\n" +
    "workers.dev URL; without an Access sign-in every API call returns 403."
);
