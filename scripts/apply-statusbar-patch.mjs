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

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const patchDir = resolve(here, "..", "patches");
const badgePatch = join(patchDir, "paseo-app-composer-badges.patch");
const processGuardSrc = join(here, "android-process-guard");
const displayMetricsSrc = join(here, "android-display-metrics");

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
    const reactNativeImport = /^import\s*\{[^;]*?\}\s*from\s*"react-native";\r?$/m.exec(content);
    if (!reactNativeImport || !/\bView\b/.test(reactNativeImport[0])) {
      fail('_layout.tsx: cannot find a named `react-native` import containing `View`');
    }
    const importStatement = reactNativeImport[0].replace(/\r$/, "");
    content = content.replace(
      reactNativeImport[0],
      () => `${importStatement}${nl}import { SystemBars } from "react-native-edge-to-edge";`,
    );
  }

  // 2. render <SystemBars> as the first child of GestureHandlerRootView.
  // Use "auto" so the component follows the active color scheme without
  // needing a root-level useUnistyles() call before the app providers mount.
  if (/<SystemBars[^>]+theme\.colorScheme[^>]*\/>/.test(content)) {
    content = content.replace(
      /<SystemBars[^>]+theme\.colorScheme[^>]*\/>/,
      '<SystemBars style="auto" />',
    );
  } else if (!/<SystemBars\s/.test(content)) {
    const gestureRe = /^([ \t]*)<GestureHandlerRootView\b[^>]*>[ \t]*\r?\n/m;
    const match = gestureRe.exec(content);
    if (!match) {
      fail("_layout.tsx: cannot find anchor `<GestureHandlerRootView ...>` opening tag");
    }
    const indent = match[1];
    const insertLine = `${indent}  <SystemBars style="auto" />`;
    content = content.replace(gestureRe, (m) => `${m.replace(/[\r\n]+$/, "")}${nl}${insertLine}${nl}`);
  }

  // 3. remove the old patch's root-level theme hook if present.
  content = content.replace(
    /(\s*export\s+default\s+function\s+RootLayout\s*\(\)\s*\{\s*\r?\n)\s*const\s+\{\s*theme\s*\}\s*=\s*useUnistyles\(\);\s*\r?\n/,
    "$1",
  );

  writeIfChanged(path, content, original, "packages/app/src/app/_layout.tsx");

  assertContains(path, 'import { SystemBars } from "react-native-edge-to-edge";', "_layout.tsx");
  assertContains(path, '<SystemBars style="auto" />', "_layout.tsx");
  if (/<SystemBars[^>]+theme\.colorScheme/.test(read(path))) {
    fail("_layout.tsx: SystemBars still references root-level theme");
  }
}

function patchProcessGuard(dir) {
  const pluginDir = join(dir, "packages", "app", "plugins");
  const templateDir = join(pluginDir, "android-process-guard");
  if (!existsSync(pluginDir)) fail(`missing plugins dir: ${pluginDir}`);

  mkdirSync(templateDir, { recursive: true });
  for (const name of ["ProcessGuard.kt", "ProcessGuardProvider.kt"]) {
    copyFileSync(join(processGuardSrc, name), join(templateDir, name));
  }
  copyFileSync(
    join(processGuardSrc, "with-android-process-guard.js"),
    join(pluginDir, "with-android-process-guard.js"),
  );

  const path = join(dir, "packages", "app", "app.config.js");
  let content = read(path);
  const original = content;
  const nl = detectNewline(content);

  if (!/with-android-process-guard/.test(content)) {
    const needle = 'const withPasteInput = require("./plugins/with-paste-input");';
    if (!content.includes(needle)) {
      fail('app.config.js: cannot find anchor `const withPasteInput = require("./plugins/with-paste-input");`');
    }
    content = content.replace(
      needle,
      () =>
        `${needle}${nl}const withAndroidProcessGuard = require("./plugins/with-android-process-guard");`,
    );
  }

  if (!/withAndroidProcessGuard,/.test(content)) {
    const needle = /^([ \t]*)withPasteInput,[ \t]*\r?$/m;
    const match = needle.exec(content);
    if (!match) fail("app.config.js: cannot find anchor `withPasteInput,` inside the plugins array");
    content = content.replace(
      needle,
      (m) => `${m.replace(/\r$/, "")}${nl}${match[1]}withAndroidProcessGuard,`,
    );
  }

  writeIfChanged(path, content, original, "packages/app/app.config.js (process guard)");

  assertContains(path, "./plugins/with-android-process-guard", "app.config.js");
  assertContains(path, "withAndroidProcessGuard,", "app.config.js");
  assertContains(
    join(pluginDir, "with-android-process-guard.js"),
    "ProcessGuardProvider",
    "plugins/with-android-process-guard.js",
  );
}

function patchDisplayMetrics(dir) {
  const pluginDir = join(dir, "packages", "app", "plugins");
  if (!existsSync(pluginDir)) fail(`missing plugins dir: ${pluginDir}`);

  const pluginName = "with-android-display-metrics";
  const source = join(displayMetricsSrc, `${pluginName}.js`);
  if (!existsSync(source)) fail(`missing display metrics plugin: ${source}`);
  copyFileSync(source, join(pluginDir, `${pluginName}.js`));

  const path = join(dir, "packages", "app", "app.config.js");
  let content = read(path);
  const original = content;
  const nl = detectNewline(content);

  if (!content.includes(`./plugins/${pluginName}`)) {
    const needle = 'const withPasteInput = require("./plugins/with-paste-input");';
    if (!content.includes(needle)) {
      fail('app.config.js: cannot find anchor `const withPasteInput = require("./plugins/with-paste-input");`');
    }
    content = content.replace(
      needle,
      () =>
        `${needle}${nl}const withAndroidDisplayMetrics = require("./plugins/${pluginName}");`,
    );
  }

  if (!/withAndroidDisplayMetrics,/.test(content)) {
    const needle = /^([ \t]*)withPasteInput,[ \t]*\r?$/m;
    const match = needle.exec(content);
    if (!match) fail("app.config.js: cannot find anchor `withPasteInput,` inside the plugins array");
    content = content.replace(
      needle,
      (m) => `${m.replace(/\r$/, "")}${nl}${match[1]}withAndroidDisplayMetrics,`,
    );
  }

  writeIfChanged(path, content, original, "packages/app/app.config.js (display metrics)");

  assertContains(path, `./plugins/${pluginName}`, "app.config.js");
  assertContains(path, "withAndroidDisplayMetrics,", "app.config.js");
  assertContains(
    join(pluginDir, `${pluginName}.js`),
    "PaseoMultiDisplayMetrics",
    `plugins/${pluginName}.js`,
  );
}

function patchComposerBadges(dir) {
  if (!existsSync(badgePatch)) return;
  try {
    execFileSync("git", ["apply", "--check", "--reverse", badgePatch], {
      cwd: dir,
      stdio: "ignore",
    });
    console.log("[statusbar-patch] composer badges patch already applied");
    return;
  } catch {}
  try {
    execFileSync("git", ["apply", badgePatch], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("[statusbar-patch] applied composer badges patch");
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? String(error);
    fail(`failed to apply ${badgePatch}:\n${stderr.trim()}`);
  }
}

console.log(`[statusbar-patch] source dir: ${sourceDir}`);
assertDependency(sourceDir);
patchAppConfig(sourceDir);
patchRootLayout(sourceDir);
patchProcessGuard(sourceDir);
patchDisplayMetrics(sourceDir);
patchComposerBadges(sourceDir);

// The badges patch also carries the tool-call display fix: a catch-all ACP tool
// call shows the tool's own name instead of the word "Other", and camelCase
// names keep their spelling. `git apply` succeeding only proves the text
// landed, so check the code that is supposed to be there.
assertContains(
  join(sourceDir, "packages", "protocol", "src", "tool-call-display.ts"),
  "if (/[A-Z]/.test(trimmed.slice(1))) {",
  "packages/protocol/src/tool-call-display.ts",
);

console.log("[statusbar-patch] done");
