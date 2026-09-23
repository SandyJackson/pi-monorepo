import { describe, expect, it } from "vitest";
import { herdrDelegationEnvironment, resolveTabLabel } from "./delegation.ts";
import { DEFAULT_RPC_TIMEOUT } from "./session.ts";

const liveHerdrAvailable =
  process.env.HERDR_ENV === "1" &&
  !!process.env.HERDR_SOCKET_PATH &&
  !!process.env.HERDR_WORKSPACE_ID;

interface TabCreateResult {
  tab?: { tab_id?: string };
  root_pane?: { pane_id?: string };
}

async function createLiveTab(label: string | undefined): Promise<TabCreateResult> {
  const { rpc, workspaceId } = herdrDelegationEnvironment();
  const resolved = resolveTabLabel(label);
  const result = (await rpc(
    "tab.create",
    { workspace_id: workspaceId, cwd: process.cwd(), label: resolved, focus: false },
    DEFAULT_RPC_TIMEOUT,
  )) as TabCreateResult;
  return result;
}

// Live Herdr smoke test for per-delegation tab creation (issue #13).
// Skipped unless pi runs inside Herdr with complete workspace metadata.
// The focus assertion is manual: run with a visible Herdr workspace and
// confirm the original pane stays focused while two new tabs appear.
// Created tabs are left open for inspection, matching current tab-sprawl
// acceptance; close them by hand afterwards.
describe.skipIf(!liveHerdrAvailable)("herdr/delegation — live tab.create smoke", () => {
  it("creates an unfocused tab with the sub-agents fallback label", async () => {
    expect(resolveTabLabel(undefined)).toBe("sub-agents");
    expect(resolveTabLabel("   ")).toBe("sub-agents");

    const result = await createLiveTab(undefined);
    expect(typeof result.tab?.tab_id).toBe("string");
    expect(typeof result.root_pane?.pane_id).toBe("string");
    console.log(`smoke tab (fallback): ${result.tab?.tab_id} label=sub-agents`);
  });

  it("creates an unfocused tab with a custom label", async () => {
    const custom = `smoke-${process.pid}`;
    expect(resolveTabLabel(custom)).toBe(custom);

    const result = await createLiveTab(custom);
    expect(typeof result.tab?.tab_id).toBe("string");
    expect(typeof result.root_pane?.pane_id).toBe("string");
    console.log(`smoke tab (custom): ${result.tab?.tab_id} label=${custom}`);
  });
});
