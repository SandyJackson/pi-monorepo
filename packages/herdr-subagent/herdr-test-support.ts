import { expect } from "vitest";
import { type HerdrRpcCall, HerdrRpcResponseError } from "./herdr/rpc.js";

export interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
}

export type RpcResponse =
  | { result: unknown }
  | { error: { code?: string | number; message: string } }
  | { closeWithoutResponse: true }
  | { leavePending: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createScriptedRpc(
  respondToRequest: (request: RpcRequest) => RpcResponse,
  calledMethods: string[],
): HerdrRpcCall {
  return (method, params, timeoutMs, signal) => {
    const request: RpcRequest = {
      method,
      params: isRecord(params) ? params : {},
    };
    calledMethods.push(method);

    if (signal?.aborted) return Promise.reject(new Error(`herdr rpc aborted (${method})`));

    let response: RpcResponse;
    try {
      response = respondToRequest(request);
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    if ("result" in response) return Promise.resolve(response.result);
    if ("error" in response) {
      return Promise.reject(new HerdrRpcResponseError(response.error.message, response.error.code));
    }
    if ("closeWithoutResponse" in response) {
      return Promise.reject(new Error("herdr socket closed without response"));
    }

    return new Promise((_resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};

      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        complete();
      };

      onAbort = () => settle(() => reject(new Error(`herdr rpc aborted (${method})`)));
      timer = setTimeout(() => {
        settle(() => reject(new Error(`herdr rpc timeout after ${timeoutMs}ms (${method})`)));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
}

export function createScriptedHerdr(respondToRequest: (request: RpcRequest) => RpcResponse): {
  calledMethods: string[];
  rpcCall: HerdrRpcCall;
} {
  const calledMethods: string[] = [];
  return {
    calledMethods,
    rpcCall: createScriptedRpc(respondToRequest, calledMethods),
  };
}

export function standardLaunchResponse(request: RpcRequest): RpcResponse | undefined {
  switch (request.method) {
    case "tab.list":
      return { result: { tabs: [{ tab_id: "subagent-tab", label: "subagents" }] } };
    case "pane.list":
      return { result: { panes: [{ pane_id: "target-pane", tab_id: "subagent-tab" }] } };
    case "pane.split":
      return { result: { type: "pane_info", pane: { pane_id: "launch-pane" } } };
    case "agent.list":
      return { result: { agents: [] } };
    default:
      return undefined;
  }
}

export async function waitForRpcCount(
  herdr: { calledMethods: string[] },
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && herdr.calledMethods.length < count; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(herdr.calledMethods.length).toBeGreaterThanOrEqual(count);
}
