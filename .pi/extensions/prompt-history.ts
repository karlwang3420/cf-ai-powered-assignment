import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Anchor to this extension's repository, never to an arbitrary session cwd.
const repoRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../..")
);
const promptsPath = join(repoRoot, "PROMPTS.md");

function isThisRepo(cwd: string): boolean {
  let directory = realpathSync(cwd);
  const within = relative(repoRoot, directory);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    return false;
  }
  // Do not capture prompts from a separate repository nested inside this one.
  while (directory !== repoRoot) {
    if (existsSync(join(directory, ".git"))) return false;
    directory = dirname(directory);
  }
  return existsSync(join(repoRoot, ".git"));
}

const pad = (value: number) => String(value).padStart(2, "0");

export default function (pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    // Capture human input, not agent/extension-generated follow-ups.
    if (event.source === "extension") return { action: "continue" };
    if (!event.text.trim() && !event.images?.length)
      return { action: "continue" };

    try {
      if (!isThisRepo(ctx.cwd)) return { action: "continue" };

      const now = new Date();
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const offset = -now.getTimezoneOffset();
      const zone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
      const existing = existsSync(promptsPath)
        ? readFileSync(promptsPath, "utf8")
        : "";
      const dates = [...existing.matchAll(/^## (\d{4}-\d{2}-\d{2})\r?$/gm)];
      let entry = existing
        ? existing.endsWith("\n\n")
          ? ""
          : existing.endsWith("\n")
            ? "\n"
            : "\n\n"
        : "# Prompt History\n\n";
      if (dates.at(-1)?.[1] !== date) entry += `## ${date}\n\n`;
      // Blockquotes preserve multiline prompts and prevent user Markdown from
      // being mistaken for the log's date headings on subsequent appends.
      entry += event.text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line, index) =>
          index === 0 ? `> [${time} (${zone})] ${line}` : `> ${line}`
        )
        .join("\n");
      if (event.images?.length) {
        entry += `\n> \n> [${event.images.length} image(s) attached; image content not recorded.]`;
      }
      entry += "\n\n";
      // One synchronous append keeps submissions ordered within this Pi process.
      appendFileSync(promptsPath, entry, "utf8");
    } catch (error) {
      const message = `Could not append prompt to PROMPTS.md: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
    }

    // Logging must never change or consume the user's prompt.
    return { action: "continue" };
  });
}
