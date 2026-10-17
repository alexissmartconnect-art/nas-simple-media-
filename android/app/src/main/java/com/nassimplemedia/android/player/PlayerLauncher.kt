package com.nassimplemedia.android.player

import android.content.Context
import android.content.Intent
import com.nassimplemedia.android.data.MediaItem
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object PlayerLauncher {
    const val EXTRA_BASE = "base"
    const val EXTRA_SHARE_TOKEN = "share_token"
    const val EXTRA_SHARE_PASSWORD = "share_password"
    const val EXTRA_TRANSCODE = "transcode"
    const val EXTRA_START_MS = "start_ms"
    const val EXTRA_QUEUE = "queue"
    const val EXTRA_INDEX = "index"

    /** Play [queue] starting at [index] (music albums play as a queue; videos as one item). */
    fun play(
        context: Context,
        base: String,
        queue: List<MediaItem>,
        index: Int = 0,
        startMs: Long = 0,
        transcodeEnabled: Boolean = true,
        shareToken: String? = null,
        sharePassword: String? = null,
    ) {
        val intent = Intent(context, PlayerActivity::class.java)
            .putExtra(EXTRA_BASE, base)
            .putExtra(EXTRA_QUEUE, Json.encodeToString(queue))
            .putExtra(EXTRA_INDEX, index)
            .putExtra(EXTRA_START_MS, startMs)
            .putExtra(EXTRA_TRANSCODE, transcodeEnabled)
            .putExtra(EXTRA_SHARE_TOKEN, shareToken)
            .putExtra(EXTRA_SHARE_PASSWORD, sharePassword)
        context.startActivity(intent)
    }
}
