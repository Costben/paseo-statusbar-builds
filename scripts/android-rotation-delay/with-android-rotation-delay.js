// Holds the app's orientation until the device has been tilted into the new
// orientation for a moment, so a brief tilt does not flip the screen.
//
// Only native code can hold an orientation: once the activity is free to follow
// the sensor, the window turns the instant the device moves. So the controller
// locks the activity to the orientation it started in and applies a change only
// after `ROTATION_DELAY_MS` of sustained tilt. Turning the switch off stops
// applying changes, which leaves the activity frozen on the axis it is on.
//
// The on/off switch lives in the app's General settings. It reaches this code
// through `filesDir/paseo-rotation.json`, written by
// `packages/app/src/android/rotation-delay.ts`. A React module would need a
// package registration in MainApplication; this is one boolean that changes when
// the user flips a switch, so a file read on each orientation event is enough.

const { withMainActivity } = require("expo/config-plugins");

const MARKER = "PaseoRotationDelay";
const HOLD_MS = 500;

const HELPER = `
  // ${MARKER}: keep the current orientation until the device has held the new
  // one for a moment. Reads its switch from filesDir/paseo-rotation.json.
  private val rotationDelayHoldMs = ${HOLD_MS}L
  private val rotationDelayHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var rotationDelayAppliedLandscape = false
  private var rotationDelayPendingLandscape: Boolean? = null
  private var rotationDelaySettingReadAt = 0L
  private var rotationDelayEnabled = true
  private var rotationDelayListener: android.view.OrientationEventListener? = null

  private val rotationDelayRunnable = Runnable {
    val pending = rotationDelayPendingLandscape
    rotationDelayPendingLandscape = null
    if (pending != null && rotationDelayEnabled && pending != rotationDelayAppliedLandscape) {
      rotationDelayApply(pending)
    }
  }

  private fun rotationDelayApply(landscape: Boolean) {
    rotationDelayAppliedLandscape = landscape
    // SENSOR_* rather than the fixed orientations: both portrait and both
    // landscape directions stay usable, so the text is never upside down in the
    // hand position the user picked.
    requestedOrientation =
      if (landscape) {
        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      } else {
        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
      }
  }

  private fun rotationDelayAutoRotateEnabled(): Boolean {
    val now = android.os.SystemClock.elapsedRealtime()
    if (now - rotationDelaySettingReadAt >= 500L) {
      rotationDelaySettingReadAt = now
      rotationDelayEnabled =
        try {
          val file = java.io.File(filesDir, "paseo-rotation.json")
          if (file.exists()) {
            org.json.JSONObject(file.readText()).optBoolean("autoRotate", true)
          } else {
            true
          }
        } catch (error: Exception) {
          true
        }
      if (!rotationDelayEnabled) {
        // Frozen where it is: drop the pending flip and stop applying new ones.
        rotationDelayHandler.removeCallbacks(rotationDelayRunnable)
        rotationDelayPendingLandscape = null
      }
    }
    return rotationDelayEnabled
  }

  private fun rotationDelayOnOrientation(degrees: Int) {
    // Read the switch before the angle so turning auto-rotate off takes effect
    // even while the device lies flat.
    if (!rotationDelayAutoRotateEnabled()) return
    if (degrees == android.view.OrientationEventListener.ORIENTATION_UNKNOWN) return
    val landscape = (degrees >= 45 && degrees < 135) || (degrees >= 225 && degrees < 315)
    if (landscape == rotationDelayAppliedLandscape) {
      rotationDelayHandler.removeCallbacks(rotationDelayRunnable)
      rotationDelayPendingLandscape = null
      return
    }
    if (rotationDelayPendingLandscape == landscape) return
    rotationDelayHandler.removeCallbacks(rotationDelayRunnable)
    rotationDelayPendingLandscape = landscape
    rotationDelayHandler.postDelayed(rotationDelayRunnable, rotationDelayHoldMs)
  }

  private fun startRotationDelayListener() {
    if (rotationDelayListener != null) return
    val listener =
      object :
        android.view.OrientationEventListener(this, android.hardware.SensorManager.SENSOR_DELAY_UI) {
        override fun onOrientationChanged(orientation: Int) {
          rotationDelayOnOrientation(orientation)
        }
      }
    rotationDelayListener = listener
    if (listener.canDetectOrientation()) listener.enable()
  }

  private fun stopRotationDelayListener() {
    rotationDelayListener?.disable()
    rotationDelayListener = null
    rotationDelayHandler.removeCallbacks(rotationDelayRunnable)
    rotationDelayPendingLandscape = null
  }

  private fun initRotationDelay() {
    rotationDelayAppliedLandscape =
      resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
    // Lock to where the app started; every change after this is ours to time.
    rotationDelayApply(rotationDelayAppliedLandscape)
  }

`;

// onStart/onStop rather than onResume/onPause: the display-metrics plugin owns
// onResume and refuses a MainActivity whose onResume it does not recognise. A
// plugin array is also executed in reverse, so neither plugin can count on
// running before the other. These two names belong to nobody else.
const LIFECYCLE = [
  { name: "onStart", call: "startRotationDelayListener()" },
  { name: "onStop", call: "stopRotationDelayListener()" },
];

function matchingBrace(text, openIndex) {
  if (openIndex === -1) return -1;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Adds `call` inside an existing `override fun <name>()` body. */
function injectIntoOverride(contents, name, call) {
  const nl = contents.includes("\r\n") ? "\r\n" : "\n";
  const decl = new RegExp(`^([ \\t]*)override fun ${name}\\(\\)[ \\t]*\\{[ \\t]*\\r?$`, "m").exec(
    contents,
  );
  if (!decl) return null;

  const bodyStart = decl.index + decl[0].length;
  const superCall = new RegExp(`^([ \\t]*)super\\.${name}\\(\\)[ \\t]*\\r?$`, "m").exec(
    contents.slice(bodyStart),
  );
  const at = superCall ? bodyStart + superCall.index + superCall[0].length : bodyStart;
  if (new RegExp(`^\\s*${call.replace(/[()]/g, "\\$&")}`).test(contents.slice(at))) {
    return contents;
  }
  return contents.slice(0, at) + `${nl}${decl[1]}  ${call}` + contents.slice(at);
}

function appendOverride(contents, name, call) {
  const nl = contents.includes("\r\n") ? "\r\n" : "\n";
  const onCreate = /override fun onCreate\(/m.exec(contents);
  if (!onCreate) {
    throw new Error("[rotation-delay] MainActivity.kt has no onCreate to insert after");
  }
  const end = matchingBrace(contents, contents.indexOf("{", onCreate.index));
  if (end === -1) {
    throw new Error("[rotation-delay] MainActivity.kt: cannot find the end of onCreate");
  }
  const body = `${nl}${nl}  override fun ${name}() {${nl}    super.${name}()${nl}    ${call}${nl}  }`;
  return contents.slice(0, end + 1) + body + contents.slice(end + 1);
}

function configureMainActivity(contents) {
  let result = contents;
  const nl = result.includes("\r\n") ? "\r\n" : "\n";

  if (!result.includes(MARKER)) {
    const classAnchor = /class\s+MainActivity\s*:\s*ReactActivity\(\)\s*\{\r?\n/;
    const match = classAnchor.exec(result);
    if (!match) {
      throw new Error(
        "[rotation-delay] MainActivity.kt does not declare `class MainActivity : ReactActivity() {`",
      );
    }
    result = result.replace(classAnchor, () => `${match[0]}${HELPER.replace(/\n/g, nl)}`);
  }

  const onCreateCall = /^([ \t]*)super\.onCreate\((?:null|savedInstanceState)\)[ \t]*\r?$/m;
  const onCreateMatch = onCreateCall.exec(result);
  if (!onCreateMatch) {
    throw new Error("[rotation-delay] MainActivity.kt has no `super.onCreate(...)` call");
  }
  const indent = onCreateMatch[1];
  const superEnd = onCreateMatch.index + onCreateMatch[0].length;
  // Display metrics must be re-applied before the orientation is locked, so sit
  // below that call when the display-metrics plugin ran first.
  const metricsCall = /^(?:[ \t]*\r?\n)*([ \t]*)applyDisplayMetricsFromActivity\(\)[ \t]*\r?$/m.exec(
    result.slice(superEnd),
  );
  const initAt = metricsCall ? superEnd + metricsCall[0].length : superEnd;
  if (!/^(?:[ \t]*\r?\n)*[ \t]*initRotationDelay\(\)/.test(result.slice(initAt))) {
    result = result.slice(0, initAt) + `${nl}${indent}initRotationDelay()` + result.slice(initAt);
  }

  for (const { name, call } of LIFECYCLE) {
    const injected = injectIntoOverride(result, name, call);
    result = injected === null ? appendOverride(result, name, call) : injected;
  }

  for (const marker of [
    "initRotationDelay()",
    "startRotationDelayListener()",
    "stopRotationDelayListener()",
  ]) {
    if (!result.includes(marker)) {
      throw new Error(`[rotation-delay] MainActivity.kt post-check failed: ${marker} is missing`);
    }
  }
  return result;
}

function withAndroidRotationDelay(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== "kt") {
      throw new Error("[rotation-delay] MainActivity is not Kotlin");
    }
    modConfig.modResults.contents = configureMainActivity(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withAndroidRotationDelay;
module.exports.configureMainActivity = configureMainActivity;
