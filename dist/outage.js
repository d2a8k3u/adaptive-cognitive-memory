"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_MODULE_FIX = void 0;
exports.storageOutage = storageOutage;
exports.sessionNotice = sessionNotice;
exports.unavailableMessage = unavailableMessage;
const schema_1 = require("./db/schema");
const version_1 = require("./version");
const NATIVE_LOAD_FAILURE_CODE = "ERR_DLOPEN_FAILED";
const MISSING_MODULE_CODES = new Set([
    "MODULE_NOT_FOUND",
    "ERR_MODULE_NOT_FOUND",
]);
const MISSING_SPECIFIER = /Cannot find (?:module|package) '([^']+)'/;
const SCOPED_PACKAGE_PREFIX = "@";
exports.NATIVE_MODULE_FIX = `run npm rebuild better-sqlite3 in ${version_1.PLUGIN_ROOT}, or reinstall the plugin, so the native module matches node ${process.versions.node}`;
const UPDATE_FIX = "update the plugin to a version that reads this database";
function errorCode(error) {
    return error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}
function packageName(specifier) {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
        return undefined;
    }
    const segments = specifier.split("/");
    return specifier.startsWith(SCOPED_PACKAGE_PREFIX) ? segments.slice(0, 2).join("/") : segments[0];
}
function missingDependency(error) {
    const code = errorCode(error);
    if (code === undefined || !MISSING_MODULE_CODES.has(code) || !(error instanceof Error)) {
        return undefined;
    }
    const specifier = MISSING_SPECIFIER.exec(error.message)?.[1];
    return specifier === undefined ? undefined : packageName(specifier);
}
function storageOutage(error, dependencyFix) {
    if (error instanceof schema_1.SchemaTooNewError) {
        return { cause: error.message, fix: UPDATE_FIX };
    }
    if (errorCode(error) === NATIVE_LOAD_FAILURE_CODE && error instanceof Error) {
        return { cause: `better-sqlite3 failed to load (${error.message})`, fix: exports.NATIVE_MODULE_FIX };
    }
    const dependency = missingDependency(error);
    if (dependency !== undefined) {
        return {
            cause: `the plugin's npm dependencies are not installed (missing ${dependency})`,
            fix: dependencyFix,
        };
    }
    return undefined;
}
function sessionNotice(outage) {
    return `${version_1.PLUGIN_NAME} memory is off for this session: ${outage.cause}. Fix: ${outage.fix}.`;
}
function unavailableMessage(outage) {
    return `memory unavailable: ${outage.cause}. Fix: ${outage.fix}.`;
}
