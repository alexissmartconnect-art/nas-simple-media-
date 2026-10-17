package com.nassimplemedia.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import coil.compose.AsyncImage
import com.nassimplemedia.android.NasApp
import com.nassimplemedia.android.R
import com.nassimplemedia.android.data.MediaItem
import com.nassimplemedia.android.data.MediaSource
import com.nassimplemedia.android.data.Quality
import com.nassimplemedia.android.data.Session
import com.nassimplemedia.android.data.ShareInfo
import com.nassimplemedia.android.player.PlayerLauncher
import com.nassimplemedia.android.player.PlayerPrefs
import kotlinx.coroutines.delay

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DetailScreen(nav: NavViewModel, mediaId: Int) {
    val app = NasApp.instance
    val ctx = LocalContext.current
    // Reload when coming back from the player so the resume point is fresh.
    var refresh by remember { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        var first = true
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            if (!first) refresh++
            first = false
        }
    }
    val (state, retry) = rememberLoad(mediaId, refresh, onAuthExpired = { nav.sessionExpired() }) { app.api.detail(mediaId) }
    var quality by remember { mutableStateOf(PlayerPrefs.quality(ctx)) }
    val playFocus = remember { FocusRequester() }

    Column(Modifier.fillMaxSize()) {
        TopBar("", onBack = { nav.back() })
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> {
                val d = s.data
                val item = MediaItem(
                    id = d.id, libraryId = d.libraryId, filename = d.filename, title = d.title, type = d.type,
                    kind = d.kind, showName = d.showName, season = d.season, episode = d.episode,
                    artist = d.artist, album = d.album, sizeBytes = d.sizeBytes, playback = d.playback,
                )
                val resume = d.progress?.takeIf { !it.watched && it.positionMs > 10_000 }?.positionMs
                fun play(startMs: Long) = PlayerLauncher.play(
                    ctx, Session.baseUrl!!, listOf(item), 0, startMs, d.transcodeEnabled,
                )
                Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                    if (item.isVideo) {
                        AsyncImage(
                            model = Session.absolute(MediaSource.Session.thumbPath(d.id)),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.width(if (LocalIsTv.current) 420.dp else 160.dp).aspectRatio(16f / 9f),
                        )
                        Spacer(Modifier.width(16.dp))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(item.displayTitle, style = MaterialTheme.typography.headlineSmall)
                        if (d.type == "episode" && d.title.isNotBlank()) Text(d.title, color = Color(0xFFCCCCCC))
                        if (d.type == "track") Text(listOfNotNull(d.artist, d.album).joinToString(" · "), color = Color(0xFFCCCCCC))
                        d.summary?.let { sum ->
                            Text(listOfNotNull(sum.videoLabel, sum.durationMs?.let { formatTime(it) }).joinToString(" · "), color = Color(0xFFAAAAAA))
                            if (sum.audioLabels.isNotEmpty()) Text("${stringResource(R.string.audio)} : ${sum.audioLabels.joinToString(", ")}", color = Color(0xFFAAAAAA))
                            if (sum.subtitleLabels.isNotEmpty()) Text("${stringResource(R.string.subtitles)} : ${sum.subtitleLabels.joinToString(", ")}", color = Color(0xFFAAAAAA))
                        }
                        Text(stringResource(R.string.size, formatSize(d.sizeBytes)), color = Color(0xFF888888))
                        if (d.progress?.watched == true) Text("✓ " + stringResource(R.string.watched), color = NasOrange)
                        Spacer(Modifier.height(8.dp))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (resume != null) {
                                NasButton(stringResource(R.string.resume_at, formatTime(resume)), { play(resume) }, Modifier.focusRequester(playFocus))
                                NasButton(stringResource(R.string.play_from_start), { play(0) }, primary = false)
                            } else {
                                NasButton(stringResource(R.string.play), { play(0) }, Modifier.focusRequester(playFocus))
                            }
                        }
                        if (item.isVideo) {
                            if (d.transcodeEnabled) {
                                Text(stringResource(R.string.quality), style = MaterialTheme.typography.titleSmall)
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Quality.entries.forEach { q ->
                                        FilterChip(selected = q == quality, onClick = {
                                            quality = q
                                            PlayerPrefs.setQuality(ctx, q)
                                        }, label = { Text(q.label) })
                                    }
                                }
                            } else {
                                Text(stringResource(R.string.transcode_off), color = Color(0xFFAAAAAA))
                            }
                        }
                    }
                }
                LaunchedEffect(d.id) { delay(100); runCatching { playFocus.requestFocus() } }
            }
        }
    }
}

@Composable
fun ShareScreen(nav: NavViewModel, serverUrl: String, token: String) {
    val api = NasApp.instance.api
    val ctx = LocalContext.current
    var password by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf<String?>(null) }
    val (state, retry) = rememberLoad(serverUrl, token, submitted, onAuthExpired = {}) {
        api.share(serverUrl, token, submitted)
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(stringResource(R.string.share_title), onBack = { if (!nav.back()) nav.reset(Screen.Servers) })
        Text(stringResource(R.string.share_guest) + " · " + serverUrl, color = Color(0xFF999999), modifier = Modifier.padding(horizontal = 16.dp))
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> {
                val info: ShareInfo = s.data
                if (info.needsPassword) {
                    Column(Modifier.padding(16.dp).widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(info.shareTitle ?: info.title ?: "", style = MaterialTheme.typography.titleLarge)
                        Text(stringResource(R.string.share_password_needed))
                        OutlinedTextField(
                            value = password, onValueChange = { password = it },
                            label = { Text(stringResource(R.string.login_password)) },
                            singleLine = true, visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        NasButton(stringResource(R.string.share_open), { submitted = password })
                    }
                } else {
                    val src = MediaSource.Share(token, submitted)
                    val tv = LocalIsTv.current
                    Text(info.shareTitle ?: "", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(if (tv) 220.dp else 150.dp),
                        contentPadding = PaddingValues(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(info.items, key = { it.id }) { item ->
                            PosterCard(
                                title = item.displayTitle,
                                subtitle = subtitleOf(item),
                                imageUrl = if (item.isVideo) serverUrl.trimEnd('/') + src.thumbPath(item.id) else null,
                                fallbackIcon = iconFor(item.kind),
                                modifier = Modifier.fillMaxWidth(),
                                onClick = {
                                    val queue = if (item.isVideo) listOf(item) else info.items.filter { !it.isVideo }
                                    PlayerLauncher.play(
                                        ctx, serverUrl, queue, queue.indexOf(item).coerceAtLeast(0), 0,
                                        info.transcodeEnabled, shareToken = token, sharePassword = submitted,
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
        Box(Modifier.height(8.dp))
    }
}
