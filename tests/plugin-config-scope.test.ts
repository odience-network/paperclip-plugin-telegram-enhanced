import { describe, expect, it } from "vitest";
import {
  COMPANY_SCOPE_REQUIRED_MESSAGE,
  buildPluginConfigPath,
  buildPluginConfigSaveBody,
  normalizeCompanyId,
  requireCompanyId,
} from "../src/plugin-config-scope.js";

const PLUGIN_ID = "paperclip-plugin-telegram-enhanced";
const COMPANY_ID = "a00e8c2a-f642-4ac9-beca-61e6a9ffff84";

describe("normalizeCompanyId", () => {
  it("returns the trimmed id for a real value", () => {
    expect(normalizeCompanyId(`  ${COMPANY_ID}  `)).toBe(COMPANY_ID);
  });

  const blanks = ["", "   ", "\t\n"];
  for (const blank of blanks) {
    it(`returns null for the blank string ${JSON.stringify(blank)}`, () => {
      expect(normalizeCompanyId(blank)).toBeNull();
    });
  }

  const nonStrings = [null, undefined, 0, 42, true, {}, []];
  for (const value of nonStrings) {
    it(`returns null for the non-string ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(normalizeCompanyId(value)).toBeNull();
    });
  }
});

describe("requireCompanyId", () => {
  it("returns the trimmed id when present", () => {
    expect(requireCompanyId(` ${COMPANY_ID} `)).toBe(COMPANY_ID);
  });

  // The whole point of ODIAA-1379: fail locally with operator-facing guidance
  // instead of round-tripping to the host for its raw 400.
  for (const missing of [null, undefined, "", "   "]) {
    it(`throws the operator-facing message for ${JSON.stringify(missing) ?? String(missing)}`, () => {
      expect(() => requireCompanyId(missing)).toThrow(COMPANY_SCOPE_REQUIRED_MESSAGE);
    });
  }

  it("does not leak the host's raw field-validation wording", () => {
    expect(COMPANY_SCOPE_REQUIRED_MESSAGE).not.toContain("companyId");
  });
});

describe("buildPluginConfigPath", () => {
  it("appends the company scope the host now requires", () => {
    expect(buildPluginConfigPath(PLUGIN_ID, COMPANY_ID)).toBe(
      `/api/plugins/${PLUGIN_ID}/config?companyId=${COMPANY_ID}`,
    );
  });

  it("trims the company id before building the query", () => {
    expect(buildPluginConfigPath(PLUGIN_ID, `  ${COMPANY_ID}  `)).toBe(
      `/api/plugins/${PLUGIN_ID}/config?companyId=${COMPANY_ID}`,
    );
  });

  it("encodes both the plugin id and the company id", () => {
    expect(buildPluginConfigPath("plug in//id", "co mp&any")).toBe(
      "/api/plugins/plug%20in%2F%2Fid/config?companyId=co%20mp%26any",
    );
  });

  it("throws instead of emitting an unscoped URL when the company is missing", () => {
    expect(() => buildPluginConfigPath(PLUGIN_ID, null)).toThrow(COMPANY_SCOPE_REQUIRED_MESSAGE);
    expect(() => buildPluginConfigPath(PLUGIN_ID, "")).toThrow(COMPANY_SCOPE_REQUIRED_MESSAGE);
  });
});

describe("buildPluginConfigSaveBody", () => {
  it("carries companyId in the body, which is where the host reads it on writes", () => {
    expect(buildPluginConfigSaveBody(COMPANY_ID, { defaultChatId: "-100123" })).toEqual({
      companyId: COMPANY_ID,
      configJson: { defaultChatId: "-100123" },
    });
  });

  it("trims the company id", () => {
    expect(buildPluginConfigSaveBody(` ${COMPANY_ID} `, {}).companyId).toBe(COMPANY_ID);
  });

  it("passes the config payload through untouched", () => {
    const configJson = { a: 1, nested: { b: [1, 2] } };
    expect(buildPluginConfigSaveBody(COMPANY_ID, configJson).configJson).toBe(configJson);
  });

  it("throws instead of posting an unscoped save when the company is missing", () => {
    expect(() => buildPluginConfigSaveBody(undefined, {})).toThrow(COMPANY_SCOPE_REQUIRED_MESSAGE);
    expect(() => buildPluginConfigSaveBody("  ", {})).toThrow(COMPANY_SCOPE_REQUIRED_MESSAGE);
  });
});
