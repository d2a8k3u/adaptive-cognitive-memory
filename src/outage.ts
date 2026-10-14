import { SchemaTooNewError } from "./db/schema";
import { PLUGIN_INSTALL_ID, PLUGIN_NAME, PLUGIN_ROOT } from "./version";

export interface StorageOutage {
  readonly cause: string;
  readonly fix: string;
}

const NATIVE_LOAD_FAILURE_CODE = "ERR_DLOPEN_FAILED";
const MISSING_MODULE_CODES: ReadonlySet<string> = new Set([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
]);
const MISSING_SPECIFIER = /Cannot find (?:module|package) '([^']+)'/;
const SCOPED_PACKAGE_PREFIX = "@";

export const NATIVE_MODULE_FIX = `run npm rebuild better-sqlite3 in ${PLUGIN_ROOT}, or reinstall the plugin, so the native module matches node ${process.versions.node}`;
const UPDATE_FIX = "update the plugin to a version that reads this database";
const DEPENDENCY_FIX = `run claude plugin update ${PLUGIN_INSTALL_ID} to retry Claude Code's dependency install, or npm ci --ignore-scripts in ${PLUGIN_ROOT}`;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith(SCOPED_PACKAGE_PREFIX) ? segments.slice(0, 2).join("/") : segments[0];
}

function missingDependency(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code === undefined || !MISSING_MODULE_CODES.has(code) || !(error instanceof Error)) {
    return undefined;
  }
  const specifier = MISSING_SPECIFIER.exec(error.message)?.[1];
  return specifier === undefined ? undefined : packageName(specifier);
}

export function storageOutage(error: unknown): StorageOutage | undefined {
  if (error instanceof SchemaTooNewError) {
    return { cause: error.message, fix: UPDATE_FIX };
  }
  if (errorCode(error) === NATIVE_LOAD_FAILURE_CODE && error instanceof Error) {
    return { cause: `better-sqlite3 failed to load (${error.message})`, fix: NATIVE_MODULE_FIX };
  }
  const dependency = missingDependency(error);
  if (dependency !== undefined) {
    return {
      cause: `the plugin's npm dependencies are not installed (missing ${dependency})`,
      fix: DEPENDENCY_FIX,
    };
  }
  return undefined;
}

export function sessionNotice(outage: StorageOutage): string {
  return `${PLUGIN_NAME} memory is off for this session: ${outage.cause}. Fix: ${outage.fix}.`;
}

export function unavailableMessage(outage: StorageOutage): string {
  return `memory unavailable: ${outage.cause}. Fix: ${outage.fix}.`;
}
