import { describe, expect, it, vi, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  PaperclipApiError,
  buildPaperclipAuthHeaders,
  fetchPaperclipApi,
  isAlreadyResolvedConflict,
} from "../src/paperclip-api.js";

function mockCtx() {
  return {
    http: {
      fetch: vi.fn(async () => new Response("{}")),
    },
  } as unknown as PluginContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPaperclipApi", () => {
  it("uses native fetch for loopback Paperclip URLs", async () => {
    const ctx = mockCtx();
    const nativeFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", nativeFetch);

    await fetchPaperclipApi(ctx, "http://127.0.0.1:3101/api/approvals/apr-1/approve", {
      method: "POST",
    });

    expect(nativeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3101/api/approvals/apr-1/approve",
      { method: "POST" },
    );
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("keeps using host fetch for non-loopback URLs", async () => {
    const ctx = mockCtx();
    const nativeFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", nativeFetch);

    await fetchPaperclipApi(ctx, "https://paperclip.example.com/api/approvals/apr-1/approve", {
      method: "POST",
    });

    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://paperclip.example.com/api/approvals/apr-1/approve",
      { method: "POST" },
    );
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("throws a PaperclipApiError carrying status and detail on a non-2xx response", async () => {
    const ctx = mockCtx();
    const nativeFetch = vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
    }));
    vi.stubGlobal("fetch", nativeFetch);

    const promise = fetchPaperclipApi(ctx, "http://127.0.0.1:3101/api/approvals/apr-1/approve", {
      method: "POST",
    });

    // Message stays backward compatible with the prior generic Error.
    await expect(promise).rejects.toThrow("Paperclip API request failed with 403");
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(PaperclipApiError);
    expect(err.status).toBe(403);
    expect(err.detail).toContain("Forbidden");
  });
});

describe("isAlreadyResolvedConflict (TWX-328)", () => {
  it("classifies an already-resolved interaction 409 conflict", () => {
    const err = new PaperclipApiError(
      409,
      JSON.stringify({ error: "Interaction has already been resolved" }),
    );
    expect(isAlreadyResolvedConflict(err)).toBe(true);
  });

  it("classifies an already-decided approval 422 conflict", () => {
    const err = new PaperclipApiError(
      422,
      JSON.stringify({ error: "Only pending or revision requested approvals can be approved" }),
    );
    expect(isAlreadyResolvedConflict(err)).toBe(true);
  });

  it("does not classify unrelated conflicts as already resolved", () => {
    const err = new PaperclipApiError(
      409,
      JSON.stringify({
        error: "Cannot approve: the issue's most recent run has not completed workspace_finalize.",
      }),
    );
    expect(isAlreadyResolvedConflict(err)).toBe(false);
  });

  it("does not classify non-conflict statuses", () => {
    const err = new PaperclipApiError(500, "Only pending approvals can be approved");
    expect(isAlreadyResolvedConflict(err)).toBe(false);
  });

  it("is safe on non-error inputs", () => {
    expect(isAlreadyResolvedConflict(null)).toBe(false);
    expect(isAlreadyResolvedConflict("boom")).toBe(false);
    expect(isAlreadyResolvedConflict(new Error("plain"))).toBe(false);
  });
});

describe("buildPaperclipAuthHeaders", () => {
  it("builds authorization headers when a board API token is configured", () => {
    expect(buildPaperclipAuthHeaders("pcp_board_token")).toEqual({
      Authorization: "Bearer pcp_board_token",
    });
    expect(buildPaperclipAuthHeaders()).toEqual({});
  });

  it("attaches Cloudflare Access service-token headers when both halves are set (ODIAA-742)", () => {
    expect(
      buildPaperclipAuthHeaders("pcp_board_token", {
        clientId: "cf-id.access",
        clientSecret: "cf-secret",
      }),
    ).toEqual({
      Authorization: "Bearer pcp_board_token",
      "CF-Access-Client-Id": "cf-id.access",
      "CF-Access-Client-Secret": "cf-secret",
    });
  });

  it("omits Cloudflare Access headers when no CF-Access pair is provided", () => {
    expect(buildPaperclipAuthHeaders("pcp_board_token")).not.toHaveProperty(
      "CF-Access-Client-Id",
    );
    expect(buildPaperclipAuthHeaders("pcp_board_token")).not.toHaveProperty(
      "CF-Access-Client-Secret",
    );
  });

  it("attaches Cloudflare Access headers even without a board token", () => {
    expect(
      buildPaperclipAuthHeaders(undefined, {
        clientId: "cf-id.access",
        clientSecret: "cf-secret",
      }),
    ).toEqual({
      "CF-Access-Client-Id": "cf-id.access",
      "CF-Access-Client-Secret": "cf-secret",
    });
  });

  it("ignores a half-configured Cloudflare Access pair", () => {
    expect(
      buildPaperclipAuthHeaders("pcp_board_token", {
        clientId: "cf-id.access",
        clientSecret: "",
      }),
    ).toEqual({ Authorization: "Bearer pcp_board_token" });
    expect(
      buildPaperclipAuthHeaders("pcp_board_token", {
        clientId: "",
        clientSecret: "cf-secret",
      }),
    ).toEqual({ Authorization: "Bearer pcp_board_token" });
  });
});
