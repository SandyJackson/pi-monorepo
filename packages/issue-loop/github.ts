import { command } from "./process.ts";
import type { Issue, Ticket } from "./state.ts";

/**
 * GitHub hostname derived from a validated origin URL, or `undefined` when
 * the origin is not a GitHub URL (local paths used in tests). Hosts compare
 * case-insensitively; the caller decides the default.
 */
export function githubHostFromOrigin(origin: string): string | undefined {
  const scp = origin.match(/^git@([^:]+):/);
  if (scp) return scp[1].toLowerCase();
  const url = origin.match(/^https?:\/\/([^/]+)\//);
  if (url) return url[1].toLowerCase();
  const ssh = origin.match(/^ssh:\/\/[^@]+@([^/]+)\//);
  if (ssh) return ssh[1].toLowerCase();
  return undefined;
}

/**
 * Run `gh` bound to the origin host. A mismatched inherited `GH_HOST` is
 * rejected instead of letting reads or PR creation land on another host;
 * otherwise the expected host is forced for the child process.
 */
export async function gh(
  cwd: string,
  host: string | undefined,
  ...args: string[]
): Promise<string> {
  if (host !== undefined) {
    const inherited = process.env.GH_HOST;
    if (inherited && inherited.toLowerCase() !== host.toLowerCase()) {
      throw new Error(
        `GH_HOST=${inherited} does not match this run's origin host ${host}; refusing to contact a different GitHub host`,
      );
    }
    return command("gh", args, { cwd, env: { GH_HOST: host } });
  }
  return command("gh", args, { cwd });
}

function issue(value: unknown): Issue {
  const result = value as Issue & { pull_request?: unknown };
  if (
    !result ||
    !Number.isInteger(result.number) ||
    typeof result.title !== "string" ||
    typeof result.html_url !== "string" ||
    !["open", "closed"].includes(result.state) ||
    result.pull_request
  ) {
    throw new Error("Expected a GitHub issue, not a pull request or an invalid API response");
  }
  return {
    number: result.number,
    title: result.title,
    body: result.body ?? "",
    html_url: result.html_url,
    state: result.state,
  };
}

export async function getIssue(
  cwd: string,
  host: string | undefined,
  repo: string,
  number: number,
): Promise<Issue> {
  return issue(JSON.parse(await gh(cwd, host, "api", `repos/${repo}/issues/${number}`)));
}

async function pages(cwd: string, host: string | undefined, endpoint: string): Promise<unknown[]> {
  const result: unknown = JSON.parse(await gh(cwd, host, "api", endpoint, "--paginate", "--slurp"));
  if (!Array.isArray(result) || !result.every(Array.isArray))
    throw new Error("Invalid paginated GitHub response");
  return result.flat();
}

export async function snapshot(
  cwd: string,
  host: string | undefined,
  repo: string,
  number: number,
): Promise<{ parent: Issue; tickets: Ticket[] }> {
  const parent = await getIssue(cwd, host, repo, number);
  if (parent.state !== "open") throw new Error("The parent issue must be open");
  const children = (await pages(cwd, host, `repos/${repo}/issues/${number}/sub_issues`)).map(issue);
  const tickets: Ticket[] = [];
  // Preserve the parent's order across pages; dependencies still take precedence.
  const base = `https://${host ?? "github.com"}/`;
  for (const child of children.filter((child) => child.state === "open")) {
    if (child.html_url !== `${base}${repo}/issues/${child.number}`)
      throw new Error("Cross-repository child issues are not supported in this MVP");
    const blockers = (
      await pages(cwd, host, `repos/${repo}/issues/${child.number}/dependencies/blocked_by`)
    ).map(issue);
    tickets.push({
      ...child,
      blockers,
      repairs: 0,
      status: "pending",
    });
  }
  if (!tickets.length)
    throw new Error(
      "No open direct child issues. This runner requires an implementation-ready child queue",
    );
  return { parent, tickets };
}
