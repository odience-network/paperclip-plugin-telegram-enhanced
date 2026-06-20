import { describe, expect, it } from "vitest";
import { evaluateInternalUrlGuidance } from "../src/internal-url-guidance.js";

describe("evaluateInternalUrlGuidance", () => {
  describe("internal / loopback base URLs are accepted (no warning)", () => {
    const internal = [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "http://0.0.0.0:3100",
      "http://[::1]:3100",
      "http://10.0.0.5:3100",
      "http://192.168.1.20:3100",
      "http://172.16.0.10:3100",
      "http://172.31.255.255:3100",
      "http://169.254.10.1:3100",
      "http://[fd00::1]:3100",
      "http://paperclip:3100", // single-label docker-compose service host
      "http://paperclip.internal:3100",
      "http://paperclip.local:3100",
      "https://api.paperclip.localhost",
    ];
    for (const base of internal) {
      it(`returns null for ${base}`, () => {
        expect(evaluateInternalUrlGuidance(base, "https://paperclip.example.com")).toBeNull();
      });
    }

    it("excludes the public range 172.32.x from the private 172.16-31 block", () => {
      // 172.32.0.1 is public; should warn, proving the regex boundary is correct.
      expect(evaluateInternalUrlGuidance("https://172.32.0.1", "")).not.toBeNull();
    });
  });

  describe("public base URLs trigger a warning", () => {
    it("warns when the base URL is a public hostname and public URL is empty", () => {
      const result = evaluateInternalUrlGuidance("https://paperclip.example.com", "");
      expect(result?.level).toBe("warn");
      expect(result?.message).toContain("paperclip.example.com");
      expect(result?.message).toContain("internal/loopback");
    });

    it("calls out the match when base URL equals the public URL", () => {
      const result = evaluateInternalUrlGuidance(
        "https://paperclip.example.com",
        "https://paperclip.example.com",
      );
      expect(result?.level).toBe("warn");
      expect(result?.message).toContain("matches your public URL");
    });

    it("still warns when base URL is a different public host than the public URL", () => {
      const result = evaluateInternalUrlGuidance(
        "https://api.example.com",
        "https://links.example.com",
      );
      expect(result?.level).toBe("warn");
      expect(result?.message).toContain("public hostname");
    });

    it("warns for a bare public hostname without a scheme", () => {
      const result = evaluateInternalUrlGuidance("paperclip.example.com", "");
      expect(result?.level).toBe("warn");
      expect(result?.message).toContain("paperclip.example.com");
    });

    it("includes the port in the reported host", () => {
      const result = evaluateInternalUrlGuidance("https://paperclip.example.com:8443", "");
      expect(result?.message).toContain("paperclip.example.com:8443");
    });
  });

  describe("empty / unparseable input is ignored (no warning)", () => {
    for (const value of ["", "   ", "not a url", null, undefined, 42, {}]) {
      it(`returns null for ${JSON.stringify(value)}`, () => {
        expect(evaluateInternalUrlGuidance(value, "")).toBeNull();
      });
    }
  });
});
