package com.nassimplemedia.android.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID

@Serializable
data class ServerEntry(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val url: String,
    val username: String = "",
    /** Value of the `nas_sm_session` cookie. */
    val token: String? = null,
    /** Kept (encrypted) only if the user ticks "Se souvenir du mot de passe" — used to
     *  silently re-open the session after a server restart (sessions are in memory). */
    val password: String? = null,
    val lastUsed: Long = 0,
)

/**
 * Remembers several servers + their session in EncryptedSharedPreferences
 * (AES-256, key in the Android Keystore). Nothing is written in clear text:
 * if the Keystore is unusable the data simply stays in memory.
 */
class ServerStore(context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val prefs: SharedPreferences? = openPrefs(context.applicationContext)
    private var memory: List<ServerEntry> = load()

    private fun openPrefs(ctx: Context): SharedPreferences? {
        fun create(): SharedPreferences {
            val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                ctx, FILE, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
        return try {
            create()
        } catch (e: Exception) {
            Log.w("ServerStore", "Encrypted prefs unreadable, resetting", e)
            try {
                ctx.deleteSharedPreferences(FILE)
                create()
            } catch (e2: Exception) {
                Log.e("ServerStore", "Keystore unavailable — sessions kept in memory only", e2)
                null
            }
        }
    }

    private fun load(): List<ServerEntry> = try {
        prefs?.getString(KEY_SERVERS, null)?.let { json.decodeFromString<List<ServerEntry>>(it) } ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    @Synchronized
    fun all(): List<ServerEntry> = memory.sortedByDescending { it.lastUsed }

    @Synchronized
    fun get(id: String): ServerEntry? = memory.firstOrNull { it.id == id }

    @Synchronized
    fun upsert(entry: ServerEntry) {
        memory = memory.filterNot { it.id == entry.id } + entry
        persist()
    }

    @Synchronized
    fun remove(id: String) {
        memory = memory.filterNot { it.id == id }
        if (prefs?.getString(KEY_CURRENT, null) == id) prefs.edit().remove(KEY_CURRENT).apply()
        persist()
    }

    var currentId: String?
        get() = prefs?.getString(KEY_CURRENT, null) ?: memCurrent
        set(value) {
            memCurrent = value
            prefs?.edit()?.putString(KEY_CURRENT, value)?.apply()
        }
    private var memCurrent: String? = null

    private fun persist() {
        prefs?.edit()?.putString(KEY_SERVERS, json.encodeToString(memory))?.apply()
    }

    companion object {
        private const val FILE = "nas_servers_secure"
        private const val KEY_SERVERS = "servers"
        private const val KEY_CURRENT = "current"
    }
}
