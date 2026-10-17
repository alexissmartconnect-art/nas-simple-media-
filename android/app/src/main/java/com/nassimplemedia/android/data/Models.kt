package com.nassimplemedia.android.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Mirrors the JSON returned by the nas-simple-media server (src/routes/api.ts). */

@Serializable
data class User(
    val id: Int,
    val username: String,
    val role: String = "user",
    @SerialName("can_share") val canShare: Boolean = false,
    /** Server 1.6+: the account still uses the factory password and must change it (web UI). */
    @SerialName("must_change_password") val mustChangePassword: Boolean = false,
)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val user: User? = null,
    val error: String? = null,
    val mustChangePassword: Boolean = false,
    val code: String? = null,
    val message: String? = null,
)

@Serializable
data class MeResponse(val authenticated: Boolean = false, val user: User? = null)

@Serializable
data class SetupStatus(
    val defaultAdminUser: String? = null,
    val defaultAdminActive: Boolean = false,
    val passwordMinLength: Int = 10,
)

@Serializable
data class Library(
    val id: Int,
    val name: String,
    /** movies | series | music */
    val type: String,
    val enabled: Boolean = true,
    @SerialName("item_count") val itemCount: Int = 0,
)

@Serializable
data class LibrariesResponse(val libraries: List<Library> = emptyList())

@Serializable
data class PlaybackHint(
    val suggestedMode: String = "direct",
    val directLikely: Boolean = true,
    val reason: String? = null,
)

@Serializable
data class Progress(
    @SerialName("media_id") val mediaId: Int = 0,
    @SerialName("position_ms") val positionMs: Long = 0,
    @SerialName("duration_ms") val durationMs: Long = 0,
    val watched: Boolean = false,
)

@Serializable
data class MediaItem(
    val id: Int,
    @SerialName("library_id") val libraryId: Int = 0,
    val filename: String = "",
    val title: String = "",
    /** movie | episode | track */
    val type: String = "movie",
    /** movies | series | music */
    val kind: String = "movies",
    @SerialName("show_name") val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val artist: String? = null,
    val album: String? = null,
    @SerialName("track_num") val trackNum: Int? = null,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("created_at") val createdAt: String? = null,
    val playback: PlaybackHint? = null,
    // Present on /continue-watching rows
    @SerialName("position_ms") val positionMs: Long? = null,
    @SerialName("duration_ms") val durationMs: Long? = null,
    @SerialName("progress_ratio") val progressRatio: Double? = null,
) {
    val isVideo: Boolean get() = type != "track"
    val displayTitle: String
        get() = when {
            type == "episode" && showName != null && season != null && episode != null ->
                "$showName · S%02dE%02d".format(season, episode)
            else -> title.ifBlank { filename }
        }
}

@Serializable
data class MediaListResponse(
    val items: List<MediaItem> = emptyList(),
    val total: Int = 0,
    val limit: Int = 0,
    val offset: Int = 0,
)

@Serializable
data class ItemsResponse(val items: List<MediaItem> = emptyList())

@Serializable
data class Show(
    val name: String,
    val episodes: Int = 0,
    val seasons: Int = 0,
    @SerialName("library_id") val libraryId: Int = 0,
    /** First episode id, used as the show poster (server >= 1.6). */
    @SerialName("poster_media_id") val posterMediaId: Int? = null,
)

@Serializable
data class ShowsResponse(val shows: List<Show> = emptyList())

@Serializable
data class Artist(
    val name: String,
    val tracks: Int = 0,
    val albums: Int = 0,
    @SerialName("library_id") val libraryId: Int = 0,
)

@Serializable
data class ArtistsResponse(val artists: List<Artist> = emptyList())

@Serializable
data class ProbeSummary(
    val videoLabel: String? = null,
    val audioLabels: List<String> = emptyList(),
    val subtitleLabels: List<String> = emptyList(),
    val hasVideo: Boolean = true,
    val hasSurround: Boolean = false,
    val hasDts: Boolean = false,
    val hasTrueHd: Boolean = false,
    val hasHdr: Boolean = false,
    val width: Int? = null,
    val height: Int? = null,
    val durationMs: Long? = null,
)

@Serializable
data class VideoTrack(val index: Int = 0, val codec: String = "", val label: String? = null)

@Serializable
data class AudioTrack(
    val index: Int = 0,
    val codec: String = "",
    val channels: Int = 2,
    val language: String? = null,
    val label: String? = null,
    val isDefault: Boolean = false,
)

@Serializable
data class SubtitleTrack(
    val index: Int = 0,
    val codec: String = "",
    val language: String? = null,
    val label: String? = null,
    val isDefault: Boolean = false,
    val isForced: Boolean = false,
    val imageBased: Boolean = false,
)

/** GET /api/media/:id — Plex-like "preplay" payload. */
@Serializable
data class MediaDetail(
    val id: Int,
    @SerialName("library_id") val libraryId: Int = 0,
    val filename: String = "",
    val title: String = "",
    val type: String = "movie",
    val kind: String = "movies",
    @SerialName("show_name") val showName: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val artist: String? = null,
    val album: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    val playback: PlaybackHint? = null,
    val transcodeEnabled: Boolean = false,
    val summary: ProbeSummary? = null,
    val video: List<VideoTrack> = emptyList(),
    val audio: List<AudioTrack> = emptyList(),
    val subtitles: List<SubtitleTrack> = emptyList(),
    val hasThumb: Boolean = false,
    val progress: Progress? = null,
)

/** GET /api/stream/:id/hls (and the share equivalent). */
@Serializable
data class HlsStart(
    val status: String? = null,
    val playlistUrl: String? = null,
    val error: String? = null,
)

/** GET /api/public/share/:token */
@Serializable
data class ShareInfo(
    val needsPassword: Boolean = false,
    val id: Int? = null,
    val title: String? = null,
    val type: String? = null,
    val targetType: String? = null,
    val shareTitle: String? = null,
    val itemCount: Int = 0,
    val transcodeEnabled: Boolean = false,
    val items: List<MediaItem> = emptyList(),
)

@Serializable
data class StreamsInfo(
    val summary: ProbeSummary? = null,
    val audio: List<AudioTrack> = emptyList(),
    val subtitles: List<SubtitleTrack> = emptyList(),
)

@Serializable
data class ErrorBody(val error: String? = null, val code: String? = null)

/** POST /api/public/share/:token/unlock → short-lived signed token (null when no password). */
@Serializable
data class ShareUnlock(val ok: Boolean = false, val accessToken: String? = null, val expiresAt: String? = null)
