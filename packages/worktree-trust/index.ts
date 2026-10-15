/**
 * worktree-trust — linked Git worktrees inherit their repository's project trust.
 *
 * Review, issue-loop and `wt` worktrees live at fresh paths, so Pi asks for
 * trust in each one and interactive subagent panes block on the prompt. This
 * extension answers Pi's `project_trust` event with "yes" when the
 * repository's main worktree is trusted and the worktree's skills and Pi
 * config match that worktree's HEAD. It never writes trust.json; every other
 * case is left to Pi's saved decisions and prompt.
 */

import { type ExtensionAPI, getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { decideWorktreeTrust } from "./worktree-trust.ts";

export default function worktreeTrust(pi: ExtensionAPI): void {
  const trustStore = new ProjectTrustStore(getAgentDir());
  pi.on("project_trust", async (event) => ({
    trusted: await decideWorktreeTrust(event.cwd, trustStore),
  }));
}
