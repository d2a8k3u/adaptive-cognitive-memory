import { SchemaTooNewError } from "./db/schema";
import { PLUGIN_NAME, PLUGIN_ROOT } from "./version";

export interface StorageOutage {
  readonly cause: string;
  readonly fix: string;
}

const NATIVE_LOAD_FAILURE_CODE = "ERR_DLOPEN_FAILED";

export const NATIVE_MODULE_FIX = `run npm rebuild better-sqlite3 in ${PLUGIN_ROOT}, or reinstall the plugin, so the native module matches node ${process.versions.node}`;
const UPDATE_FIX = "update the plugin to a version that reads this database";

function nativeLoadFailure(error: unknown): error is Error {
  return error instanceof Error && "code" in error && error.code === NATIVE_LOAD_FAILURE_CODE;
}

export function storageOutage(error: unknown): StorageOutage | undefined {
  if (error instanceof SchemaTooNewError) {
    return { cause: error.message, fix: UPDATE_FIX };
  }
  if (nativeLoadFailure(error)) {
    return { cause: `better-sqlite3 failed to load (${error.message})`, fix: NATIVE_MODULE_FIX };
  }
  return undefined;
}

export function sessionNotice(outage: StorageOutage): string {
  return `${PLUGIN_NAME} memory is off for this session: ${outage.cause}. Run /memory-doctor for the fix.`;
}

export function unavailableMessage(outage: StorageOutage): string {
  return `memory unavailable: ${outage.cause}. Fix: ${outage.fix}.`;
}
