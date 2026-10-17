package com.nassimplemedia.android.data

import java.net.URI
import java.net.URLDecoder

/** Pure helpers (unit-tested) to normalise what the user types and parse share links. */
object ServerUrls {
    const val DEFAULT_PORT = 8096

    private val ipv4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

    /**
     * "192.168.1.20"           -> http://192.168.1.20:8096
     * "nas.local"              -> http://nas.local:8096
     * "nas.tail1234.ts.net"    -> https://nas.tail1234.ts.net
     * "https://media.example.fr/" -> https://media.example.fr
     * Returns null when the input cannot be a server address.
     */
    fun normalize(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        val hasScheme = s.startsWith("http://", true) || s.startsWith("https://", true)
        if (!hasScheme && s.contains("://")) return null
        if (!hasScheme) {
            val hostPart = s.substringBefore('/').substringBefore(':')
            s = if (isLocalHost(hostPart)) "http://$s" else "https://$s"
        }
        val uri = try { URI(s) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase() ?: return null
        var port = uri.port
        if (port == -1 && !hasScheme && isLocalHost(host)) port = DEFAULT_PORT
        val hostOut = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        val path = (uri.rawPath ?: "").trimEnd('/')
            // A pasted share link or page URL: keep only the server root.
            .let { p -> if (p.startsWith("/s/") || p.endsWith(".html")) "" else p }
        return buildString {
            append(scheme).append("://").append(hostOut)
            if (port != -1) append(':').append(port)
            append(path)
        }
    }

    /** LAN / link-local / mDNS addresses where plain http:// is expected. */
    fun isLocalHost(host: String): Boolean {
        val h = host.lowercase().trim('[', ']')
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home")) return true
        if (!h.contains('.') && !h.contains(':')) return true // bare NetBIOS name, e.g. "DS220"
        if (ipv4.matches(h)) {
            val p = h.split('.').map { it.toInt() }
            return p[0] == 10 || p[0] == 127 ||
                (p[0] == 192 && p[1] == 168) ||
                (p[0] == 172 && p[1] in 16..31) ||
                (p[0] == 169 && p[1] == 254) ||
                (p[0] == 100 && p[1] in 64..127) // Tailscale CGNAT range
        }
        return h.startsWith("fe80:") || h.startsWith("fd") || h == "::1"
    }

    /** True when the user is about to send credentials in clear text over the Internet. */
    fun isInsecurePublic(url: String): Boolean {
        val uri = try { URI(url) } catch (_: Exception) { return false }
        return uri.scheme.equals("http", true) && uri.host != null && !isLocalHost(uri.host)
    }

    data class ShareLink(val serverUrl: String, val token: String)

    /**
     * Accepts "https://host[:port][/prefix]/s/<token>" or
     * "nasmedia://share?url=<encoded share url>".
     */
    fun parseShareLink(raw: String): ShareLink? {
        val s = raw.trim()
        if (s.startsWith("nasmedia://", true)) {
            val q = s.substringAfter('?', "")
            val url = q.split('&').firstOrNull { it.startsWith("url=") }?.substringAfter("url=") ?: return null
            return parseShareLink(URLDecoder.decode(url, "UTF-8"))
        }
        val uri = try { URI(s) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host ?: return null
        val path = uri.rawPath ?: return null
        val idx = path.indexOf("/s/")
        if (idx < 0) return null
        val token = path.substring(idx + 3).trim('/').substringBefore('/')
        if (token.isEmpty() || !token.all { it.isLetterOrDigit() || it == '-' || it == '_' }) return null
        val prefix = path.substring(0, idx).trimEnd('/')
        val port = if (uri.port != -1) ":${uri.port}" else ""
        return ShareLink("$scheme://$host$port$prefix", token)
    }
}
