package sh.paseo.processguard

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/**
 * Zero-UI entry point for [ProcessGuard].
 *
 * A ContentProvider is created by the framework before `Application.onCreate`,
 * so the sweep starts as early as possible and does not depend on any upstream
 * application class keeping an `onCreate` anchor we can hook into.
 */
class ProcessGuardProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.let { ProcessGuard.install(it) }
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
