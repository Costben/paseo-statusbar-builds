package sh.paseo.processguard

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.io.File

/**
 * Keeps exactly one `sh.paseo` main process alive.
 *
 * Upstream Paseo (Expo / React Native) leaks its own main process: every
 * session rebuild or reconnect forks a fresh instance and the previous one is
 * never reaped. The strays drop out of ActivityManager's ProcessRecord list, so
 * force-stop, "clear all" in recents and the low-memory killer all walk past
 * them. Measured on a OnePlus 15 (2026-10-24): 19 live instances, 2.0 GB RSS +
 * 7.7 GB swap, >25 h accumulated CPU. That exhausted the 12 GB swap, pinned
 * kswapd0 / erm_reclaimd, and thermally clamped the prime cores from 3.5 GHz to
 * 1.78 GHz — the phone ran hot and stuttered all day.
 *
 * Two mechanisms, both inside the app's own uid, no root:
 *
 *  1. On startup the new instance reads the token directory and SIGKILLs every
 *     other live instance recorded there.
 *  2. A watchdog repeats that sweep every 90 s. If a newer instance exists and
 *     this one is neither in the foreground nor freshly started, it retires
 *     itself.
 *
 * Liveness is decided from `/proc/<pid>/stat`: the start time (field 22) must
 * match the value recorded in the token, which also rules out PID reuse. If the
 * read fails the token is treated as dead — the guard degrades to "do nothing"
 * rather than killing the wrong process.
 */
internal object ProcessGuard {
    private const val TAG = "PaseoProcessGuard"
    private const val TOKEN_SUFFIX = ".tok"
    private const val DIR_NAME = "process-guard"

    private const val BOOT_DELAY_MS = 15_000L
    private const val SWEEP_INTERVAL_MS = 90_000L

    /** A process younger than this is never retired by the watchdog. */
    private const val MIN_AGE_MS = 5 * 60_000L

    @Volatile
    private var installed = false

    /** Number of started (visible) activities; anything > 0 means foreground. */
    @Volatile
    private var foregroundDepth = 0

    private var guardDir: File? = null
    private var myElapsedAtInstall = 0L

    fun install(context: Context) {
        if (installed) return
        installed = true

        // Only the default process participates. Any `sh.paseo:xxx` helper
        // process returns here and is left alone.
        val processName = Application.getProcessName()
        if (processName != null && processName != context.packageName) return

        val dir = File(context.filesDir, DIR_NAME)
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "cannot create $dir, guard disabled")
            return
        }
        guardDir = dir
        myElapsedAtInstall = SystemClock.elapsedRealtime()

        (context.applicationContext as? Application)?.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityStarted(activity: Activity) {
                    foregroundDepth++
                }

                override fun onActivityStopped(activity: Activity) {
                    if (foregroundDepth > 0) foregroundDepth--
                }

                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
                override fun onActivityResumed(activity: Activity) = Unit
                override fun onActivityPaused(activity: Activity) = Unit
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
                override fun onActivityDestroyed(activity: Activity) = Unit
            },
        )

        Thread({ loop() }, "paseo-process-guard").apply {
            isDaemon = true
            start()
        }
    }

    private fun loop() {
        sleepQuietly(BOOT_DELAY_MS)
        while (true) {
            try {
                sweep()
            } catch (t: Throwable) {
                Log.w(TAG, "sweep failed", t)
            }
            sleepQuietly(SWEEP_INTERVAL_MS)
        }
    }

    private fun sweep() {
        val dir = guardDir ?: return
        val myPid = Process.myPid()
        val myStart = startTimeOf(myPid) ?: return

        val live = ArrayList<LongArray>() // [pid, starttime]
        dir.listFiles()?.forEach { file ->
            if (!file.name.endsWith(TOKEN_SUFFIX)) return@forEach
            val pid = file.name.removeSuffix(TOKEN_SUFFIX).toIntOrNull() ?: return@forEach
            val start = startTimeOf(pid)
            if (start == null) {
                file.delete()
                return@forEach
            }
            val recorded = file.readTextOrNull()?.trim()?.toLongOrNull()
            if (recorded != null && recorded != start) {
                // PID was recycled by an unrelated process; the token is stale.
                file.delete()
                return@forEach
            }
            live.add(longArrayOf(pid.toLong(), start))
        }

        val selfToken = File(dir, "$myPid$TOKEN_SUFFIX")
        if (live.none { it[0] == myPid.toLong() }) {
            selfToken.writeTextQuietly(myStart.toString())
            live.add(longArrayOf(myPid.toLong(), myStart))
        }

        if (live.size <= 1) return

        val newest = live.maxByOrNull { it[1] } ?: return
        val newestPid = newest[0].toInt()

        if (newestPid == myPid) {
            for (entry in live) {
                val pid = entry[0].toInt()
                if (pid == myPid) continue
                Log.w(TAG, "reclaiming leaked instance pid=$pid")
                runCatching { Process.killProcess(pid) }
                File(dir, "$pid$TOKEN_SUFFIX").delete()
            }
            return
        }

        if (foregroundDepth > 0) return
        if (SystemClock.elapsedRealtime() - myElapsedAtInstall < MIN_AGE_MS) return

        Log.w(TAG, "retiring self pid=$myPid, newer instance pid=$newestPid")
        selfToken.delete()
        Process.killProcess(myPid)
    }

    /** Field 22 of `/proc/<pid>/stat`; `null` when the process is gone or unreadable. */
    private fun startTimeOf(pid: Int): Long? = try {
        val stat = File("/proc/$pid/stat").readText()
        val tail = stat.substring(stat.lastIndexOf(')') + 2)
        tail.split(' ').getOrNull(19)?.toLongOrNull()
    } catch (t: Throwable) {
        null
    }

    private fun File.readTextOrNull(): String? = try {
        readText()
    } catch (t: Throwable) {
        null
    }

    private fun File.writeTextQuietly(value: String) {
        try {
            writeText(value)
        } catch (t: Throwable) {
            Log.w(TAG, "cannot write token $this", t)
        }
    }

    private fun sleepQuietly(millis: Long) {
        try {
            Thread.sleep(millis)
        } catch (ignored: InterruptedException) {
            // Daemon thread: nothing to unwind, just keep the loop quiet.
        }
    }
}
