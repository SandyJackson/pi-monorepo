import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Installed packages for tests, independent of the developer's Pi configuration. */
export function installDefaultExtensions(agentDir: string): void {
  for (const [name, root] of [
    ["pi-claude-bridge", join(agentDir, "npm", "node_modules", "pi-claude-bridge")],
    ["ketch-pi", join(agentDir, "git", "github.com", "1broseidon", "ketch")],
  ]) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.js"), "export default () => {};\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "1.2.3",
        pi: { extensions: ["./index.js"] },
      }),
    );
  }
}
