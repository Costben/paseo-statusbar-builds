#!/usr/bin/env node
// Applies the Paseo edge-to-edge status bar fix to a freshly checked-out
// upstream tag (getpaseo/paseo). Port of tools/paseo-statusbar-fix.ps1's
// Patch-AppConfig + Patch-RootLayout.
//
// - Idempotent: re-running on an already-patched tree is a no-op.
// - Fails loudly: if upstream moved an injection anchor, exits non-zero and
//   names the exact anchor that went missing. A red CI run is the signal to
//   refresh this script (or confirm the patch is no longer needed).
//
// Usage: node apply-statusbar-patch.mjs [sourceDir]   (sourceDir default ".")

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sourceDir = process.argv[2] ?? ".";

function fail(message) {
  console.error(`[statusbar-patch] ERROR: ${message}`);
  process.exit(1);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function writeIfChanged(path, content, original, label) {
  if (content !== original) {
    writeFileSync(path, content, "utf8");
    console.log(`[statusbar-patch] patched ${label}`);
  } else {
    console.log(`[statusbar-patch] ${label} already patched`);
  }
}

function assertContains(path, needle, label) {
  if (!read(path).includes(needle)) {
    fail(`post-check failed: ${label} is missing expected marker: ${needle}`);
  }
}

function assertDependency(dir) {
  const path = join(dir, "packages", "app", "package.json");
  if (!existsSync(path)) fail(`missing package.json: ${path}`);
  if (!/"react-native-edge-to-edge"/.test(read(path))) {
    fail(
      "packages/app no longer depends on react-native-edge-to-edge; upstream changed. " +
        "Add the dependency or re-evaluate whether this patch is still needed.",
    );
  }
}

function patchAppConfig(dir) {
  const path = join(dir, "packages", "app", "app.config.js");
  if (!existsSync(path)) fail(`missing app config: ${path}`);

  let content = read(path);
  const original = content;
  const nl = detectNewline(content);

  // 1. require the edge-to-edge expo plugin helper
  if (!/react-native-edge-to-edge\/expo/.test(content)) {
    const needle = 'const pkg = require("./package.json");';
    if (!content.includes(needle)) {
      fail('app.config.js: cannot find anchor `const pkg = require("./package.json");`');
    }
    content = content.replace(
      needle,
      () => `${needle}${nl}const edgeToEdge = require("react-native-edge-to-edge/expo").default;`,
    );
  }

  // 2. inject edgeToEdge() as the first entry of the plugins array
  if (!/edgeToEdge\(\{/.test(content)) {
    const block = [
      "      edgeToEdge({",
      "        android: {",
      '          parentTheme: "Default",',
      "          enforceNavigationBarContrast: true,",
      "        },",
      "      }),",
    ].join(nl);
    const pluginsRe = /(plugins:\s*\[)[ \t]*\r?\n/;
    if (!pluginsRe.test(content)) {
      fail("app.config.js: cannot find anchor `plugins: [`");
    }
    content = content.replace(pluginsRe, (_m, g1) => `${g1}${nl}${block}${nl}`);
  }

  writeIfChanged(path, content, original, "packages/app/app.config.js");

  assertContains(path, "react-native-edge-to-edge/expo", "app.config.js");
  assertContains(path, "edgeToEdge({", "app.config.js");
}

function patchRootLayout(dir) {
  const path = join(dir, "packages", "app", "src", "app", "_layout.tsx");
  if (!existsSync(path)) fail(`missing root layout: ${path}`);

  let content = read(path);
  const original = content;
  const nl = detectNewline(content);

  // 1. import SystemBars
  if (!/react-native-edge-to-edge/.test(content)) {
    const needle = 'import { View } from "react-native";';
    if (!content.includes(needle)) {
      fail('_layout.tsx: cannot find anchor `import { View } from "react-native";`');
    }
    content = content.replace(
      needle,
      () => `${needle}${nl}import { SystemBars } from "react-native-edge-to-edge";`,
    );
  }

  // 2. render <SystemBars> as the first child of GestureHandlerRootView
  if (!/<SystemBars\s/.test(content)) {
    const gestureRe = /^([ \t]*)<GestureHandlerRootView\b[^>]*>[ \t]*\r?\n/m;
    const match = gestureRe.exec(content);
    if (!match) {
      fail("_layout.tsx: cannot find anchor `<GestureHandlerRootView ...>` opening tag");
    }
    const indent = match[1];
    const insertLine = `${indent}  <SystemBars style={theme.colorScheme === "light" ? "dark" : "light"} />`;
    content = content.replace(gestureRe, (m) => `${m.replace(/[\r\n]+$/, "")}${nl}${insertLine}${nl}`);
  }

  // 3. ensure RootLayout pulls `theme` from useUnistyles() (SystemBars needs it)
  const themeHookPresent =
    /export\s+default\s+function\s+RootLayout\s*\(\)\s*\{\s*\r?\n\s*const\s+\{\s*theme\s*\}\s*=\s*useUnistyles\(\);/.test(
      content,
    );
  if (/<SystemBars[^>]+theme\.colorScheme/.test(content) && !themeHookPresent) {
    const fnRe = /^(\s*export\s+default\s+function\s+RootLayout\s*\(\)\s*\{)[ \t]*\r?\n/m;
    if (!fnRe.test(content)) {
      fail("_layout.tsx: cannot find anchor `export default function RootLayout() {` for theme hook");
    }
    content = content.replace(fnRe, (_m, g1) => `${g1}${nl}  const { theme } = useUnistyles();${nl}`);
  }

  writeIfChanged(path, content, original, "packages/app/src/app/_layout.tsx");

  assertContains(path, 'import { SystemBars } from "react-native-edge-to-edge";', "_layout.tsx");
  assertContains(path, "<SystemBars", "_layout.tsx");
}

console.log(`[statusbar-patch] source dir: ${sourceDir}`);
assertDependency(sourceDir);
patchAppConfig(sourceDir);
patchRootLayout(sourceDir);
console.log("[statusbar-patch] done");
