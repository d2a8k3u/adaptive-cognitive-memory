import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SMOKE_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const HOOK_LOG = join(SMOKE_ROOT, "opencode-hooks.log");

function logHook(hook, input) {
  appendFileSync(HOOK_LOG, `${JSON.stringify({ hook, input })}\n`);
}

export const OpenCodeProbe = async () => ({
  "chat.message": async (input) => logHook("chat.message", input),
  "tool.execute.after": async (input) => logHook("tool.execute.after", input),
});
