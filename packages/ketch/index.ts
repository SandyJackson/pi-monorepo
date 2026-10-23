// Ketch research tools that shell out to the `ketch` CLI. See
// docs/adr/0010-own-the-ketch-tools-and-skill.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodeTool } from "./code.ts";
import { createDocsTool } from "./docs.ts";
import type { Exec } from "./runner.ts";
import { createScrapeTool } from "./scrape.ts";
import { createSearchTool } from "./search.ts";

export default function ketch(pi: ExtensionAPI): void {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  pi.registerTool(createSearchTool(exec));
  pi.registerTool(createCodeTool(exec));
  pi.registerTool(createDocsTool(exec));
  pi.registerTool(createScrapeTool(exec));
}
