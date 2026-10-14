const fs = require("node:fs");

if (process.argv.includes("model-init")) {
  fs.appendFileSync(process.env.ACM_MODEL_INIT_MARKER, `${process.pid}\n`);
}
