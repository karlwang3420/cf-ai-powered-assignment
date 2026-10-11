# Automatic prompt history (Pi)

`.pi/extensions/prompt-history.ts` automatically appends human Pi input to the repository-root `PROMPTS.md`. Run Pi **from this repository root** and grant project trust when prompted. Run `/reload` in an already-open session to load the new extension; otherwise it loads on the next start. No global installation or dependencies are needed.

Entries are grouped under `## YYYY-MM-DD` date headings, with `[HH:mm:ss (UTC±HH:MM)]` timestamps at the beginning of each prompt's first line in your local timezone. Multiline prompts are preserved as Markdown blockquotes. Existing entries are never rewritten; submitting the same prompt again records another entry.

The extension checks the session's directory against its own repository location. It ignores other repositories (including nested repositories), extension-generated messages, and empty input. Human interactive/RPC input is recorded, including steering and follow-up prompts. Built-in slash commands and shell commands do not pass through Pi's prompt input event. Image attachments are noted by count, not saved. Logging errors are reported without preventing your prompt from being sent.

Only prompts submitted after the extension loads are captured automatically. The initial setup request was seeded from this Pi session with its original submission timestamp. Prompts sent through other AI tools are not captured.

Subagents run as separate Pi sessions in this repository, so the extension also recorded their task prompts. On 2026-10-10 those entries were removed from `PROMPTS.md` by hand and typos in the remaining prompts were corrected; the wording and timestamps are otherwise unchanged. **Review `PROMPTS.md` for secrets before committing or submitting it.**

Run the isolated regression tests with Node.js 24 or newer:

```sh
node --test tests/prompt-history.test.mjs
```
