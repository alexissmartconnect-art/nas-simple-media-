package com.nassimplemedia.android.player

import android.content.Context
import com.nassimplemedia.android.data.Quality

/** Non-sensitive playback preferences (default quality). */
object PlayerPrefs {
    private const val FILE = "player_prefs"
    fun quality(ctx: Context): Quality =
        Quality.fromName(ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("quality", null))
    fun setQuality(ctx: Context, q: Quality) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString("quality", q.name).apply()
    }
}
