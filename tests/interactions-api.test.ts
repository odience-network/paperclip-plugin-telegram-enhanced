import { describe, it, expect, vi } from "vitest";
import {
  fetchInteraction,
  respondInteraction,
  isAlreadyResolvedInteractionError,
  PaperclipApiError,
  type HttpClientLike,
} from "../src/interactions-api.js";

function mockHttp(
  status: number,
  body: unknown,
): HttpClientLike {
  return {
    fetch: vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    })),
  };
}

const ARGS = {
  baseUrl: "https://board.example.com",
  issueId: "iss-1",
  interactionId: "ia-1",
  boardApiToken: "tok-abc",
};

describe("fetchInteraction", () => {
  it("returns the matching interaction from the list", async () => {
    const http = mockHttp(200, [
      { id: "ia-0", kind: "request_confirmation" },
      { id: "ia-1", kind: "request_confirmation", payload: { prompt: "OK?" } },
    ]);
    const result = await fetchInteraction(http, ARGS);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("ia-1");
  });

  it("returns null when the interaction is not in the list", async () => {
    const http = mockHttp(200, [{ id: "other-ia", kind: "request_confirmation" }]);
    const result = await fetchInteraction(http, ARGS);
    expect(result).toBeNull();
  });

  it("returns null when body is not an array", async () => {
    const http = mockHttp(200, { id: "ia-1" });
    const result = await fetchInteraction(http, ARGS);
    expect(result).toBeNull();
  });

  it("throws PaperclipApiError on non-ok response", async () => {
    const http = mockHttp(500, "internal error");
    await expect(fetchInteraction(http, ARGS)).rejects.toThrow(PaperclipApiError);
  });

  it("throws when board token is missing", async () => {
    const http = mockHttp(200, []);
    await expect(fetchInteraction(http, { ...ARGS, boardApiToken: "" })).rejects.toThrow(
      "Board API token missing",
    );
  });
});

describe("respondInteraction", () => {
  it("POSTs accept action with correct URL", async () => {
    const http = mockHttp(200, null);
    await respondInteraction(http, { ...ARGS, action: "accept" });
    expect(http.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/interactions/ia-1/accept"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POSTs reject action with reason in body", async () => {
    const http = mockHttp(200, null);
    await respondInteraction(http, { ...ARGS, action: "reject", reason: "not approved" });
    const call = (http.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.reason).toBe("not approved");
  });

  it("POSTs respond action with answers", async () => {
    const http = mockHttp(200, null);
    const answers = [{ questionId: "q1", optionIds: ["opt1"] }];
    await respondInteraction(http, { ...ARGS, action: "respond", answers });
    const call = (http.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.answers).toEqual(answers);
  });

  it("throws PaperclipApiError on failure", async () => {
    const http = mockHttp(409, "interaction has already been resolved");
    await expect(respondInteraction(http, { ...ARGS, action: "accept" })).rejects.toThrow(PaperclipApiError);
  });
});

describe("isAlreadyResolvedInteractionError", () => {
  it("returns true for 409 with 'already resolved' detail", () => {
    const err = new PaperclipApiError("Interaction accept failed", 409, "interaction has already been resolved");
    expect(isAlreadyResolvedInteractionError(err)).toBe(true);
  });

  it("returns false for 409 with different detail", () => {
    const err = new PaperclipApiError("Failed", 409, "some other conflict");
    expect(isAlreadyResolvedInteractionError(err)).toBe(false);
  });

  it("returns false for non-409 status", () => {
    const err = new PaperclipApiError("Failed", 500, "interaction has already been resolved");
    expect(isAlreadyResolvedInteractionError(err)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isAlreadyResolvedInteractionError(null)).toBe(false);
    expect(isAlreadyResolvedInteractionError("string error")).toBe(false);
    expect(isAlreadyResolvedInteractionError(undefined)).toBe(false);
  });
});
