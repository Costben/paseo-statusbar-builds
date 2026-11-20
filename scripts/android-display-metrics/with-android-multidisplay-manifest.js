// Declares `blindcast.rn.multidisplay=true` in AndroidManifest.xml when upstream
// already provides `modules/paseo-display-metrics`, so BlindCast skips its
// legacy React Native 30fps/density fallback.

const { withAndroidManifest } = require("expo/config-plugins");

function withAndroidMultidisplayManifest(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("[multidisplay-manifest] AndroidManifest has no <application> element");
    }
    application["meta-data"] = application["meta-data"] ?? [];
    const name = "blindcast.rn.multidisplay";
    if (!application["meta-data"].some((entry) => entry.$?.["android:name"] === name)) {
      application["meta-data"].push({
        $: { "android:name": name, "android:value": "true" },
      });
    }
    return modConfig;
  });
}

module.exports = withAndroidMultidisplayManifest;
