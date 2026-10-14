"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_MODULE_FIX = void 0;
exports.storageOutage = storageOutage;
exports.sessionNotice = sessionNotice;
exports.unavailableMessage = unavailableMessage;
const schema_1 = require("./db/schema");
const version_1 = require("./version");
const NATIVE_LOAD_FAILURE_CODE = "ERR_DLOPEN_FAILED";
exports.NATIVE_MODULE_FIX = `run npm rebuild better-sqlite3 in ${version_1.PLUGIN_ROOT}, or reinstall the plugin, so the native module matches node ${process.versions.node}`;
const UPDATE_FIX = "update the plugin to a version that reads this database";
function nativeLoadFailure(error) {
    return error instanceof Error && "code" in error && error.code === NATIVE_LOAD_FAILURE_CODE;
}
function storageOutage(error) {
    if (error instanceof schema_1.SchemaTooNewError) {
        return { cause: error.message, fix: UPDATE_FIX };
    }
    if (nativeLoadFailure(error)) {
        return { cause: `better-sqlite3 failed to load (${error.message})`, fix: exports.NATIVE_MODULE_FIX };
    }
    return undefined;
}
function sessionNotice(outage) {
    return `${version_1.PLUGIN_NAME} memory is off for this session: ${outage.cause}. Run /memory-doctor for the fix.`;
}
function unavailableMessage(outage) {
    return `memory unavailable: ${outage.cause}. Fix: ${outage.fix}.`;
}
