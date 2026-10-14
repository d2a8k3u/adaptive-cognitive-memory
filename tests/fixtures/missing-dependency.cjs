const Module = require("node:module");

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveWithoutBetterSqlite(request, ...rest) {
  if (request === "better-sqlite3") {
    const error = new Error(`Cannot find module '${request}'\nRequire stack:\n- ${__filename}`);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return originalResolveFilename.call(this, request, ...rest);
};
