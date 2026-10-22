// Argument encoding for the ketch CLI. Adapted from the ketch pi extension
// (1broseidon/ketch, plugins/pi/extensions/ketch.ts, MIT).

/**
 * Appends `--flag=value` when value is set. The `=` form binds the value to the
 * flag even when it starts with `-`, so a selector can't become a flag.
 */
export function flag(args: string[], name: string, value: string | number | undefined): void {
  if (value === undefined || value === "") return;
  args.push(`${name}=${value}`);
}

/** Appends a boolean `--flag` when true. */
export function toggle(args: string[], name: string, value: boolean | undefined): void {
  if (value) args.push(name);
}

/**
 * Ends the option list: everything after `--` is positional, so a query or URL
 * that starts with `-` is searched or fetched as text, never parsed as a flag.
 */
export function positional(args: string[], ...values: string[]): string[] {
  args.push("--", ...values);
  return args;
}
