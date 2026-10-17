package com.nassimplemedia.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.nassimplemedia.android.NasApp
import com.nassimplemedia.android.R
import com.nassimplemedia.android.data.ServerEntry
import com.nassimplemedia.android.data.ServerUrls
import kotlinx.coroutines.launch
import java.net.URI

@Composable
fun ServersScreen(nav: NavViewModel) {
    val app = NasApp.instance
    var servers by remember { mutableStateOf(app.store.all()) }
    var shareLink by remember { mutableStateOf("") }
    var shareError by remember { mutableStateOf<String?>(null) }
    val invalidShare = stringResource(R.string.share_link_invalid)

    Column(Modifier.fillMaxSize()) {
        TopBar(stringResource(R.string.servers_title), onBack = null)
        LazyColumn(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (servers.isEmpty()) {
                item { Text(stringResource(R.string.servers_empty), color = Color(0xFFBBBBBB)) }
            }
            items(servers, key = { it.id }) { s ->
                FocusRow(onClick = {
                    app.activate(s)
                    if (s.token != null) nav.reset(Screen.Home) else nav.go(Screen.Login(s.id))
                }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(s.name, style = MaterialTheme.typography.titleMedium)
                            Text(s.url, color = Color(0xFFAAAAAA))
                            Text(
                                if (s.token != null) stringResource(R.string.server_connected_as, s.username)
                                else stringResource(R.string.server_not_connected),
                                color = if (s.token != null) NasOrange else Color(0xFF888888),
                            )
                        }
                        TextButton(onClick = {
                            app.store.remove(s.id)
                            servers = app.store.all()
                        }) { Text(stringResource(R.string.server_remove)) }
                    }
                }
            }
            item {
                Spacer(Modifier.height(8.dp))
                NasButton(stringResource(R.string.server_add), { nav.go(Screen.AddServer()) })
            }
            item {
                Spacer(Modifier.height(24.dp))
                Text(stringResource(R.string.open_share_link), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = shareLink,
                    onValueChange = { shareLink = it; shareError = null },
                    placeholder = { Text(stringResource(R.string.share_link_hint)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    modifier = Modifier.fillMaxWidth().widthIn(max = 600.dp),
                    isError = shareError != null,
                    supportingText = { shareError?.let { Text(it) } },
                )
                NasButton(stringResource(R.string.share_open), {
                    val link = ServerUrls.parseShareLink(shareLink)
                    if (link == null) shareError = invalidShare else nav.go(Screen.Share(link.serverUrl, link.token))
                }, primary = false)
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}

@Composable
fun AddServerScreen(nav: NavViewModel, prefill: String) {
    val app = NasApp.instance
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(prefill) }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val normalized = ServerUrls.normalize(url)
    val invalid = stringResource(R.string.server_invalid)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar(stringResource(R.string.server_add), onBack = { nav.back() })
        Column(Modifier.padding(16.dp).widthIn(max = 640.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it; error = null },
                label = { Text(stringResource(R.string.server_url)) },
                placeholder = { Text(stringResource(R.string.server_url_hint)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
                supportingText = { normalized?.let { Text("→ $it") } },
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.server_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (normalized != null && ServerUrls.isInsecurePublic(normalized)) {
                Text(stringResource(R.string.server_insecure_warning), color = Color(0xFFFFC107))
            }
            error?.let { Text(it, color = Color(0xFFFF8A80)) }
            NasButton(
                stringResource(R.string.server_check),
                enabled = !busy,
                onClick = {
                    val target = normalized ?: run { error = invalid; return@NasButton }
                    busy = true
                    scope.launch {
                        try {
                            app.api.probeServer(target)
                            val existing = app.store.all().firstOrNull { it.url == target }
                            val entry = existing ?: ServerEntry(
                                name = name.ifBlank { runCatching { URI(target).host }.getOrNull() ?: target },
                                url = target,
                            )
                            app.store.upsert(entry)
                            app.activate(entry)
                            nav.go(Screen.Login(entry.id))
                        } catch (e: Exception) {
                            error = e.message ?: e.javaClass.simpleName
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
    }
}

@Composable
fun LoginScreen(nav: NavViewModel, serverId: String) {
    val app = NasApp.instance
    val server = app.store.get(serverId)
    if (server == null) {
        nav.reset(Screen.Servers)
        return
    }
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf(server.username) }
    var password by remember { mutableStateOf("") }
    var keepPassword by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val (setup, _) = rememberLoad(server.url, onAuthExpired = {}) { app.api.probeServer(server.url) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("${stringResource(R.string.login_title)} · ${server.name}", onBack = { if (!nav.back()) nav.reset(Screen.Servers) })
        Column(Modifier.padding(16.dp).widthIn(max = 520.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(server.url, color = Color(0xFFAAAAAA))
            if ((setup as? Load.Ok)?.data?.defaultAdminActive == true) {
                Text(stringResource(R.string.login_default_admin), color = Color(0xFFFFC107))
            }
            OutlinedTextField(
                value = username, onValueChange = { username = it },
                label = { Text(stringResource(R.string.login_username)) }, singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text(stringResource(R.string.login_password)) }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = keepPassword, onCheckedChange = { keepPassword = it })
                Text(stringResource(R.string.login_remember))
            }
            error?.let { Text(it, color = Color(0xFFFF8A80)) }
            NasButton(stringResource(R.string.login_submit), enabled = !busy && username.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    try {
                        val (user, token) = app.api.login(server.url, username.trim(), password)
                        val updated = server.copy(
                            username = user.username,
                            token = token,
                            password = if (keepPassword) password else null,
                        )
                        app.store.upsert(updated)
                        app.activate(updated)
                        nav.reset(Screen.Home)
                    } catch (e: Exception) {
                        error = e.message ?: e.javaClass.simpleName
                    } finally {
                        busy = false
                    }
                }
            })
        }
    }
}
