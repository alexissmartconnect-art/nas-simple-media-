package com.nassimplemedia.android.ui

import androidx.compose.runtime.mutableStateListOf
import androidx.lifecycle.ViewModel
import com.nassimplemedia.android.NasApp
import com.nassimplemedia.android.data.Library

sealed interface Screen {
    data object Servers : Screen
    data class AddServer(val prefill: String = "") : Screen
    data class Login(val serverId: String) : Screen
    data object Home : Screen
    data class LibraryView(val library: Library) : Screen
    data class Show(val libraryId: Int, val name: String) : Screen
    data class Artist(val libraryId: Int, val name: String) : Screen
    data object Search : Screen
    data class Detail(val mediaId: Int) : Screen
    data class Share(val serverUrl: String, val token: String) : Screen
}

class NavViewModel : ViewModel() {
    val stack = mutableStateListOf<Screen>()

    init {
        val app = NasApp.instance
        val cur = app.current()
        stack += when {
            cur == null -> Screen.Servers
            cur.token == null -> Screen.Login(cur.id)
            else -> Screen.Home
        }
    }

    val top: Screen get() = stack.last()

    fun go(s: Screen) { stack += s }

    fun back(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    fun reset(s: Screen) {
        stack.clear()
        stack += s
    }

    fun sessionExpired() {
        val app = NasApp.instance
        app.clearSession()
        val cur = app.current()
        reset(Screen.Servers)
        if (cur != null) go(Screen.Login(cur.id))
    }
}
