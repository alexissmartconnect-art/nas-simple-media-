package com.nassimplemedia.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable

@Composable
fun AppContent(nav: NavViewModel) {
    AnimatedContent(targetState = nav.top, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "nav") { screen ->
        when (screen) {
            Screen.Servers -> ServersScreen(nav)
            is Screen.AddServer -> AddServerScreen(nav, screen.prefill)
            is Screen.Login -> LoginScreen(nav, screen.serverId)
            Screen.Home -> HomeScreen(nav)
            is Screen.LibraryView -> LibraryScreen(nav, screen.library)
            is Screen.Show -> ShowScreen(nav, screen.libraryId, screen.name)
            is Screen.Artist -> ArtistScreen(nav, screen.libraryId, screen.name)
            Screen.Search -> SearchScreen(nav)
            is Screen.Detail -> DetailScreen(nav, screen.mediaId)
            is Screen.Share -> ShareScreen(nav, screen.serverUrl, screen.token)
        }
    }
}
