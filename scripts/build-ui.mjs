// Bundle the plugin settings UI into dist/ui/index.js.
//
// The Paperclip host loads `entrypoints.ui` as same-origin browser ESM and only
// serves files from the `dist/ui/` directory. A plain `tsc` build leaves
// cross-directory imports (e.g. `../constants.js`) and bare specifiers that the
// browser cannot resolve, so the settings page fails to load. We bundle with
// esbuild using the SDK's preset, which externalizes the host-provided runtime
// (react / react-dom / jsx-runtime / @paperclipai/plugin-sdk/ui) and inlines
// everything else into a single self-contained module.
import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
if (!presets.esbuild.ui) {
  throw new Error("UI bundler preset missing — check uiEntry");
}

await build({
  ...presets.esbuild.ui,
  // tsc emits declaration (.d.ts) types; esbuild owns the runtime bundle.
  logLevel: "info",
});

console.log("✓ UI bundled to dist/ui/index.js");
