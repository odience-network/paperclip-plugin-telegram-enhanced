import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_RPC_ERROR_CODES, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { BOT_CONNECTION_SCOPE } from "../src/worker.js";

// ODIAA-2648 — the poll loop must not inherit setup()'s invocation.
//
// The SDK's worker RPC host tags every worker→host call with the invocation id
// held in its AsyncLocalStorage, and that store follows promise continuations
// and timers. setup() starts the long-lived poll loop, so a bare `pollUpdates()`
// would carry setup()'s invocation id for the life of the worker. Once the host
// retires that invocation, every company-scoped call the loop makes is refused
// as INVOCATION_SCOPE_DENIED. createTestHarness never runs the real transport,
// so this drives the plugin through startWorkerRpcHost with a small fake host
// that rejects stale invocation ids the way the real one does.
//
// Modelled on mvanhorn tests/worker-invocation-lifetime.test.ts.

type Rpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  paperclipInvocationId?: string;
};

const SETUP_INVOCATION = { id: "setup-invocation", companyId: "company-a" };

describe("polling invocation lifetime", () => {
  it("keeps poll-loop calls untagged after setup()'s invocation retires", async () => {
    vi.resetModules();
    const { plugin } = await import("../src/worker.js");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const active = new Set<string>();
    const calls: Rpc[] = [];
    const denied: string[] = [];
    const polls: Rpc[] = [];
    const sent: Array<{ chat_id: string | number; text: string }> = [];
    const pending = new Map<string, (reply: Rpc) => void>();
    const stateKey = (p: any) => JSON.stringify([p.scopeKind, p.scopeId ?? null, p.namespace ?? null, p.stateKey]);
    const state = new Map<string, unknown>([
      [stateKey(BOT_CONNECTION_SCOPE), { botToken: "111:TEST", botUsername: "test_bot", botId: "111", updatedAt: null }],
      [stateKey({ scopeKind: "instance", stateKey: "chat_111" }), { companyId: "company-a", companyName: "Company A" }],
    ]);
    let sequence = 0;
    let buffer = "";

    const write = (message: unknown) => stdin.write(JSON.stringify(message) + "\n");
    const reply = (request: Rpc, result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
    const httpReply = (request: Rpc, result: unknown) =>
      reply(request, { status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) });

    const handle = (request: Rpc) => {
      if (!request.method) {
        pending.get(String(request.id))?.(request);
        return;
      }
      if (request.id === undefined) return;
      calls.push(request);
      const invocation = request.paperclipInvocationId;
      if (invocation && !active.has(invocation)) {
        denied.push(`${request.method}:${invocation}`);
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED, message: "missing, expired, or unknown invocation scope" },
        });
        return;
      }
      const p = request.params ?? {};
      switch (request.method) {
        case "state.get": reply(request, state.get(stateKey(p)) ?? null); break;
        case "state.set": state.set(stateKey(p), p.value); reply(request, null); break;
        case "companies.get": reply(request, { id: p.companyId, name: "Company A" }); break;
        case "agents.list": reply(request, [{ id: "agent-a", name: "Agent A", status: "running" }]); break;
        case "issues.list": reply(request, []); break;
        case "http.fetch": {
          if (p.url.includes("/getUpdates")) {
            polls.push(request);
            break;
          }
          if (p.url.endsWith("/sendMessage")) sent.push(JSON.parse(p.init.body));
          httpReply(request, p.url.endsWith("/sendMessage") ? { message_id: sent.length } : true);
          break;
        }
        default: reply(request, null);
      }
    };
    stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) handle(JSON.parse(line));
      }
    });

    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const call = (method: string, params: unknown, invocation?: { id: string; companyId: string }) => {
      const id = `host-${++sequence}`;
      if (invocation) active.add(invocation.id);
      return new Promise<Rpc>((resolve) => {
        pending.set(id, (result) => {
          pending.delete(id);
          // The host retires an invocation as soon as its request settles.
          if (invocation) active.delete(invocation.id);
          resolve(result);
        });
        write({ jsonrpc: "2.0", id, method, params, ...(invocation ? { paperclipInvocation: invocation } : {}) });
      });
    };

    try {
      // Run setup() inside an invocation, so the poll loop it starts is exposed
      // to that invocation's AsyncLocalStorage context.
      expect((await call("initialize", { manifest, config: {} }, SETUP_INVOCATION)).error).toBeUndefined();
      expect(active.has(SETUP_INVOCATION.id)).toBe(false);
      // setup()'s own registrations (events.subscribe) legitimately carry its
      // invocation; only what the poll loop does is under test.
      const afterSetup = calls.length;

      await vi.waitFor(() => expect(polls).toHaveLength(1));
      const firstPoll = polls.shift()!;
      httpReply(firstPoll, [{
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 111, type: "private" },
          from: { id: 123 },
          text: "/status",
          entities: [{ type: "bot_command", offset: 0, length: "/status".length }],
        },
      }]);
      // Without the detach the loop's next call is denied and it backs off, so
      // wait for either outcome and report the stale tags rather than a timeout.
      await vi.waitFor(() => expect(polls.length + denied.length).toBeGreaterThan(0));
      expect(denied).toEqual([]);
      await vi.waitFor(() => expect(polls).toHaveLength(1));

      const loopCalls = [firstPoll, ...calls.slice(afterSetup).filter((c) => c !== firstPoll)];
      expect(loopCalls.flatMap((c) => (c.paperclipInvocationId ? [`${c.method}:${c.paperclipInvocationId}`] : []))).toEqual([]);
      // The /status reply reached company A's data through company-scoped calls.
      expect(loopCalls.find((c) => c.method === "agents.list")?.params.companyId).toBe("company-a");
      expect(sent.some((m) => String(m.chat_id) === "111" && m.text.includes("Paperclip Status"))).toBe(true);
    } finally {
      await call("onEvent", { event: { eventType: "plugin.stopping" } });
      for (const poll of polls.splice(0)) httpReply(poll, []);
      // Let the stopped poll consume its final response before closing RPC.
      await new Promise<void>((resolve) => setImmediate(resolve));
      host.stop();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
