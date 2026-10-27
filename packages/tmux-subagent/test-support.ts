import type { TmuxExec } from "./tmux.ts";

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
  };
}
