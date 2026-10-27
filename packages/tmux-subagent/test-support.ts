import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TmuxExec } from "./tmux.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/**
 * A stand-in for Pi's extension API: tests emit extension events in order
 * and control the state the context reports. No Pi process is started.
 */
export function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const sent: Array<{ text: string; deliverAs?: string }> = [];
  const tools: Array<{ name: string }> = [];
  const flags: Record<string, string | boolean | undefined> = {};
  const state = {
    idle: true,
    pendingMessages: false,
    leafId: null as string | null,
    branch: [] as Array<Record<string, unknown>>,
    sessionFile: "/child/session/scout.jsonl" as string | undefined,
    sessionId: "parent-session",
    trusted: true,
    cwd: "/repo",
    shutdowns: 0,
  };
  const ctx = {
    get cwd() {
      return state.cwd;
    },
    shutdown: () => {
      state.shutdowns++;
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pendingMessages,
    isProjectTrusted: () => state.trusted,
    sessionManager: {
      getLeafId: () => state.leafId,
      getBranch: () => state.branch,
      getSessionFile: () => state.sessionFile,
      getSessionId: () => state.sessionId,
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () =>
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
    },
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
        return () =>
          busHandlers.set(
            channel,
            (busHandlers.get(channel) ?? []).filter((h) => h !== handler),
          );
      },
    },
  } as unknown as ExtensionAPI;

  /** Deliver one extension event to every handler, returning their results. */
  async function emit(type: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of handlers.get(type) ?? [])
      results.push(await handler({ type, ...event }, ctx));
    return results;
  }

  /** Append an entry to the active branch and move the leaf to it. */
  function append(entry: Record<string, unknown>): void {
    state.branch.push(entry);
    state.leafId = entry.id as string;
  }

  return { pi, ctx, state, sent, tools, flags, emit, append };
}

export function userEntry(id: string, text: string): Record<string, unknown> {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

export function assistantEntry(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  };
}

export interface FakeSession {
  name: string;
  cwd: string;
  env: Record<string, string>;
  command: string[];
}

/**
 * A scripted private tmux server. It models sessions by name, the commands
 * the backend uses, and tmux's duplicate-session refusal. `onNewSession`
 * stands in for the child Pi process starting.
 */
export function createFakeTmux(
  options: { onNewSession?: (session: FakeSession) => void; newSessionError?: string } = {},
) {
  const sessions = new Map<string, FakeSession>();
  /** Raw `#{session_attached}` output per session name; "0" when unset. */
  const attached = new Map<string, string>();
  const calls: string[][] = [];
  let launches = 0;

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr: `${stderr}\n` });

  function targetName(args: readonly string[]): string {
    const target = args[args.indexOf("-t") + 1] ?? "";
    return target.replace(/^=/, "").replace(/:$/, "");
  }

  function run(args: readonly string[]) {
    const rest = args[0] === "-f" ? args.slice(2) : args;
    switch (rest[0]) {
      case "-V":
        return ok("tmux 3.8\n");
      case "has-session":
        return sessions.has(targetName(rest))
          ? ok()
          : fail(`can't find session: ${targetName(rest)}`);
      case "show-environment": {
        const session = sessions.get(targetName(rest));
        if (!session) return fail(`no such session: =${targetName(rest)}`);
        const name = rest.at(-1) ?? "";
        return name in session.env
          ? ok(`${name}=${session.env[name]}\n`)
          : fail(`unknown variable: ${name}`);
      }
      case "display-message": {
        // tmux prints an empty line for a missing session, with exit 0.
        if (rest.at(-1) !== "#{session_attached}") return fail("unscripted format");
        const name = targetName(rest);
        return ok(`${sessions.has(name) ? (attached.get(name) ?? "0") : ""}\n`);
      }
      case "new-session": {
        if (options.newSessionError) return fail(options.newSessionError);
        const name = rest[rest.indexOf("-s") + 1];
        if (sessions.has(name)) return fail(`duplicate session: ${name}`);
        const env: Record<string, string> = {};
        const separator = rest.indexOf("--");
        rest.slice(0, separator).forEach((arg, index, all) => {
          if (arg !== "-e") return;
          const pair = all[index + 1];
          env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
        });
        const session = {
          name,
          cwd: rest[rest.indexOf("-c") + 1],
          env,
          command: rest.slice(separator + 1),
        };
        sessions.set(name, session);
        launches++;
        options.onNewSession?.(session);
        return ok();
      }
      default:
        return fail(`unscripted tmux command: ${rest.join(" ")}`);
    }
  }

  const exec: TmuxExec = async (args) => {
    calls.push([...args]);
    // Resolve on a later tick so concurrent callers interleave as with a real process.
    await Promise.resolve();
    return run(args);
  };

  return {
    exec,
    calls,
    sessions,
    get launches() {
      return launches;
    },
    kill(childId: string) {
      sessions.delete(`sa-${childId}`);
    },
    /** Set what `#{session_attached}` prints for a child's session. */
    setAttached(childId: string, output: string) {
      attached.set(`sa-${childId}`, output);
    },
  };
}
