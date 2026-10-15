import { command } from "./process.ts";

const MIN_PI_VERSION = [0, 99, 1] as const;

function parsePiVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: readonly number[], baseline: readonly number[]): boolean {
  for (let index = 0; index < baseline.length; index++) {
    if (version[index] > baseline[index]) return true;
    if (version[index] < baseline[index]) return false;
  }
  return true;
}

/** Preflight the installed Pi runtime before any worker launches. */
export async function assertSupportedPi(): Promise<void> {
  let output: string;
  try {
    output = await command("pi", ["--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
  } catch (error) {
    throw new Error(
      `Cannot run the installed Pi executable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = parsePiVersion(output);
  if (!version)
    throw new Error(
      `Cannot determine the installed Pi version from ${JSON.stringify(output.trim())}; Pi 0.99.1 or newer is required`,
    );
  if (!versionAtLeast(version, MIN_PI_VERSION))
    throw new Error(
      `Installed Pi ${version.join(".")} is older than the supported baseline 0.99.1; upgrade Pi and retry`,
    );
}
