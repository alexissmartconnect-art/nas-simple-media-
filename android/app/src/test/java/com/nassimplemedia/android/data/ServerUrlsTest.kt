package com.nassimplemedia.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlsTest {
    @Test fun lanIpGetsHttpAndDefaultPort() {
        assertEquals("http://192.168.1.20:8096", ServerUrls.normalize("192.168.1.20"))
        assertEquals("http://192.168.1.20:5000", ServerUrls.normalize(" 192.168.1.20:5000/ "))
        assertEquals("http://nas.local:8096", ServerUrls.normalize("nas.local"))
        assertEquals("http://ds220:8096", ServerUrls.normalize("DS220"))
    }

    @Test fun publicNamesDefaultToHttps() {
        assertEquals("https://nas.tail1234.ts.net", ServerUrls.normalize("nas.tail1234.ts.net"))
        assertEquals("https://media.example.fr", ServerUrls.normalize("https://media.example.fr/"))
        assertEquals("https://alex.synology.me/media", ServerUrls.normalize("https://alex.synology.me/media/"))
    }

    @Test fun explicitSchemeIsKept() {
        assertEquals("http://10.0.0.5:8096", ServerUrls.normalize("http://10.0.0.5:8096"))
        assertEquals("http://10.0.0.5", ServerUrls.normalize("http://10.0.0.5"))
    }

    @Test fun pastedPageOrShareUrlKeepsServerRoot() {
        assertEquals("https://nas.ts.net", ServerUrls.normalize("https://nas.ts.net/s/abc123"))
        assertEquals("http://192.168.1.2:8096", ServerUrls.normalize("http://192.168.1.2:8096/login.html"))
    }

    @Test fun rejectsGarbage() {
        assertNull(ServerUrls.normalize(""))
        assertNull(ServerUrls.normalize("ftp://nas"))
    }

    @Test fun localHostDetection() {
        assertTrue(ServerUrls.isLocalHost("172.20.1.1"))
        assertTrue(ServerUrls.isLocalHost("100.101.102.103")) // Tailscale
        assertFalse(ServerUrls.isLocalHost("172.40.1.1"))
        assertFalse(ServerUrls.isLocalHost("82.64.1.1"))
        assertTrue(ServerUrls.isInsecurePublic("http://82.64.1.1:8096"))
        assertFalse(ServerUrls.isInsecurePublic("http://192.168.0.10:8096"))
        assertFalse(ServerUrls.isInsecurePublic("https://82.64.1.1"))
    }

    @Test fun parsesShareLinks() {
        val l = ServerUrls.parseShareLink("https://nas.tail1.ts.net/s/AbC_12-x")!!
        assertEquals("https://nas.tail1.ts.net", l.serverUrl)
        assertEquals("AbC_12-x", l.token)
        val p = ServerUrls.parseShareLink("http://192.168.1.2:8096/media/s/tok123/")!!
        assertEquals("http://192.168.1.2:8096/media", p.serverUrl)
        assertEquals("tok123", p.token)
        val c = ServerUrls.parseShareLink("nasmedia://share?url=https%3A%2F%2Fa.b%2Fs%2Fxyz")!!
        assertEquals("https://a.b", c.serverUrl)
        assertEquals("xyz", c.token)
        assertNull(ServerUrls.parseShareLink("https://a.b/login.html"))
        assertNull(ServerUrls.parseShareLink("https://a.b/s/"))
    }
}
