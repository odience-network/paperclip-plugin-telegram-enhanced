import { describe, it, expect, vi } from "vitest";
import {
  resolveTelegramOpsDestination,
  resolveOpsDestinationForEvent,
} from "../src/worker.js";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

// Ported from ant013/paperclip-plugin-telegram (TEL-23, commits 8314854 / c0423e4),
// adapted to this base's self-contained ops-only routing. The file_route cases from
// the upstream test are intentionally omitted — that feature ships under a separate
// ticket — so these focus on ops-route resolution, which is what ODIAA-695 integrates.

const GIMLE_COMPANY_ID = "9d8f432c-ff7d-4e3a-bbe3-3cd355f73b64";
const TEL_COMPANY_ID = "8810f36f-c9f1-4920-b9a1-d5f7a1db9484";
const OTHER_COMPANY_ID = "8f55e80b-0264-4ab6-9d56-8b2652f18005";

const OPS_ROUTES = [
  { name: "Gimle Ops", companyId: GIMLE_COMPANY_ID, companyName: "Gimle", chatId: "-1003521772993", enabled: true },
  { name: "TG Ops", companyId: TEL_COMPANY_ID, companyName: "TelegramUpdate", chatId: "-1003978140493", enabled: true },
];

function mockCtx(opts: { companyName?: string | null; companiesGetThrows?: boolean } = {}): PluginContext {
  const get = opts.companiesGetThrows
    ? vi.fn().mockRejectedValue(new Error("lookup failed"))
    : vi.fn().mockResolvedValue(opts.companyName ? { name: opts.companyName } : null);
  return {
    companies: { get },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function makeEvent(opts: { companyId?: string; eventType?: string } = {}): PluginEvent {
  return {
    companyId: opts.companyId ?? GIMLE_COMPANY_ID,
    eventType: opts.eventType ?? "agent.run.started",
    entityType: "agent",
    entityId: "agent-uuid-1",
    payload: {},
  } as PluginEvent;
}

describe("resolveTelegramOpsDestination", () => {
  it("matches by companyId UUID", () => {
    const dest = resolveTelegramOpsDestination(OPS_ROUTES, GIMLE_COMPANY_ID);
    expect(dest).toEqual({ chatId: "-1003521772993", topicId: undefined, routeName: "Gimle Ops" });
  });

  it("matches a different company to its own route", () => {
    const dest = resolveTelegramOpsDestination(OPS_ROUTES, TEL_COMPANY_ID);
    expect(dest?.chatId).toBe("-1003978140493");
    expect(dest?.routeName).toBe("TG Ops");
  });

  it("returns null when no route matches the company", () => {
    expect(resolveTelegramOpsDestination(OPS_ROUTES, OTHER_COMPANY_ID)).toBeNull();
  });

  it("falls back to companyName match (case-insensitive) when companyId is absent on the route", () => {
    const routes = [{ name: "By name", companyName: "TelegramUpdate", chatId: "-100777", enabled: true }];
    const dest = resolveTelegramOpsDestination(routes, TEL_COMPANY_ID, "telegramupdate");
    expect(dest?.chatId).toBe("-100777");
  });

  it("does not match by name when companyName is not provided", () => {
    const routes = [{ name: "By name", companyName: "Gimle", chatId: "-100777", enabled: true }];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)).toBeNull();
  });

  it("carries the topicId through when set", () => {
    const routes = [{ name: "WithTopic", companyId: GIMLE_COMPANY_ID, chatId: "-100888", topicId: "42", enabled: true }];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)?.topicId).toBe("42");
  });

  it("skips disabled routes", () => {
    const routes = [{ name: "Off", companyId: GIMLE_COMPANY_ID, chatId: "-100999", enabled: false }];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)).toBeNull();
  });

  it("treats a route with no explicit enabled flag as enabled", () => {
    const routes = [{ name: "Legacy", companyId: GIMLE_COMPANY_ID, chatId: "-101000" }];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)?.chatId).toBe("-101000");
  });

  it("skips routes that are missing a chatId", () => {
    const routes = [{ name: "NoChat", companyId: GIMLE_COMPANY_ID, chatId: "", enabled: true }];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)).toBeNull();
  });

  it("returns the first matching enabled route (ignores later duplicates)", () => {
    const routes = [
      { name: "First", companyId: GIMLE_COMPANY_ID, chatId: "-100aaa", enabled: true },
      { name: "Second", companyId: GIMLE_COMPANY_ID, chatId: "-100bbb", enabled: true },
    ];
    expect(resolveTelegramOpsDestination(routes, GIMLE_COMPANY_ID)?.routeName).toBe("First");
  });

  it("returns null for malformed config (not an array)", () => {
    expect(resolveTelegramOpsDestination("garbage" as unknown, GIMLE_COMPANY_ID)).toBeNull();
    expect(resolveTelegramOpsDestination(undefined, GIMLE_COMPANY_ID)).toBeNull();
  });

  it("ignores non-object entries inside the array", () => {
    const routes = [null, "x", 1, { name: "Good", companyId: GIMLE_COMPANY_ID, chatId: "-100ccc", enabled: true }];
    expect(resolveTelegramOpsDestination(routes as unknown, GIMLE_COMPANY_ID)?.chatId).toBe("-100ccc");
  });
});

describe("resolveOpsDestinationForEvent", () => {
  it("resolves directly by companyId without a company lookup", async () => {
    const ctx = mockCtx();
    const dest = await resolveOpsDestinationForEvent(ctx, { opsRoutes: OPS_ROUTES }, makeEvent());
    expect(dest?.chatId).toBe("-1003521772993");
    expect(ctx.companies.get).not.toHaveBeenCalled();
  });

  it("falls back to a company lookup for companyName-only routes", async () => {
    const ctx = mockCtx({ companyName: "TelegramUpdate" });
    const routes = [{ name: "TG Ops", companyName: "TelegramUpdate", chatId: "-1003978140493", enabled: true }];
    const dest = await resolveOpsDestinationForEvent(
      ctx,
      { opsRoutes: routes },
      makeEvent({ companyId: TEL_COMPANY_ID, eventType: "agent.run.finished" }),
    );
    expect(dest?.chatId).toBe("-1003978140493");
    expect(ctx.companies.get).toHaveBeenCalledWith(TEL_COMPANY_ID);
  });

  it("returns null (and skips the lookup) when there are no ops routes", async () => {
    const ctx = mockCtx();
    expect(await resolveOpsDestinationForEvent(ctx, { opsRoutes: [] }, makeEvent())).toBeNull();
    expect(await resolveOpsDestinationForEvent(ctx, {}, makeEvent())).toBeNull();
    expect(ctx.companies.get).not.toHaveBeenCalled();
  });

  it("returns null when the company lookup throws", async () => {
    const ctx = mockCtx({ companiesGetThrows: true });
    const routes = [{ name: "TG Ops", companyName: "TelegramUpdate", chatId: "-1003978140493", enabled: true }];
    const dest = await resolveOpsDestinationForEvent(
      ctx,
      { opsRoutes: routes },
      makeEvent({ companyId: TEL_COMPANY_ID }),
    );
    expect(dest).toBeNull();
  });

  it("returns null when no route matches the event's company", async () => {
    const ctx = mockCtx({ companyName: "Unrelated" });
    const dest = await resolveOpsDestinationForEvent(
      ctx,
      { opsRoutes: OPS_ROUTES },
      makeEvent({ companyId: OTHER_COMPANY_ID }),
    );
    expect(dest).toBeNull();
  });
});
