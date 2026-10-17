package com.nassimplemedia.android

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import com.nassimplemedia.android.data.ApiClient
import com.nassimplemedia.android.data.ServerEntry
import com.nassimplemedia.android.data.ServerStore
import com.nassimplemedia.android.data.Session

class NasApp : Application(), ImageLoaderFactory {
    lateinit var store: ServerStore
        private set
    val api = ApiClient()
    /** Outlives activities (e.g. last progress save when the player closes). */
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate() {
        super.onCreate()
        instance = this
        store = ServerStore(this)
        store.currentId?.let { id -> store.get(id)?.let { activate(it) } }
    }

    /** Posters/thumbnails go through the same OkHttp client (session cookie, Tailscale, https). */
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this).okHttpClient(Session.http).crossfade(true).build()

    fun activate(entry: ServerEntry) {
        Session.baseUrl = entry.url
        Session.token = entry.token
        store.currentId = entry.id
        store.upsert(entry.copy(lastUsed = System.currentTimeMillis()))
        api.reauth = reauth@{
            val current = store.get(entry.id) ?: return@reauth false
            val pw = current.password ?: return@reauth false
            runCatching {
                val (_, token) = api.login(current.url, current.username, pw)
                Session.token = token
                store.upsert(current.copy(token = token))
            }.isSuccess
        }
    }

    fun current(): ServerEntry? = store.currentId?.let { store.get(it) }

    fun clearSession() {
        current()?.let { store.upsert(it.copy(token = null)) }
        Session.token = null
    }

    companion object {
        lateinit var instance: NasApp
            private set
    }
}
