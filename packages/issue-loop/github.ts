import { command } from "./process.ts";
import type { Issue, Ticket } from "./state.ts";

export async function gh(cwd: string, ...args: string[]): Promise<string> {
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

export async function getIssue(cwd: string, repo: string, number: number): Promise<Issue> {
  return issue(JSON.parse(await gh(cwd, "api", `repos/${repo}/issues/${number}`)));
}

async function pages(cwd: string, endpoint: string): Promise<unknown[]> {
  const result: unknown = JSON.parse(await gh(cwd, "api", endpoint, "--paginate", "--slurp"));
  if (!Array.isArray(result) || !result.every(Array.isArray))
    throw new Error("Invalid paginated GitHub response");
  return result.flat();
}

async function withComments(cwd: string, repo: string, value: Issue): Promise<Issue> {
  const comments = await pages(cwd, `repos/${repo}/issues/${value.number}/comments`);
  const bodies = comments.map((comment) => {
    const body = (comment as { body?: unknown }).body;
    if (typeof body !== "string") throw new Error("Invalid GitHub comment");
    return body;
  });
  return {
    ...value,
    body: `${value.body}${bodies.length ? `\n\n## Issue comments\n\n${bodies.join("\n\n---\n\n")}` : ""}`,
  };
}

export async function snapshot(
  cwd: string,
  repo: string,
  number: number,
): Promise<{ parent: Issue; tickets: Ticket[] }> {
  const parent = await withComments(cwd, repo, await getIssue(cwd, repo, number));
  if (parent.state !== "open") throw new Error("The parent issue must be open");
  const children = (await pages(cwd, `repos/${repo}/issues/${number}/sub_issues`)).map(issue);
  const tickets: Ticket[] = [];
  // Stable numeric order is the tie-break; dependencies always take precedence.
  for (const child of children
    .filter((child) => child.state === "open")
    .sort((a, b) => a.number - b.number)) {
    if (child.html_url !== `https://github.com/${repo}/issues/${child.number}`)
      throw new Error("Cross-repository child issues are not supported in this MVP");
    const blockers = (
      await pages(cwd, `repos/${repo}/issues/${child.number}/dependencies/blocked_by`)
    ).map(issue);
    tickets.push({
      ...(await withComments(cwd, repo, child)),
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
