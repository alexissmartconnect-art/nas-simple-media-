package com.nassimplemedia.android.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import com.nassimplemedia.android.data.ServerUrls

class MainActivity : ComponentActivity() {
    private val nav: NavViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = isTelevision()
        if (savedInstanceState == null) handleIntent(intent)
        setContent {
            NasTheme {
                CompositionLocalProvider(LocalIsTv provides tv) {
                    Box(Modifier.fillMaxSize().background(NasBg).safeDrawingPadding()) {
                        BackHandler(enabled = nav.stack.size > 1) { nav.back() }
                        AppContent(nav)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** Share links (https://host/s/<token> or nasmedia://share?url=…) open in guest mode. */
    private fun handleIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val link = ServerUrls.parseShareLink(data) ?: return
        nav.go(Screen.Share(link.serverUrl, link.token))
    }
}
