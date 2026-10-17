package com.nassimplemedia.android.data

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private val client = OkHttpClient.Builder().addInterceptor(Session.interceptor).build()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        base = server.url("/").toString().trimEnd('/')
        Session.baseUrl = base
        Session.token = null
    }

    @After fun tearDown() {
        server.shutdown()
        Session.baseUrl = null
        Session.token = null
    }

    @Test fun loginReadsSessionCookie() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"ok":true,"user":{"id":1,"username":"alex","role":"admin","can_share":true}}""")
                .addHeader("Set-Cookie", "nas_sm_session=abc123; Path=/; HttpOnly; SameSite=Lax"),
        )
        val (user, token) = ApiClient(client).login(base, "alex", "pw")
        assertEquals("alex", user.username)
        assertEquals("abc123", token)
        val req = server.takeRequest()
        assertEquals("/api/login", req.path)
        assertTrue(req.body.readUtf8().contains("\"username\":\"alex\""))
    }

    @Test fun sessionCookieIsSentToActiveServer() = runTest {
        Session.token = "tok"
        server.enqueue(MockResponse().setBody("""{"libraries":[{"id":1,"name":"Films","type":"movies","item_count":3}]}"""))
        val libs = ApiClient(client).libraries()
        assertEquals(3, libs.first().itemCount)
        assertEquals("nas_sm_session=tok", server.takeRequest().getHeader("Cookie"))
    }

    @Test fun reauthOn401ThenRetry() = runTest {
        Session.token = "old"
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Unauthorized"}"""))
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        val api = ApiClient(client)
        var called = 0
        api.reauth = { called++; Session.token = "new"; true }
        api.recentlyAdded()
        assertEquals(1, called)
        server.takeRequest()
        assertEquals("nas_sm_session=new", server.takeRequest().getHeader("Cookie"))
    }

    @Test(expected = AuthExpiredException::class)
    fun expiredWithoutSavedPassword() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Unauthorized"}"""))
        ApiClient(client).libraries()
    }

    @Test fun startHlsWaitsWhileTranscoding() = runTest {
        server.enqueue(MockResponse().setBody("""{"status":"running","playlistUrl":"/api/stream/4/hls/playlist.m3u8?quality=720p"}"""))
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"error":"Transcodage en cours"}"""))
        server.enqueue(MockResponse().setBody("#EXTM3U"))
        val url = ApiClient(client).startHls(base, "/api/stream/4/hls?quality=720p")
        assertEquals("$base/api/stream/4/hls/playlist.m3u8?quality=720p", url)
        assertEquals(3, server.requestCount)
    }

    @Test fun cookieHeaderParsing() {
        assertEquals("v", ApiClient.parseCookie("a=1; nas_sm_session=v; Path=/", "nas_sm_session"))
        assertEquals(null, ApiClient.parseCookie("nas_sm_session=; Path=/", "nas_sm_session"))
    }

    @Test fun loginWithFactoryPasswordAsksForWebChange() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"ok":true,"mustChangePassword":true,"code":"PASSWORD_CHANGE_REQUIRED",""" +
                    """"user":{"id":1,"username":"admin","role":"admin","can_share":true,"must_change_password":true}}"""
            ).addHeader("Set-Cookie", "nas_sm_session=tmp; Path=/; HttpOnly; SameSite=Lax"),
        )
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        val e = runCatching { ApiClient(client).login(base, "admin", "changeme") }.exceptionOrNull()
        assertTrue(e is PasswordChangeRequiredException)
        assertTrue(e!!.message!!.contains("/login.html"))
        server.takeRequest()
        val logout = server.takeRequest()
        assertEquals("/api/logout", logout.path)
        assertEquals("nas_sm_session=tmp", logout.getHeader("Cookie"))
    }

    @Test fun passwordChangeRequired403IsReported() = runTest {
        Session.token = "tok"
        server.enqueue(
            MockResponse().setResponseCode(403)
                .setBody("""{"error":"Changement obligatoire","code":"PASSWORD_CHANGE_REQUIRED"}"""),
        )
        val e = runCatching { ApiClient(client).libraries() }.exceptionOrNull()
        assertTrue(e is PasswordChangeRequiredException)
    }

    @Test fun shareUnlockPostsPasswordOnceThenUsesToken() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"accessToken":"v1.abc.sig","expiresInMs":1000}"""))
        server.enqueue(MockResponse().setBody("""{"needsPassword":false,"items":[]}"""))
        val api = ApiClient(client)
        val access = api.unlockShare(base, "shr", "s3cret pw")
        assertEquals("v1.abc.sig", access)
        val unlock = server.takeRequest()
        assertEquals("POST", unlock.method)
        assertEquals("/api/public/share/shr/unlock", unlock.path)
        assertTrue(unlock.body.readUtf8().contains("s3cret pw"))
        api.share(base, "shr", access)
        val info = server.takeRequest()
        assertEquals("/api/public/share/shr?access=v1.abc.sig", info.path)
        assertTrue(!info.path!!.contains("password"))
    }
}
