import { describe, expect, it } from "vitest";
import {
  COMPANY_DIRECTORY_STATE_KEY,
  formatCompanyChoices,
  listCompaniesResilient,
  rememberCompanies,
  resolveCompanyInput,
} from "../src/company-directory.js";

/**
 * ODIAA-1927 — /connect must work from the polling loop, where the host refuses
 * the wildcard `companies.list` call ("not allowed to perform companies.list:
 * the worker referenced a missing, expired, or unknown invocation scope").
 */

type StateKey = { scopeKind: string; stateKey: string };

const SCOPE_ERROR = new Error(
  'Plugin "500d5962" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope',
);

function makeCtx(options: {
  list?: () => Promise<Array<{ id: string; name?: string }>>;
  get?: (id: string) => Promise<{ id: string; name?: string } | null>;
  state?: Record<string, unknown>;
}) {
  const stateStore = options.state ?? {};
  const ctx = {
    state: {
      async get(key: StateKey) {
        return stateStore[key.stateKey] ?? null;
      },
      async set(key: StateKey, value: unknown) {
        stateStore[key.stateKey] = value;
      },
    },
    companies: {
      list: options.list ?? (async () => { throw SCOPE_ERROR; }),
      get: options.get ?? (async () => null),
    },
  };
  return { ctx: ctx as never, stateStore };
}

describe("company directory", () => {
  it("caches the live listing so a later proactive call can still answer", async () => {
    const { ctx, stateStore } = makeCtx({
      list: async () => [{ id: "co-1", name: "Odience" }, { id: "co-2", name: "Acme" }],
    });

    const live = await listCompaniesResilient(ctx);
    expect(live.source).toBe("live");
    expect(live.companies).toEqual([{ id: "co-1", name: "Odience" }, { id: "co-2", name: "Acme" }]);
    expect(stateStore[COMPANY_DIRECTORY_STATE_KEY]).toEqual(live.companies);
  });

  it("falls back to the cache when the host refuses the wildcard call", async () => {
    const { ctx } = makeCtx({
      state: { [COMPANY_DIRECTORY_STATE_KEY]: [{ id: "co-1", name: "Odience" }] },
    });

    const lookup = await listCompaniesResilient(ctx);
    expect(lookup.source).toBe("cache");
    expect(lookup.companies).toEqual([{ id: "co-1", name: "Odience" }]);
    expect(lookup.error).toContain("invocation scope");
  });

  it("resolves a cached company by name, case-insensitively, with no list call", async () => {
    const { ctx } = makeCtx({
      state: { [COMPANY_DIRECTORY_STATE_KEY]: [{ id: "co-1", name: "Odience" }] },
    });

    const resolution = await resolveCompanyInput(ctx, "odience");
    expect(resolution.match).toEqual({ id: "co-1", name: "Odience" });
    expect(resolution.source).toBe("cache");
  });

  it("connects by bare UUID via companies.get when the directory is empty", async () => {
    // The single-company call is the one the proactive gate does admit, so a
    // UUID always gives an operator a way out of an unlinked chat.
    const id = "a00e8c2a-f642-4ac9-beca-61e6a9ffff84";
    const { ctx, stateStore } = makeCtx({
      get: async (requested) => (requested === id ? { id, name: "Odience" } : null),
    });

    const resolution = await resolveCompanyInput(ctx, id);
    expect(resolution.match).toEqual({ id, name: "Odience" });
    // …and the company is remembered for the next lookup.
    expect(stateStore[COMPANY_DIRECTORY_STATE_KEY]).toEqual([{ id, name: "Odience" }]);
  });

  it("reports no match for an unknown name instead of throwing", async () => {
    const { ctx } = makeCtx({
      state: { [COMPANY_DIRECTORY_STATE_KEY]: [{ id: "co-1", name: "Odience" }] },
    });

    const resolution = await resolveCompanyInput(ctx, "nope");
    expect(resolution.match).toBeUndefined();
    expect(formatCompanyChoices(resolution.known)).toBe("Odience");
  });

  it("merges remembered companies by id, newest name winning", async () => {
    const { ctx } = makeCtx({ state: {} });

    await rememberCompanies(ctx, [{ id: "co-1" }]);
    const merged = await rememberCompanies(ctx, [{ id: "co-1", name: "Odience" }, { id: "co-2" }]);

    expect(merged).toEqual([{ id: "co-1", name: "Odience" }, { id: "co-2" }]);
  });

  it("survives an unreadable state store", async () => {
    const ctx = {
      state: {
        async get() { throw new Error("state down"); },
        async set() { throw new Error("state down"); },
      },
      companies: { list: async () => { throw SCOPE_ERROR; }, get: async () => null },
    } as never;

    const lookup = await listCompaniesResilient(ctx);
    expect(lookup).toMatchObject({ companies: [], source: "cache" });
    // The write fails, but the caller still gets a usable view for this call.
    await expect(rememberCompanies(ctx, [{ id: "co-1" }])).resolves.toEqual([{ id: "co-1" }]);
  });
});
