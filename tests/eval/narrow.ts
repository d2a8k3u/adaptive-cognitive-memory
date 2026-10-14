export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string): JsonRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export function requireRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

export function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value;
}

export function requireString(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(record: JsonRecord, key: string, path: string): string | undefined {
  if (record[key] === undefined) {
    return undefined;
  }
  return requireString(record, key, path);
}

export function requireStringArray(
  record: JsonRecord,
  key: string,
  path: string,
): readonly string[] {
  return requireArray(record[key], `${path}.${key}`).map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new TypeError(`${path}.${key}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

export function requireEnum<T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = record[key];
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new TypeError(`${path}.${key} must be one of ${allowed.join(", ")}`);
  }
  return match;
}
