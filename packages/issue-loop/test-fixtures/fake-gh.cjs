const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
const mode = process.env.FIXTURE_MODE;
fs.appendFileSync(path.join(root, "gh-calls.jsonl"), `${JSON.stringify(args)}\n`);
const issue = (n) => ({
  number: n,
  title: n === 10 ? "Parent feature" : `Ticket ${n}`,
  body: mode === "unicode" ? "Price €5." : "Implement the requested feature.",
  state: "open",
  html_url: `https://github.com/test/project/issues/${n}`,
});
let result;
if (args[0] === "repo" && args[1] === "view")
  result = {
    nameWithOwner:
      process.env.GH_REPO && args[2] === "--json" ? process.env.GH_REPO : "test/project",
    defaultBranchRef: { name: "main" },
  };
else if (args[0] === "api") {
  const endpoint = args.find((a) => a === "user" || a.startsWith("repos/"));
  const login = process.env.FIXTURE_GH_LOGIN || "loop-author";
  if (endpoint === "user") result = { login };
  else if (endpoint.endsWith("/sub_issues"))
    result =
      mode === "empty"
        ? [[]]
        : mode.startsWith("parent-order")
          ? [[issue(12)], [issue(11)]]
          : [[issue(11)], [issue(12)]];
  else if (endpoint.endsWith("/dependencies/blocked_by"))
    result = [
      mode === "parent-order"
        ? []
        : endpoint.includes("/12/")
          ? [issue(11)]
          : mode === "cycle"
            ? [issue(12)]
            : [],
    ];
  else if (endpoint.includes("/issues/99/comments") || endpoint.includes("/issues/comments/")) {
    const file = path.join(root, "pr-comments.json");
    const comments = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (method === "GET") {
      if (!args.includes("--paginate") || !args.includes("--slurp")) {
        console.error("Missing pagination flags");
        process.exit(2);
      }
      result = comments.map((comment) => [comment]);
    } else {
      const bodyFile = args[args.indexOf("--field") + 1].slice("body=@".length);
      const body = fs.readFileSync(bodyFile, "utf8");
      if (method === "POST") {
        result = {
          id: Math.max(0, ...comments.map((comment) => comment.id)) + 1,
          body,
          user: { login },
        };
        comments.push(result);
        fs.appendFileSync(path.join(root, "comments-created.txt"), "created\n");
      } else if (method === "PATCH") {
        result = comments.find((comment) => comment.id === Number(endpoint.split("/").pop()));
        if (!result) {
          console.error("Comment not found");
          process.exit(2);
        }
        result.body = body;
      } else {
        console.error("Unexpected comment method");
        process.exit(2);
      }
      fs.writeFileSync(file, JSON.stringify(comments));
      if ((mode === "comment-create-fail" || mode === "integrated") && method === "POST") {
        console.error("Connection lost after posting comment");
        process.exit(1);
      }
    }
  } else if (endpoint.endsWith("/comments"))
    result = mode === "comments" ? [[{ body: "UNTRUSTED_COMMENT_INSTRUCTION" }]] : [[]];
  else result = issue(Number(endpoint.split("/").pop()));
} else if (args[0] === "pr" && args[1] === "list")
  result =
    mode === "pr-ambiguous"
      ? [
          { url: "https://github.com/test/project/pull/99", state: "OPEN" },
          { url: "https://github.com/test/project/pull/100", state: "OPEN" },
        ]
      : fs.existsSync(path.join(root, "pr.json"))
        ? [{ url: "https://github.com/test/project/pull/99", state: "OPEN" }]
        : [];
else if (args[0] === "pr" && args[1] === "create") {
  fs.writeFileSync(path.join(root, "pr.json"), JSON.stringify(args));
  fs.appendFileSync(path.join(root, "pr-created.txt"), "created\n");
  if (mode === "publish-fail") {
    console.error("Connection lost after creating PR");
    process.exit(1);
  }
  console.log("https://github.com/test/project/pull/99");
  process.exit(0);
} else {
  console.error("Unexpected gh args", args);
  process.exit(2);
}
const output = Buffer.from(JSON.stringify(result));
const split = mode === "unicode" ? output.indexOf(Buffer.from("€")) : -1;
if (split >= 0) {
  process.stdout.write(output.subarray(0, split + 1));
  setTimeout(() => process.stdout.end(output.subarray(split + 1)), 50);
} else console.log(output.toString());
