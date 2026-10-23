// Reading fields out of ketch's JSON. Each tool picks the fields it returns, so
// unexpected CLI fields never reach the model or scripts.

export type Raw = Record<string, unknown>;

/** The CLI prints one object for a single result and an array otherwise. */
export function items(json: unknown): Raw[] {
  if (json == null) return [];
  return (Array.isArray(json) ? json : [json]).map((item) =>
    item && typeof item === "object" ? (item as Raw) : {},
  );
}

export function str(raw: Raw, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function int(raw: Raw, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function strs(raw: Raw, key: string): string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v !== "");
  return out.length > 0 ? out : undefined;
}

/** Drops undefined fields, which JSON can't carry and the output schemas reject. */
export function defined<T extends Raw>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** `## [label](url)`, numbered when there is more than one result. */
export function heading(label: string, url: string | undefined, index: number, total: number) {
  const text = total > 1 ? `${index + 1}. ${label}` : label;
  return url ? `## [${text}](${url})` : `## ${text}`;
}
