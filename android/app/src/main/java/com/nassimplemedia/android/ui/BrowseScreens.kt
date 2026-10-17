package com.nassimplemedia.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.nassimplemedia.android.NasApp
import com.nassimplemedia.android.R
import com.nassimplemedia.android.data.Library
import com.nassimplemedia.android.data.MediaItem
import com.nassimplemedia.android.data.MediaSource
import com.nassimplemedia.android.data.Session
import com.nassimplemedia.android.player.PlayerLauncher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

fun thumbUrl(item: MediaItem): String? =
    if (item.isVideo) Session.absolute(MediaSource.Session.thumbPath(item.id)) else null

fun subtitleOf(item: MediaItem): String? = when (item.type) {
    "episode" -> item.title.takeIf { it != item.showName }
    "track" -> listOfNotNull(item.artist, item.album).joinToString(" · ")
    else -> null
}

private data class HomeData(val libs: List<Library>, val cont: List<MediaItem>, val recent: List<MediaItem>)

@Composable
fun HomeScreen(nav: NavViewModel) {
    val app = NasApp.instance
    val server = app.current()
    val scope = rememberCoroutineScope()
    val (state, retry) = rememberLoad(server?.id, onAuthExpired = { nav.sessionExpired() }) {
        val api = app.api
        val me = api.me()
        if (!me.authenticated) {
            // Session lost (server restarted): try the saved password once.
            if (api.reauth?.invoke() != true) throw com.nassimplemedia.android.data.AuthExpiredException()
        }
        HomeData(api.libraries(), runCatching { api.continueWatching() }.getOrDefault(emptyList()),
            runCatching { api.recentlyAdded() }.getOrDefault(emptyList()))
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(server?.name ?: stringResource(R.string.app_name), onBack = null) {
            IconButton(onClick = { nav.go(Screen.Search) }) { Icon(Icons.Filled.Search, stringResource(R.string.search)) }
            IconButton(onClick = { nav.reset(Screen.Servers) }) { Icon(Icons.Filled.Dns, stringResource(R.string.change_server)) }
            IconButton(onClick = {
                scope.launch {
                    app.api.logout()
                    app.current()?.let { app.store.upsert(it.copy(token = null, password = null)) }
                    Session.token = null
                    nav.reset(Screen.Servers)
                }
            }) { Icon(Icons.AutoMirrored.Filled.Logout, stringResource(R.string.logout)) }
        }
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> {
                val d = s.data
                val first = remember { FocusRequester() }
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
                    item {
                        PosterRow(stringResource(R.string.home_continue), d.cont) { item ->
                            PosterCard(
                                title = item.displayTitle,
                                subtitle = item.positionMs?.let { formatTime(it) },
                                imageUrl = thumbUrl(item),
                                progress = item.progressRatio?.toFloat(),
                                fallbackIcon = iconFor(item.kind),
                                onClick = { nav.go(Screen.Detail(item.id)) },
                            )
                        }
                    }
                    item {
                        SectionTitle(stringResource(R.string.home_libraries))
                        if (d.libs.isEmpty()) {
                            Text(stringResource(R.string.home_empty), modifier = Modifier.padding(16.dp))
                        }
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(d.libs) { lib ->
                                val mod = if (lib == d.libs.first()) Modifier.focusRequester(first) else Modifier
                                PosterCard(
                                    title = lib.name,
                                    subtitle = stringResource(R.string.items_count, lib.itemCount),
                                    imageUrl = null,
                                    aspect = 2f,
                                    fallbackIcon = iconFor(lib.type),
                                    onClick = { nav.go(Screen.LibraryView(lib)) },
                                    modifier = mod,
                                )
                            }
                        }
                    }
                    item {
                        PosterRow(stringResource(R.string.home_recent), d.recent) { item ->
                            PosterCard(
                                title = item.displayTitle,
                                subtitle = subtitleOf(item),
                                imageUrl = thumbUrl(item),
                                fallbackIcon = iconFor(item.kind),
                                onClick = { nav.go(Screen.Detail(item.id)) },
                            )
                        }
                    }
                }
                if (LocalIsTv.current && d.libs.isNotEmpty()) {
                    LaunchedEffect(Unit) { delay(150); runCatching { first.requestFocus() } }
                }
            }
        }
    }
}

@Composable
fun MediaGrid(items: List<MediaItem>, nav: NavViewModel, header: (@Composable () -> Unit)? = null) {
    val tv = LocalIsTv.current
    LazyVerticalGrid(
        columns = GridCells.Adaptive(if (tv) 220.dp else 150.dp),
        contentPadding = PaddingValues(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (header != null) item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) { header() }
        items(items, key = { it.id }) { item ->
            PosterCard(
                title = item.displayTitle,
                subtitle = subtitleOf(item),
                imageUrl = thumbUrl(item),
                fallbackIcon = iconFor(item.kind),
                width = if (tv) 220.dp else 200.dp,
                modifier = Modifier.fillMaxWidth(),
                onClick = { nav.go(Screen.Detail(item.id)) },
            )
        }
    }
}

@Composable
fun LibraryScreen(nav: NavViewModel, library: Library) {
    val api = NasApp.instance.api
    var sort by remember { mutableStateOf("title") }
    Column(Modifier.fillMaxSize()) {
        TopBar(library.name, onBack = { nav.back() }) {
            IconButton(onClick = { nav.go(Screen.Search) }) { Icon(Icons.Filled.Search, stringResource(R.string.search)) }
        }
        when (library.type) {
            "series" -> {
                val (state, retry) = rememberLoad(library.id, onAuthExpired = { nav.sessionExpired() }) { api.series(library.id) }
                when (val s = state) {
                    Load.Loading -> LoadingBox()
                    is Load.Error -> ErrorBox(s.message, retry)
                    is Load.Ok -> {
                        val tv = LocalIsTv.current
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(if (tv) 220.dp else 150.dp),
                            contentPadding = PaddingValues(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(s.data, key = { it.name }) { show ->
                                PosterCard(
                                    title = show.name,
                                    subtitle = stringResource(R.string.seasons_count, show.seasons, show.episodes),
                                    imageUrl = show.posterMediaId?.let { Session.absolute(MediaSource.Session.thumbPath(it)) },
                                    fallbackIcon = iconFor("series"),
                                    modifier = Modifier.fillMaxWidth(),
                                    onClick = { nav.go(Screen.Show(library.id, show.name)) },
                                )
                            }
                        }
                    }
                }
            }
            "music" -> {
                val (state, retry) = rememberLoad(library.id, onAuthExpired = { nav.sessionExpired() }) { api.artists(library.id) }
                when (val s = state) {
                    Load.Loading -> LoadingBox()
                    is Load.Error -> ErrorBox(s.message, retry)
                    is Load.Ok -> LazyColumn(
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(s.data, key = { it.name }) { artist ->
                            FocusRow(onClick = { nav.go(Screen.Artist(library.id, artist.name)) }) {
                                Column {
                                    Text(artist.name, style = MaterialTheme.typography.titleMedium)
                                    Text(stringResource(R.string.albums_count, artist.albums, artist.tracks), color = Color(0xFFAAAAAA))
                                }
                            }
                        }
                    }
                }
            }
            else -> {
                val (state, retry) = rememberLoad(library.id, sort, onAuthExpired = { nav.sessionExpired() }) {
                    api.media(libraryId = library.id, sort = sort, limit = 1000).items
                }
                when (val s = state) {
                    Load.Loading -> LoadingBox()
                    is Load.Error -> ErrorBox(s.message, retry)
                    is Load.Ok -> MediaGrid(s.data, nav, header = {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("title" to "A → Z", "added" to "Ajouts récents", "size" to "Taille").forEach { (k, label) ->
                                FilterChip(selected = sort == k, onClick = { sort = k }, label = { Text(label) })
                            }
                        }
                    })
                }
            }
        }
    }
}

@Composable
fun ShowScreen(nav: NavViewModel, libraryId: Int, name: String) {
    val api = NasApp.instance.api
    val (state, retry) = rememberLoad(libraryId, name, onAuthExpired = { nav.sessionExpired() }) {
        api.media(libraryId = libraryId, show = name, limit = 1000).items
    }
    var season by remember { mutableStateOf<Int?>(null) }
    Column(Modifier.fillMaxSize()) {
        TopBar(name, onBack = { nav.back() })
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> {
                val bySeason = s.data.groupBy { it.season ?: -1 }.toSortedMap()
                val current = season ?: bySeason.keys.firstOrNull { it >= 0 } ?: bySeason.keys.firstOrNull()
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(bySeason.keys.toList()) { k ->
                        FilterChip(
                            selected = k == current,
                            onClick = { season = k },
                            label = { Text(if (k >= 0) stringResource(R.string.season_n, k) else stringResource(R.string.season_unknown)) },
                        )
                    }
                }
                val episodes = (bySeason[current] ?: emptyList()).sortedWith(compareBy({ it.episode ?: Int.MAX_VALUE }, { it.title }))
                LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(episodes, key = { it.id }) { ep ->
                        FocusRow(onClick = { nav.go(Screen.Detail(ep.id)) }) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AsyncImage(
                                    model = thumbUrl(ep), contentDescription = null,
                                    modifier = Modifier.size(width = 128.dp, height = 72.dp),
                                    contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                )
                                Spacer(Modifier.size(12.dp))
                                Column {
                                    Text(
                                        ep.episode?.let { "E%02d · ".format(it) }.orEmpty() + ep.title,
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                    Text(ep.filename, color = Color(0xFF888888), maxLines = 1)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ArtistScreen(nav: NavViewModel, libraryId: Int, name: String) {
    val api = NasApp.instance.api
    val ctx = LocalContext.current
    val (state, retry) = rememberLoad(libraryId, name, onAuthExpired = { nav.sessionExpired() }) {
        api.media(libraryId = libraryId, artist = name, limit = 1000).items
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(name, onBack = { nav.back() })
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> {
                val unknown = stringResource(R.string.album_unknown)
                val albums = s.data.groupBy { it.album ?: unknown }.toSortedMap()
                LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    albums.forEach { (album, tracksRaw) ->
                        val tracks = tracksRaw.sortedWith(compareBy({ it.trackNum ?: Int.MAX_VALUE }, { it.title }))
                        item(key = "h-$album") {
                            Row(Modifier.fillMaxWidth().padding(top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(album, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                NasButton(stringResource(R.string.play_all), {
                                    PlayerLauncher.play(ctx, Session.baseUrl!!, tracks, 0)
                                }, primary = false)
                            }
                        }
                        items(tracks, key = { it.id }) { t ->
                            FocusRow(onClick = { PlayerLauncher.play(ctx, Session.baseUrl!!, tracks, tracks.indexOf(t)) }) {
                                Text((t.trackNum?.let { "$it. " } ?: "") + t.title)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SearchScreen(nav: NavViewModel) {
    val api = NasApp.instance.api
    var q by remember { mutableStateOf("") }
    var debounced by remember { mutableStateOf("") }
    LaunchedEffect(q) { delay(350); debounced = q.trim() }
    val (state, retry) = rememberLoad(debounced, onAuthExpired = { nav.sessionExpired() }) {
        if (debounced.length < 2) emptyList() else api.media(q = debounced, limit = 200).items
    }
    val focus = remember { FocusRequester() }
    Column(Modifier.fillMaxSize()) {
        TopBar(stringResource(R.string.search), onBack = { nav.back() })
        OutlinedTextField(
            value = q, onValueChange = { q = it },
            placeholder = { Text(stringResource(R.string.search_hint)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).focusRequester(focus),
        )
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
        when (val s = state) {
            Load.Loading -> LoadingBox()
            is Load.Error -> ErrorBox(s.message, retry)
            is Load.Ok -> if (s.data.isEmpty() && debounced.length >= 2) {
                Text(stringResource(R.string.search_empty), modifier = Modifier.padding(16.dp))
            } else {
                MediaGrid(s.data, nav)
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}
