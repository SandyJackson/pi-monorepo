/**
 * herdr-subagent — visible, interactive `pi` sub-agent panes inside Herdr
 *
 * Extension entrypoint. Derives runtime options from Pi context and delegates
 * tool execution to the backend-neutral sub-agent runner.
 *
 * Public API: tasks: [{agent, task, cwd?}] and timeout.
 * One task runs a single visible sub-agent. Multiple tasks run in parallel.
 * Missing or empty tasks lists available callable agents.
 *
 * Backend is auto-detected from the environment (Herdr for now).
 * Project-agent discovery is session-scoped and governed by Pi project trust.
 * The tool is registered on session_start so the description reflects the
 * session working directory and project trust status.
 *
 * Replaces @tintinweb/pi-subagents.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	discoverUserAgents,
	discoverProjectAgents,
	mergeAgentLists,
	formatMergedAgentList,
} from "./agents.ts";
import { HerdrBackend } from "./herdr-backend.ts";
import { runSubagents, type RunnerOptions } from "./subagent-runner.ts";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process (default: parent session cwd)" }),
	),
});

const SubagentParams = Type.Object({
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Array of {agent, task, cwd?}. One task runs a single visible sub-agent; " +
				"multiple tasks run visible sub-agents in parallel (max 8). " +
				"Omit or pass an empty array to list available agents.",
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Per-task delegation timeout in minutes (default: 20). " +
				"On expiry the child pane is left running for manual inspection.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Tool registration (session-scoped)
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		const sessionCwd = ctx.cwd;
		const includeProjectAgents = ctx.isProjectTrusted();

		// Discover and merge callable agents for the description.
		const userAgents = discoverUserAgents();
		const projectAgents = includeProjectAgents
			? discoverProjectAgents(sessionCwd)
			: [];
		const mergedAgents = mergeAgentLists(userAgents, projectAgents);

		const agentsSuffix =
			mergedAgents.length > 0
				? `\nAvailable agents:\n${formatMergedAgentList(mergedAgents)}`
				: "";

		const description = [
			"Delegate work to a visible sub-agent for tasks matching one of the specialised agents below.",
			"The sub-agent opens as a real interactive pane you can watch and later take over.",
			"",
			"Call with no arguments to list available agents.",
			"",
			"Usage:",
			"  {}                                        -> list agents",
			'  {tasks: [{agent:"foo", task:"..."}]}        -> single visible sub-agent',
			'  {tasks: [{agent:"foo", task:"..."}, ...]}   -> parallel visible sub-agents',
			"  timeout: per-task timeout in minutes",
		].join("\n") + agentsSuffix;

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description,
			parameters: SubagentParams,

			async execute(
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate:
					| ((update: {
							content: Array<{ type: "text"; text: string }>;
							details: Record<string, unknown>;
					  }) => void)
					| undefined,
				_ctx: ExtensionContext,
			) {
				const options: RunnerOptions = {
					parentCwd: sessionCwd,
					includeProjectAgents,
					detectAutoBackend: () => HerdrBackend.fromEnv(),
				};

				return runSubagents(toolCallId, options, params, signal, onUpdate);
			},
		});
	});
}
