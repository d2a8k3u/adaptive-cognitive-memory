const originalDlopen = process.dlopen;

process.dlopen = function dlopenRejectingBetterSqlite(module, filename, ...rest) {
  if (String(filename).includes("better-sqlite3")) {
    const error = new Error(
      `The module '${filename}' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127. Please try re-compiling or re-installing the module (for instance, using \`npm rebuild\` or \`npm install\`).`,
    );
    error.code = "ERR_DLOPEN_FAILED";
    throw error;
  }
  return originalDlopen.call(this, module, filename, ...rest);
};
