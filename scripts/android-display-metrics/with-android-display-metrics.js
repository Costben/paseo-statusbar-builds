// Keeps React Native's DisplayMetricsHolder on the display the Activity is
// actually attached to.
//
// React Native initializes DisplayMetricsHolder from the application context
// (`ReactRootView.init`, `ReactHostImpl.onConfigurationChanged`, ...), and the
// application context's default display is always display 0. On a secondary or
// virtual display that mixes the primary display's density with the current
// display's font scale: layout converts with the primary `density`, text
// measurement converts with the current `scaledDensity`, and every line is
// clipped to a fraction of its height.
//
// The fix re-applies both metrics from the Activity itself right after React
// Native has initialized/overwritten them: onCreate (after the root view and
// its surface exist), onConfigurationChanged (after ReactHostImpl re-inits with
// the application context) and onResume (fallback). On the primary display the
// two metric sets are already equal, so behavior there is unchanged.

const { withAndroidManifest, withMainActivity } = require("expo/config-plugins");

const HELPER_MARKER = "PaseoMultiDisplayMetrics";
const CALL = "applyDisplayMetricsFromActivity()";

const HELPER = `
  // ${HELPER_MARKER}: React Native keeps the primary display's density in
  // DisplayMetricsHolder no matter which display this Activity runs on. Both
  // metrics must come from the Activity's own display for text layout to match
  // text measurement.
  @Suppress("DEPRECATION")
  private fun applyDisplayMetricsFromActivity() {
    val windowMetrics = resources.displayMetrics
    val screenMetrics = android.util.DisplayMetrics()
    screenMetrics.setTo(windowMetrics)
    val activityDisplay: android.view.Display? =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
          display
        } else {
          windowManager.defaultDisplay
        }
    activityDisplay?.getRealMetrics(screenMetrics)
    // getRealMetrics() reports physical display properties; reuse the Activity's
    // configuration for the density-dependent fields so density, densityDpi and
    // scaledDensity stay consistent with pointScaleFactor.
    screenMetrics.density = windowMetrics.density
    screenMetrics.densityDpi = windowMetrics.densityDpi
    screenMetrics.scaledDensity = windowMetrics.scaledDensity
    com.facebook.react.uimanager.DisplayMetricsHolder.setWindowDisplayMetrics(windowMetrics)
    com.facebook.react.uimanager.DisplayMetricsHolder.setScreenDisplayMetrics(screenMetrics)
  }
`;

const LIFECYCLE_OVERRIDES = `
  override fun onResume() {
    super.onResume()
    ${CALL}
    reactDelegate?.reactRootView?.requestLayout()
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    ${CALL}
    reactDelegate?.reactRootView?.requestLayout()
  }
`;

function configureMainActivity(contents) {
  let result = contents;
  const nl = result.includes("\r\n") ? "\r\n" : "\n";
  const withNl = (text) => text.replace(/\n/g, nl);

  if (!result.includes(HELPER_MARKER)) {
    const classAnchor = /class\s+MainActivity\s*:\s*ReactActivity\(\)\s*\{\r?\n/;
    const match = classAnchor.exec(result);
    if (!match) {
      throw new Error(
        "[display-metrics] MainActivity.kt does not declare `class MainActivity : ReactActivity() {`",
      );
    }
    result = result.replace(classAnchor, () => `${match[0]}${withNl(HELPER)}`);
  }

  const onCreateCall = /^([ \t]*)super\.onCreate\((?:null|savedInstanceState)\)[ \t]*\r?$/m;
  const onCreateMatch = onCreateCall.exec(result);
  if (!onCreateMatch) {
    throw new Error("[display-metrics] MainActivity.kt has no `super.onCreate(...)` call");
  }
  const afterSuper = result.slice(onCreateMatch.index + onCreateMatch[0].length);
  if (!new RegExp(`^\\s*${CALL}`).test(afterSuper)) {
    result = result.replace(
      onCreateCall,
      (line) => `${line.replace(/\r$/, "")}${nl}${onCreateMatch[1]}${CALL}`,
    );
  }

  if (!result.includes("override fun onResume()")) {
    const anchor = /^([ \t]*)override fun getMainComponentName\(\)/m;
    const match = anchor.exec(result);
    if (!match) {
      throw new Error("[display-metrics] MainActivity.kt has no `getMainComponentName` override");
    }
    result = result.replace(
      /^([ \t]*)override fun getMainComponentName\(\)/m,
      (line) => `${withNl(LIFECYCLE_OVERRIDES).replace(/^\r?\n/, "")}${nl}${line}`,
    );
  }

  if (!result.includes("getRealMetrics(screenMetrics)")) {
    throw new Error("[display-metrics] MainActivity.kt post-check failed: helper body missing");
  }
  return result;
}

function withAndroidDisplayMetrics(config) {
  config = withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== "kt") {
      throw new Error("[display-metrics] MainActivity is not Kotlin");
    }
    modConfig.modResults.contents = configureMainActivity(modConfig.modResults.contents);
    return modConfig;
  });

  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("[display-metrics] AndroidManifest has no <application> element");
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

  return config;
}

module.exports = withAndroidDisplayMetrics;
module.exports.configureMainActivity = configureMainActivity;
