package com.nassimplemedia.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String) : IOException(message)

/**
 * The account still uses the factory password (`changeme`): the server refuses
 * everything until it is changed. The app does not offer that form; the user
 * is told to change it in the web interface, then log in again.
 */
class PasswordChangeRequiredException(message: String) : IOException(message)

const val PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"

fun passwordChangeMessage(base: String): String =
    "Ce compte utilise encore le mot de passe par défaut. Pour votre sécurité, changez-le d’abord " +
        "dans l’interface web (${base.trimEnd('/')}/login.html), puis reconnectez-vous ici avec le nouveau mot de passe."

class AuthExpiredException : IOException("Session expirée — reconnectez-vous")

/**
 * Current server + session, shared by the API client, Coil (posters) and
 * ExoPlayer: the interceptor adds `Cookie: nas_sm_session=…` only to requests
 * going to the active server.
 */
object Session {
    const val COOKIE_NAME = "nas_sm_session"

    @Volatile var baseUrl: String? = null
    @Volatile var token: String? = null

    val interceptor = Interceptor { chain ->
        val req = chain.request()
        val base = baseUrl?.toHttpUrlOrNull()
        val tok = token
        if (tok != null && base != null && req.url.host == base.host && req.url.port == base.port &&
            req.header("Cookie") == null
        ) {
            chain.proceed(req.newBuilder().header("Cookie", "$COOKIE_NAME=$tok").build())
        } else {
            chain.proceed(req)
        }
    }

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(interceptor)
            .addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().header("User-Agent", "NASMedia-Android/0.1").build())
            }
            .build()
    }

    fun absolute(path: String): String = (baseUrl ?: "").trimEnd('/') + path
}

class ApiClient(private val client: OkHttpClient = Session.http) {
    val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** Called on 401 to silently re-open a session (saved password). Returns true on success. */
    var reauth: (suspend () -> Boolean)? = null

    private fun url(base: String, path: String) = base.trimEnd('/') + path

    private suspend fun exec(req: Request): Response = withContext(Dispatchers.IO) { client.newCall(req).execute() }

    private suspend fun getRaw(path: String, base: String? = Session.baseUrl, allowReauth: Boolean = true): String {
        val b = base ?: throw IOException("Aucun serveur sélectionné")
        exec(Request.Builder().url(url(b, path)).get().build()).use { r ->
            val body = r.body?.string().orEmpty()
            if (r.code == 401 && allowReauth && reauth != null && b == Session.baseUrl) {
                if (reauth?.invoke() == true) return getRaw(path, base, false)
                throw AuthExpiredException()
            }
            if (r.code == 401 && b == Session.baseUrl && path.startsWith("/api/") && !path.startsWith("/api/public/")) {
                throw AuthExpiredException()
            }
            if (r.code == 403 && codeOf(body) == PASSWORD_CHANGE_REQUIRED) {
                throw PasswordChangeRequiredException(passwordChangeMessage(b))
            }
            if (!r.isSuccessful) throw ApiException(r.code, errorOf(body, r.code))
            return body
        }
    }

    private fun codeOf(body: String): String? = try {
        json.decodeFromString<ErrorBody>(body).code
    } catch (_: Exception) {
        null
    }

    private suspend inline fun <reified T> get(path: String, base: String? = Session.baseUrl): T =
        json.decodeFromString(getRaw(path, base))

    private fun errorOf(body: String, code: Int): String = try {
        json.decodeFromString<ErrorBody>(body).error ?: "Erreur HTTP $code"
    } catch (_: Exception) {
        "Erreur HTTP $code"
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    // ---- Server discovery / auth ----

    /** Checks that `base` answers like a NAS Simple Media server. */
    suspend fun probeServer(base: String): SetupStatus = try {
        get("/api/setup/status", base)
    } catch (e: ApiException) {
        throw IOException("Ce n’est pas un serveur NAS Simple Media (HTTP ${e.code})")
    } catch (e: kotlinx.serialization.SerializationException) {
        throw IOException("Réponse inattendue : ce n’est pas un serveur NAS Simple Media")
    }

    /** POST /api/login → returns (user, session token from Set-Cookie). */
    suspend fun login(base: String, username: String, password: String): Pair<User, String> {
        val body = json.encodeToString(buildJsonObject {
            put("username", username)
            put("password", password)
        })
        val req = Request.Builder().url(url(base, "/api/login")).post(body.toRequestBody(jsonType)).build()
        exec(req).use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw ApiException(r.code, errorOf(text, r.code))
            val token = r.headers("Set-Cookie")
                .firstNotNullOfOrNull { parseCookie(it, Session.COOKIE_NAME) }
                ?: throw IOException("Le serveur n’a pas renvoyé de session")
            val parsed = json.decodeFromString<LoginResponse>(text)
            val user = parsed.user ?: throw IOException("Réponse de connexion invalide")
            if (parsed.mustChangePassword || user.mustChangePassword) {
                // Do not keep a session that can do nothing; ask for the change on the web.
                runCatching {
                    exec(
                        Request.Builder().url(url(base, "/api/logout"))
                            .header("Cookie", "${Session.COOKIE_NAME}=$token")
                            .post("{}".toRequestBody(jsonType)).build()
                    ).close()
                }
                throw PasswordChangeRequiredException(passwordChangeMessage(base))
            }
            return user to token
        }
    }

    suspend fun logout() {
        val b = Session.baseUrl ?: return
        runCatching {
            exec(Request.Builder().url(url(b, "/api/logout")).post("{}".toRequestBody(jsonType)).build()).close()
        }
    }

    suspend fun me(): MeResponse = get("/api/me")

    // ---- Browsing ----
    suspend fun libraries(): List<Library> = get<LibrariesResponse>("/api/libraries").libraries
    suspend fun continueWatching(): List<MediaItem> = get<ItemsResponse>("/api/continue-watching?limit=20").items
    suspend fun recentlyAdded(): List<MediaItem> = get<ItemsResponse>("/api/recently-added?limit=30").items

    suspend fun media(
        libraryId: Int? = null,
        q: String? = null,
        show: String? = null,
        artist: String? = null,
        album: String? = null,
        sort: String? = null,
        limit: Int = 500,
        offset: Int = 0,
    ): MediaListResponse {
        val p = mutableListOf("limit=$limit", "offset=$offset")
        libraryId?.let { p += "library_id=$it" }
        q?.takeIf { it.isNotBlank() }?.let { p += "q=${enc(it)}" }
        show?.let { p += "show=${enc(it)}" }
        artist?.let { p += "artist=${enc(it)}" }
        album?.let { p += "album=${enc(it)}" }
        sort?.let { p += "sort=$it" }
        return get("/api/media?" + p.joinToString("&"))
    }

    suspend fun series(libraryId: Int): List<Show> = get<ShowsResponse>("/api/series?library_id=$libraryId").shows
    suspend fun artists(libraryId: Int): List<Artist> = get<ArtistsResponse>("/api/artists?library_id=$libraryId").artists
    suspend fun detail(id: Int): MediaDetail = get("/api/media/$id")

    suspend fun saveProgress(id: Int, positionMs: Long, durationMs: Long) {
        val b = Session.baseUrl ?: return
        val body = json.encodeToString(buildJsonObject {
            put("positionMs", positionMs)
            put("durationMs", durationMs)
        })
        exec(Request.Builder().url(url(b, "/api/media/$id/progress")).post(body.toRequestBody(jsonType)).build()).close()
    }

    // ---- Guest shares ----
    /** Share info. [accessToken] comes from [unlockShare]; the password never goes in a URL. */
    suspend fun share(base: String, token: String, accessToken: String?): ShareInfo {
        val qs = if (accessToken.isNullOrEmpty()) "" else "?access=${enc(accessToken)}"
        return get("/api/public/share/${enc(token)}$qs", base)
    }

    /** POSTs the share password once and returns the short-lived signed access token. */
    suspend fun unlockShare(base: String, token: String, password: String): String? {
        val body = json.encodeToString(buildJsonObject { put("password", password) })
        val req = Request.Builder().url(url(base, "/api/public/share/${enc(token)}/unlock"))
            .post(body.toRequestBody(jsonType)).build()
        exec(req).use { r ->
            val text = r.body?.string().orEmpty()
            if (r.code == 404) throw ApiException(404, "Serveur trop ancien : mettez NAS Simple Media à jour (1.6+)")
            if (!r.isSuccessful) throw ApiException(r.code, errorOf(text, r.code))
            return json.decodeFromString<ShareUnlock>(text).accessToken
        }
    }

    suspend fun streams(base: String, path: String): StreamsInfo = get(path, base)

    // ---- HLS ----
    /**
     * Starts (or reuses) the server transcode and waits until the playlist has at
     * least one segment (the server answers 202 meanwhile). Returns the absolute
     * playlist URL to hand to ExoPlayer.
     */
    suspend fun startHls(base: String, startPath: String, timeoutMs: Long = 90_000): String {
        val start: HlsStart = get(startPath, base)
        val rel = start.playlistUrl ?: throw IOException(start.error ?: "Transcodage indisponible")
        val playlist = url(base, rel)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val code = exec(Request.Builder().url(playlist).get().build()).use { r -> r.code }
            when (code) {
                200 -> return playlist
                202 -> delay(1500)
                401 -> throw AuthExpiredException()
                else -> throw ApiException(code, "Lecture HLS impossible (HTTP $code)")
            }
        }
        throw IOException("Le transcodage met trop de temps à démarrer")
    }

    companion object {
        fun parseCookie(header: String, name: String): String? =
            header.split(';').map { it.trim() }.firstOrNull { it.startsWith("$name=") }
                ?.substringAfter('=')?.takeIf { it.isNotEmpty() }
    }
}
