package com.nassimplemedia.android.player

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.nassimplemedia.android.NasApp
import com.nassimplemedia.android.R
import com.nassimplemedia.android.data.AudioTrack
import com.nassimplemedia.android.data.MediaItem
import com.nassimplemedia.android.data.MediaSource
import com.nassimplemedia.android.data.PlaybackPlanner
import com.nassimplemedia.android.data.ProbeSummary
import com.nassimplemedia.android.data.Quality
import com.nassimplemedia.android.data.Session
import com.nassimplemedia.android.data.SourceKind
import com.nassimplemedia.android.data.SubtitleTrack
import com.nassimplemedia.android.ui.FocusRow
import com.nassimplemedia.android.ui.NasOrange
import com.nassimplemedia.android.ui.NasSurface
import com.nassimplemedia.android.ui.NasTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import androidx.media3.common.MediaItem as ExoItem

/**
 * Full-screen Media3 player for phone and TV.
 * - Direct play (original file over HTTP Range) or server HLS (remux / transcode).
 * - Quality Auto / Original / 1080p / 720p / 480p, audio + subtitles, resume.
 * - D-pad: the Media3 controller is fully focusable; MENU (or the « Options »
 *   button in the control bar) opens quality / audio / subtitle choices.
 */
@UnstableApi
class PlayerActivity : ComponentActivity() {
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private val api get() = NasApp.instance.api

    private lateinit var base: String
    private var shareToken: String? = null
    private var shareAccess: String? = null
    private var transcodeEnabled = true
    private lateinit var queue: List<MediaItem>
    private var index = 0

    private var quality = Quality.AUTO
    private var audioIndex = 0
    private var forceHls = false
    private var mode = SourceKind.DIRECT
    private var summary: ProbeSummary? = null
    private var serverAudio: List<AudioTrack> = emptyList()
    private var serverSubs: List<SubtitleTrack> = emptyList()

    private var loadJob: Job? = null
    private var progressJob: Job? = null

    private var loadingText by mutableStateOf<String?>(null)
    private var errorText by mutableStateOf<String?>(null)
    private var showOptions by mutableStateOf(false)
    private var titleText by mutableStateOf("")

    private val source: MediaSource
        get() = shareToken?.let { MediaSource.Share(it, shareAccess) } ?: MediaSource.Session
    private val isGuest get() = shareToken != null
    private val current get() = queue[index]

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        base = intent.getStringExtra(PlayerLauncher.EXTRA_BASE) ?: Session.baseUrl ?: run { finish(); return }
        shareToken = intent.getStringExtra(PlayerLauncher.EXTRA_SHARE_TOKEN)
        shareAccess = intent.getStringExtra(PlayerLauncher.EXTRA_SHARE_ACCESS)
        transcodeEnabled = intent.getBooleanExtra(PlayerLauncher.EXTRA_TRANSCODE, true)
        queue = Json { ignoreUnknownKeys = true }.decodeFromString(intent.getStringExtra(PlayerLauncher.EXTRA_QUEUE) ?: "[]")
        if (queue.isEmpty()) { finish(); return }
        index = intent.getIntExtra(PlayerLauncher.EXTRA_INDEX, 0).coerceIn(0, queue.lastIndex)
        val startMs = savedInstanceState?.getLong("pos") ?: intent.getLongExtra(PlayerLauncher.EXTRA_START_MS, 0)
        quality = PlayerPrefs.quality(this)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        val dataSource = OkHttpDataSource.Factory(Session.http)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(dataSource))
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        player.addListener(listener)

        playerView = PlayerView(this).apply {
            player = this@PlayerActivity.player
            keepScreenOn = true
            setShowSubtitleButton(true)
            setShowNextButton(queue.size > 1)
            setShowPreviousButton(queue.size > 1)
            controllerShowTimeoutMs = 4000
            addOptionsButton(this)
        }

        setContent {
            NasTheme {
                Box(Modifier.fillMaxSize().background(Color.Black)) {
                    AndroidView(factory = { playerView }, modifier = Modifier.fillMaxSize())
                    loadingText?.let { msg ->
                        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(color = NasOrange)
                            Spacer(Modifier.height(12.dp))
                            Text(msg, color = Color.White)
                            Text(titleText, color = Color(0xFFAAAAAA))
                        }
                    }
                    errorText?.let { msg ->
                        Text(
                            msg, color = Color(0xFFFF8A80),
                            modifier = Modifier.align(Alignment.Center).background(Color(0xCC000000), RoundedCornerShape(8.dp)).padding(16.dp),
                        )
                    }
                    if (showOptions) OptionsDialog()
                }
            }
        }
        load(startMs)
    }

    /** Adds an « Options » button next to the CC / settings buttons of the Media3 control bar. */
    private fun addOptionsButton(view: PlayerView) {
        val btn = TextView(this).apply {
            text = getString(R.string.player_options)
            setTextColor(android.graphics.Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            val p = (12 * resources.displayMetrics.density).toInt()
            setPadding(p, p / 2, p, p / 2)
            gravity = Gravity.CENTER
            isFocusable = true
            isClickable = true
            setBackgroundResource(R.drawable.player_btn_bg)
            setOnClickListener { showOptions = true }
        }
        val bar = view.findViewById<ViewGroup?>(androidx.media3.ui.R.id.exo_basic_controls)
        if (bar is LinearLayout) {
            bar.addView(btn, 0, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_VERTICAL
                marginEnd = (8 * resources.displayMetrics.density).toInt()
            })
        } else {
            val controller = view.findViewById<ViewGroup?>(androidx.media3.ui.R.id.exo_controller)
            (controller as? FrameLayout)?.addView(btn, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END,
            ).apply { setMargins(24, 24, 24, 24) })
        }
    }

    private fun load(startMs: Long) {
        loadJob?.cancel()
        errorText = null
        val item = current
        titleText = item.displayTitle
        loadingText = getString(R.string.player_loading)
        loadJob = lifecycleScope.launch {
            try {
                if (!item.isVideo) {
                    // Music: queue every track as direct (original file) items.
                    val items = queue.map { exoItem(it, base + source.rawPath(it.id), null, emptyList()) }
                    mode = SourceKind.DIRECT
                    player.setMediaItems(items, index, startMs)
                    player.prepare()
                    player.play()
                    loadingText = null
                    return@launch
                }
                var videoCodec: String? = null
                if (isGuest) {
                    val st = runCatching { api.streams(base, source.streamsPath(item.id)) }.getOrNull()
                    summary = st?.summary
                    serverAudio = st?.audio.orEmpty()
                    serverSubs = st?.subtitles.orEmpty()
                } else {
                    val d = api.detail(item.id)
                    summary = d.summary
                    serverAudio = d.audio
                    serverSubs = d.subtitles
                    transcodeEnabled = d.transcodeEnabled
                    videoCodec = d.video.firstOrNull()?.codec
                }
                val plan = PlaybackPlanner.plan(
                    isVideo = true,
                    quality = quality,
                    transcodeEnabled = transcodeEnabled,
                    summary = summary,
                    videoCodec = videoCodec,
                    hint = item.playback,
                    filename = item.filename,
                    audioIndex = audioIndex,
                ).let { p ->
                    if (forceHls && p.kind == SourceKind.DIRECT && transcodeEnabled)
                        p.copy(kind = SourceKind.HLS, hlsQuality = "original") else p
                }
                mode = plan.kind
                val url = if (plan.kind == SourceKind.HLS) {
                    loadingText = getString(R.string.player_transcoding)
                    api.startHls(base, source.hlsStartPath(item.id, plan.hlsQuality ?: "original", plan.audioIndex))
                } else {
                    base + source.rawPath(item.id)
                }
                val subs = if (plan.kind == SourceKind.HLS) {
                    serverSubs.filter { !it.imageBased }.map { s ->
                        ExoItem.SubtitleConfiguration.Builder(android.net.Uri.parse(base + source.subtitlePath(item.id, s.index)))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage(s.language)
                            .setLabel(s.label ?: s.language ?: "Piste ${s.index + 1}")
                            .setSelectionFlags(if (s.isForced) C.SELECTION_FLAG_FORCED else 0)
                            .build()
                    }
                } else emptyList()
                player.setMediaItem(exoItem(item, url, if (plan.kind == SourceKind.HLS) MimeTypes.APPLICATION_M3U8 else null, subs), startMs)
                player.prepare()
                player.play()
                loadingText = null
                startProgressLoop()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                loadingText = null
                errorText = getString(R.string.player_error, e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private fun exoItem(item: MediaItem, url: String, mime: String?, subs: List<ExoItem.SubtitleConfiguration>): ExoItem =
        ExoItem.Builder()
            .setUri(url)
            .setMediaId(item.id.toString())
            .apply { if (mime != null) setMimeType(mime) }
            .setSubtitleConfigurations(subs)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(item.displayTitle)
                    .setArtist(item.artist)
                    .setAlbumTitle(item.album)
                    .build(),
            )
            .build()

    private val listener = object : Player.Listener {
        override fun onPlayerError(error: PlaybackException) {
            val item = current
            if (item.isVideo && mode == SourceKind.DIRECT && transcodeEnabled && !forceHls) {
                // Plex-like fallback: the device cannot decode the original → server HLS.
                forceHls = true
                Toast.makeText(this@PlayerActivity, R.string.player_fallback, Toast.LENGTH_LONG).show()
                load(player.currentPosition.coerceAtLeast(0))
            } else {
                errorText = getString(R.string.player_error, error.errorCodeName)
            }
        }

        override fun onMediaItemTransition(mediaItem: ExoItem?, reason: Int) {
            val id = mediaItem?.mediaId?.toIntOrNull() ?: return
            val i = queue.indexOfFirst { it.id == id }
            if (i >= 0) { index = i; titleText = queue[i].displayTitle }
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) saveProgress()
        }
    }

    private fun durationMs(): Long {
        val d = player.duration
        return summary?.durationMs?.takeIf { it > 0 } ?: if (d == C.TIME_UNSET) 0 else d
    }

    private fun saveProgress() {
        if (isGuest || !current.isVideo) return
        val pos = if (player.playbackState == Player.STATE_ENDED) durationMs() else player.currentPosition
        val dur = durationMs()
        val id = current.id
        if (pos <= 0 || dur <= 0) return
        NasApp.instance.let { app ->
            app.applicationScope.launch { runCatching { app.api.saveProgress(id, pos, dur) } }
        }
    }

    private fun startProgressLoop() {
        progressJob?.cancel()
        if (isGuest) return
        progressJob = lifecycleScope.launch {
            while (isActive) {
                delay(10_000)
                if (player.isPlaying) saveProgress()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS ||
            keyCode == KeyEvent.KEYCODE_CAPTIONS || keyCode == KeyEvent.KEYCODE_BUTTON_Y
        ) {
            showOptions = true
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::player.isInitialized) outState.putLong("pos", player.currentPosition)
    }

    override fun onPause() {
        super.onPause()
        if (::player.isInitialized) {
            saveProgress()
            player.pause()
        }
    }

    override fun onDestroy() {
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }

    private fun changeQuality(q: Quality) {
        quality = q
        forceHls = false
        PlayerPrefs.setQuality(this, q)
        showOptions = false
        load(player.currentPosition.coerceAtLeast(0))
    }

    private fun changeServerAudio(i: Int) {
        audioIndex = i
        showOptions = false
        load(player.currentPosition.coerceAtLeast(0))
    }

    private data class TrackChoice(val label: String, val selected: Boolean, val apply: () -> Unit)

    private fun playerTracks(type: Int): List<TrackChoice> {
        val out = mutableListOf<TrackChoice>()
        player.currentTracks.groups.filter { it.type == type }.forEachIndexed { gi, g ->
            for (i in 0 until g.length) {
                if (!g.isTrackSupported(i)) continue
                val f = g.getTrackFormat(i)
                val label = listOfNotNull(f.label, f.language?.uppercase()).distinct().joinToString(" · ").ifBlank { "Piste ${gi + 1}" }
                out += TrackChoice(label, g.isTrackSelected(i)) {
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(type, false)
                        .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, i))
                        .build()
                    showOptions = false
                }
            }
        }
        return out
    }

    @androidx.compose.runtime.Composable
    private fun OptionsDialog() {
        Dialog(onDismissRequest = { showOptions = false }) {
            Column(
                Modifier.widthIn(max = 480.dp).heightIn(max = 560.dp)
                    .background(NasSurface, RoundedCornerShape(16.dp)).padding(16.dp),
            ) {
                val modeLabel = getString(if (mode == SourceKind.HLS) R.string.player_mode_hls else R.string.player_mode_direct)
                Text("${getString(R.string.player_options)} · $modeLabel", style = MaterialTheme.typography.titleLarge, color = Color.White)
                LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
                    if (current.isVideo && transcodeEnabled) {
                        item { Header(getString(R.string.quality)) }
                        items(Quality.entries) { q ->
                            Choice(q.label, q == quality) { changeQuality(q) }
                        }
                    }
                    val audio = if (mode == SourceKind.HLS && serverAudio.size > 1) {
                        serverAudio.map { a -> TrackChoice(a.label ?: "Piste ${a.index + 1}", a.index == audioIndex) { changeServerAudio(a.index) } }
                    } else playerTracks(C.TRACK_TYPE_AUDIO)
                    if (audio.size > 1) {
                        item { Header(getString(R.string.audio)) }
                        items(audio) { c -> Choice(c.label, c.selected, c.apply) }
                    }
                    val subs = playerTracks(C.TRACK_TYPE_TEXT)
                    if (subs.isNotEmpty()) {
                        item { Header(getString(R.string.subtitles)) }
                        item {
                            val off = player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT) || subs.none { it.selected }
                            Choice(getString(R.string.subtitles_off), off) {
                                player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                                showOptions = false
                            }
                        }
                        items(subs) { c -> Choice(c.label, c.selected, c.apply) }
                    }
                }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun Header(text: String) {
        Text(text, color = NasOrange, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
    }

    @androidx.compose.runtime.Composable
    private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
        FocusRow(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
            Text((if (selected) "● " else "○ ") + label, color = Color.White)
        }
    }
}
