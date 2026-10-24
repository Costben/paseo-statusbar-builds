// Installs the Paseo process-lifecycle guard into the generated Android project.
//
// Expo prebuild does not keep `android/` in the repository, so the guard ships as
// two Kotlin sources copied into the module plus a ContentProvider registered in
// the manifest. See scripts/android-process-guard/ProcessGuard.kt for why this
// exists.

const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_PATH = ["sh", "paseo", "processguard"];
const PROVIDER_CLASS = "sh.paseo.processguard.ProcessGuardProvider";
const AUTHORITY_SUFFIX = ".processguard";
const SOURCE_DIR = path.resolve(__dirname, "android-process-guard");

function withAndroidProcessGuard(config) {
  config = withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const projectRoot = modConfig.modRequest.platformProjectRoot;
      const targetDir = path.join(projectRoot, "app", "src", "main", "java", ...PACKAGE_PATH);
      fs.mkdirSync(targetDir, { recursive: true });

      for (const name of ["ProcessGuard.kt", "ProcessGuardProvider.kt"]) {
        const source = path.join(SOURCE_DIR, name);
        if (!fs.existsSync(source)) {
          throw new Error(`[process-guard] missing template: ${source}`);
        }
        fs.copyFileSync(source, path.join(targetDir, name));
      }

      console.log(`[process-guard] installed sources into ${targetDir}`);
      return modConfig;
    },
  ]);

  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("[process-guard] AndroidManifest has no <application> element");
    }

    application.provider = application.provider ?? [];
    const alreadyThere = application.provider.some(
      (entry) => entry.$?.["android:name"] === PROVIDER_CLASS,
    );

    if (!alreadyThere) {
      application.provider.push({
        $: {
          "android:name": PROVIDER_CLASS,
          "android:authorities": `\${applicationId}${AUTHORITY_SUFFIX}`,
          "android:exported": "false",
          // Larger initOrder wins, so the guard starts before the RN runtime.
          "android:initOrder": "1000",
        },
      });
      console.log("[process-guard] registered ProcessGuardProvider");
    }

    return modConfig;
  });

  return config;
}

module.exports = withAndroidProcessGuard;
