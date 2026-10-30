const { realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { sep } = require("node:path");
const Database = require("better-sqlite3");

const tempRoots = [tmpdir(), realpathSync(tmpdir())];
const dbPath = process.argv[2];
if (
  dbPath === undefined ||
  !tempRoots.some((root) => realpathSync(dbPath).startsWith(`${root}${sep}`))
) {
  console.error("move-writer runs only against stores under tmpdir()");
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS move_probe (seq INTEGER PRIMARY KEY)");
const insert = db.prepare("INSERT INTO move_probe (seq) VALUES (?)");
let committed = 0;
let stopping = false;

process.stdin.on("end", () => {
  stopping = true;
});
process.stdin.resume();

function commitNext() {
  try {
    insert.run(committed + 1);
    committed += 1;
  } catch (error) {
    if (error.code !== "SQLITE_BUSY") {
      throw error;
    }
  }
}

function loop() {
  if (stopping) {
    db.close();
    process.stdout.write(`committed ${committed}\n`);
    return;
  }
  commitNext();
  setTimeout(loop, 1);
}

loop();
