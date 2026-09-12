/**
 * Canonical guards for the browser-view layer (8 isRecord and 3 clamp copies
 * consolidated). isRecord excludes arrays: all call sites narrow to keyed
 * property reads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Bounding kit for untrusted values (guest payloads, CDP replies). `bounded*`
 * truncates, `*Value` narrows-or-null; both folders under browser-view share
 * these instead of re-declaring them per file.
 */
export function boundedString(
  value: unknown,
  max: number,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

export function boundedStringOrNull(
  value: unknown,
  max: number,
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The value a `Runtime.evaluate` reply carries, or `null` for a reply that is
 * not one: a page that THREW has no value worth parsing, and its exception
 * detail carries page-authored text - so it is dropped rather than read.
 */
export function readEvaluateValue(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (isRecord(value.exceptionDetails)) return null;
  const result = value.result;
  return isRecord(result) ? result.value : null;
}
