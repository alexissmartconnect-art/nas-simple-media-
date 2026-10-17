package com.nassimplemedia.android.data

/** Qualities offered in the player (server presets + "Auto"). */
enum class Quality(val label: String, val serverValue: String?) {
    AUTO("Auto", null),
    ORIGINAL("Original", "original"),
    P1080("1080p", "1080p"),
    P720("720p", "720p"),
    P480("480p", "480p");

    companion object {
        fun fromName(name: String?): Quality = entries.firstOrNull { it.name == name } ?: AUTO
    }
}

enum class SourceKind { DIRECT, HLS }

data class PlaybackPlan(
    val kind: SourceKind,
    /** Server quality value to send to the HLS endpoint (null for DIRECT). */
    val hlsQuality: String?,
    val audioIndex: Int = 0,
)

/**
 * Decides how to play an item, Plex-style:
 *  - music: always the original file (ExoPlayer reads mp3/flac/aac/opus).
 *  - Original: the untouched file over HTTP Range (ExoPlayer handles MKV/MP4, H.264/HEVC…).
 *  - 1080p / 720p / 480p: server HLS transcode at that preset.
 *  - Auto: direct play when the device can very likely decode it (ExoPlayer is far
 *    more capable than a browser), otherwise HLS "original" (remux, audio → AAC).
 *  The player falls back to HLS automatically when direct play fails.
 */
object PlaybackPlanner {
    private val directVideoCodecs = setOf("h264", "hevc", "h265", "vp9", "av1", "mpeg4", "vp8")
    private val hardContainers = setOf("avi", "m2ts", "mpg", "mpeg")

    fun plan(
        isVideo: Boolean,
        quality: Quality,
        transcodeEnabled: Boolean,
        summary: ProbeSummary?,
        videoCodec: String?,
        hint: PlaybackHint?,
        filename: String,
        audioIndex: Int = 0,
    ): PlaybackPlan {
        if (!isVideo) return PlaybackPlan(SourceKind.DIRECT, null)
        if (!transcodeEnabled) return PlaybackPlan(SourceKind.DIRECT, null)
        return when (quality) {
            Quality.ORIGINAL -> PlaybackPlan(SourceKind.DIRECT, null)
            Quality.P1080, Quality.P720, Quality.P480 ->
                PlaybackPlan(SourceKind.HLS, quality.serverValue, audioIndex)
            Quality.AUTO -> if (canDirectPlay(summary, videoCodec, hint, filename) && audioIndex == 0) {
                PlaybackPlan(SourceKind.DIRECT, null)
            } else {
                PlaybackPlan(SourceKind.HLS, "original", audioIndex)
            }
        }
    }

    fun canDirectPlay(summary: ProbeSummary?, videoCodec: String?, hint: PlaybackHint?, filename: String): Boolean {
        val ext = filename.substringAfterLast('.', "").lowercase()
        if (ext in hardContainers) return false
        if (summary != null) {
            // DTS / TrueHD have no software decoder in ExoPlayer.
            if (summary.hasDts || summary.hasTrueHd) return false
            val codec = videoCodec?.lowercase()
            if (codec != null && codec.isNotEmpty() && codec !in directVideoCodecs) return false
            return true
        }
        // No probe yet: MKV/MP4 are fine for ExoPlayer, trust the server hint otherwise.
        if (ext in setOf("mkv", "mp4", "m4v", "webm", "mov")) return true
        return hint?.directLikely ?: false
    }
}

/** Builds endpoint paths for a logged-in session or a guest share. */
sealed class MediaSource {
    abstract fun rawPath(mediaId: Int): String
    abstract fun hlsStartPath(mediaId: Int, quality: String, audio: Int): String
    abstract fun thumbPath(mediaId: Int): String
    abstract fun subtitlePath(mediaId: Int, index: Int): String
    abstract fun streamsPath(mediaId: Int): String

    data object Session : MediaSource() {
        override fun rawPath(mediaId: Int) = "/api/stream/$mediaId/raw"
        override fun hlsStartPath(mediaId: Int, quality: String, audio: Int) =
            "/api/stream/$mediaId/hls" + query(quality, audio)
        override fun thumbPath(mediaId: Int) = "/api/media/$mediaId/thumb.jpg"
        override fun subtitlePath(mediaId: Int, index: Int) = "/api/media/$mediaId/subtitles/$index.vtt"
        override fun streamsPath(mediaId: Int) = "/api/media/$mediaId/streams"
    }

    data class Share(val token: String, val password: String?) : MediaSource() {
        private val base get() = "/api/public/share/${enc(token)}/item"
        private val pw get() = if (password.isNullOrEmpty()) "" else "password=${enc(password)}"
        private fun withPw(path: String) = if (pw.isEmpty()) path else path + (if ('?' in path) "&" else "?") + pw
        override fun rawPath(mediaId: Int) = withPw("$base/$mediaId/stream")
        override fun hlsStartPath(mediaId: Int, quality: String, audio: Int) =
            withPw("$base/$mediaId/hls" + query(quality, audio))
        override fun thumbPath(mediaId: Int) = withPw("$base/$mediaId/thumb.jpg")
        override fun subtitlePath(mediaId: Int, index: Int) = withPw("$base/$mediaId/subtitles/$index.vtt")
        override fun streamsPath(mediaId: Int) = withPw("$base/$mediaId/streams")
    }

    protected fun query(quality: String, audio: Int): String {
        val parts = mutableListOf<String>()
        if (quality != "original") parts += "quality=$quality"
        if (audio > 0) parts += "audio=$audio"
        return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    }

    protected fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
