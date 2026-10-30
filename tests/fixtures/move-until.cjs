const { realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { sep } = require("node:path");
const { loadConfig } = require("../../dist/cfg.js");
const { moveStore } = require("../../dist/storemove.js");

const tempRoots = [tmpdir(), realpathSync(tmpdir())];

function underTempDir(path) {
  return tempRoots.some((root) => path.startsWith(`${root}${sep}`));
}

const from = process.argv[2];
const config = loadConfig(process.env);
if (from === undefined || !underTempDir(realpathSync(from)) || !underTempDir(config.dataDir)) {
  console.error("move-until runs only against stores under tmpdir()");
  process.exit(2);
}

const killAfter = process.env.ACM_MOVE_KILL_AFTER;
const outcome = moveStore(from, config, new Date().toISOString(), (step) => {
  if (step === killAfter) {
    process.kill(process.pid, "SIGKILL");
  }
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
