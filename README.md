# Billing Assistant

An AI billing assistant for a usage-based cloud platform, built on Cloudflare.

> **Status:** the chat agent works. Billing data (D1), invoicing (Workflows), and
> billing tools for the assistant are not built yet.

## Architecture

| Component      | Implementation                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| LLM            | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)         |
| Chat input     | React + Vite UI, streamed over WebSockets via the Agents SDK                     |
| Memory / state | Chat history in each `BillingAssistant` agent's built-in SQLite (Durable Object) |
| Billing data   | _Planned:_ one shared D1 database as the source of truth                         |
| Coordination   | _Planned:_ Cloudflare Workflows for invoice runs                                 |

## Run locally

Requires Node.js 24+ and a Cloudflare account. Workers AI has no local
simulator, so local development calls Cloudflare remotely.

```sh
npm install
npx wrangler login
npm run dev
```

Open <http://localhost:5173>.

## Checks

```sh
npm run check   # formatting, lint, and type checking
npm test        # unit tests
```

## Notes

- **Duplicate streaming text:** Workers AI streams Llama 3.3 text in two formats
  in each chunk, and `workers-ai-provider` emits both. `src/workers-ai.ts`
  removes the duplicate before the provider reads the stream.
- **Prompt history:** prompts are recorded in `PROMPTS.md` by a repo-local Pi
  extension; see `docs/prompt-history.md`.
- **Starter template:** this project is based on Cloudflare's
  [`agents-starter`](https://github.com/cloudflare/agents-starter) template
  (MIT license, see `LICENSE.agents-starter`).
