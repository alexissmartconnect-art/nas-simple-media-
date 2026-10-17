package com.nassimplemedia.android.ui

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.nassimplemedia.android.R
import com.nassimplemedia.android.data.AuthExpiredException
import androidx.tv.material3.Card as TvCard
import androidx.tv.material3.CardDefaults as TvCardDefaults
import androidx.tv.material3.Border as TvBorder
import androidx.compose.material3.Card as PhoneCard

val NasOrange = Color(0xFFF97316)
val NasBg = Color(0xFF0F1115)
val NasSurface = Color(0xFF1A1D24)

/** True on Android TV / Google TV: D-pad first UI with Compose for TV cards. */
val LocalIsTv = compositionLocalOf { false }

fun Context.isTelevision(): Boolean {
    val ui = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
    return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
}

@Composable
fun NasTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = NasOrange,
            onPrimary = Color.Black,
            background = NasBg,
            surface = NasSurface,
            surfaceVariant = Color(0xFF252A33),
        ),
        content = content,
    )
}

/** Visible focus ring for D-pad navigation (TV) on any clickable element. */
@Composable
fun Modifier.focusRing(shape: RoundedCornerShape = RoundedCornerShape(10.dp)): Modifier {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    return this
        .border(if (focused) 3.dp else 0.dp, if (focused) NasOrange else Color.Transparent, shape)
        .focusable(interactionSource = source)
}

@Composable
fun FocusRow(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (focused) Color(0xFF2B303B) else NasSurface)
            .border(if (focused) 2.dp else 0.dp, if (focused) NasOrange else Color.Transparent, shape)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) { content() }
}

@Composable
fun NasButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = true, enabled: Boolean = true) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val ring = Modifier.border(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent, RoundedCornerShape(50))
    if (primary) {
        Button(onClick = onClick, enabled = enabled, modifier = modifier.then(ring), interactionSource = source) { Text(text) }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.then(ring), interactionSource = source,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)) { Text(text) }
    }
}

@Composable
fun TopBar(title: String, onBack: (() -> Unit)?, actions: @Composable () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null && !LocalIsTv.current) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) }
        } else {
            Spacer(Modifier.width(12.dp))
        }
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp),
    )
}

/**
 * Poster / thumbnail card. On TV it is a Compose-for-TV Card (focus scale +
 * orange border), on phones a regular touch Material card.
 */
@Composable
fun PosterCard(
    title: String,
    subtitle: String?,
    imageUrl: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = if (LocalIsTv.current) 220.dp else 160.dp,
    aspect: Float = 16f / 9f,
    progress: Float? = null,
    fallbackIcon: ImageVector = Icons.Filled.Movie,
) {
    val content: @Composable () -> Unit = {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(aspect).background(Color(0xFF252A33))) {
                if (imageUrl != null) {
                    SubcomposeAsyncImage(
                        model = imageUrl,
                        contentDescription = title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                        error = { Placeholder(fallbackIcon) },
                        loading = { Placeholder(fallbackIcon) },
                    )
                } else {
                    Placeholder(fallbackIcon)
                }
                if (progress != null && progress > 0f) {
                    LinearProgressIndicator(
                        progress = { progress.coerceIn(0f, 1f) },
                        color = NasOrange,
                        trackColor = Color(0x66000000),
                        modifier = Modifier.fillMaxWidth().height(4.dp).align(Alignment.BottomCenter),
                    )
                }
            }
            Column(Modifier.padding(8.dp)) {
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Color.White)
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = Color(0xFFAAAAAA))
                }
            }
        }
    }
    if (LocalIsTv.current) {
        TvCard(
            onClick = onClick,
            modifier = modifier.width(width),
            scale = TvCardDefaults.scale(focusedScale = 1.06f),
            border = TvCardDefaults.border(
                focusedBorder = TvBorder(androidx.compose.foundation.BorderStroke(3.dp, NasOrange)),
            ),
            colors = TvCardDefaults.colors(containerColor = NasSurface, focusedContainerColor = Color(0xFF2B303B)),
        ) { content() }
    } else {
        PhoneCard(onClick = onClick, modifier = modifier.width(width)) { content() }
    }
}

@Composable
private fun Placeholder(icon: ImageVector) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Color(0xFF555B66), modifier = Modifier.size(40.dp))
    }
}

fun iconFor(kind: String): ImageVector = when (kind) {
    "music", "track" -> Icons.Filled.MusicNote
    "series", "episode" -> Icons.Filled.Tv
    else -> Icons.Filled.Movie
}

@Composable
fun <T> PosterRow(title: String, items: List<T>, card: @Composable (T) -> Unit) {
    if (items.isEmpty()) return
    SectionTitle(title)
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(if (LocalIsTv.current) 20.dp else 12.dp),
    ) {
        items(items) { card(it) }
    }
}

@Composable
fun LoadingBox(text: String = stringResource(R.string.loading)) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        CircularProgressIndicator(color = NasOrange)
        Spacer(Modifier.height(12.dp))
        Text(text)
    }
}

@Composable
fun ErrorBox(message: String, onRetry: (() -> Unit)?) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(stringResource(R.string.error_generic, message), color = Color(0xFFFF8A80))
        if (onRetry != null) {
            Spacer(Modifier.height(12.dp))
            NasButton(stringResource(R.string.retry), onRetry)
        }
    }
}

sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Error(val message: String) : Load<Nothing>
    data class Ok<T>(val data: T) : Load<T>
}

/** Runs [block] when [key] changes or on retry; session expiry bubbles up to [onAuthExpired]. */
@Composable
fun <T> rememberLoad(vararg key: Any?, onAuthExpired: () -> Unit, block: suspend () -> T): Pair<Load<T>, () -> Unit> {
    var state by remember(*key) { mutableStateOf<Load<T>>(Load.Loading) }
    var attempt by remember(*key) { mutableIntStateOf(0) }
    LaunchedEffect(*key, attempt) {
        state = Load.Loading
        state = try {
            Load.Ok(block())
        } catch (e: AuthExpiredException) {
            onAuthExpired()
            Load.Error(e.message ?: "")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Error(e.message ?: e.javaClass.simpleName)
        }
    }
    return state to { attempt++ }
}

fun formatTime(ms: Long): String {
    val s = ms / 1000
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

fun formatSize(bytes: Long): String = when {
    bytes >= 1L shl 30 -> "%.1f Go".format(bytes / (1L shl 30).toDouble())
    bytes >= 1L shl 20 -> "%.0f Mo".format(bytes / (1L shl 20).toDouble())
    else -> "%d Ko".format(bytes / 1024)
}
