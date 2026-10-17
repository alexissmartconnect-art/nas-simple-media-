package com.nassimplemedia.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackPlannerTest {
    private fun plan(q: Quality, summary: ProbeSummary? = null, codec: String? = "h264", file: String = "a.mkv", transcode: Boolean = true, audio: Int = 0, video: Boolean = true) =
        PlaybackPlanner.plan(video, q, transcode, summary, codec, null, file, audio)

    @Test fun musicIsAlwaysDirect() {
        assertEquals(SourceKind.DIRECT, plan(Quality.P480, video = false).kind)
    }

    @Test fun originalIsDirect() {
        assertEquals(PlaybackPlan(SourceKind.DIRECT, null), plan(Quality.ORIGINAL))
    }

    @Test fun presetsUseHlsTranscode() {
        assertEquals(PlaybackPlan(SourceKind.HLS, "720p", 0), plan(Quality.P720))
        assertEquals(PlaybackPlan(SourceKind.HLS, "480p", 2), plan(Quality.P480, audio = 2))
    }

    @Test fun autoDirectPlaysCompatibleFiles() {
        assertEquals(SourceKind.DIRECT, plan(Quality.AUTO, ProbeSummary(), "hevc").kind)
        assertEquals(SourceKind.DIRECT, plan(Quality.AUTO, null, null, "film.mp4").kind)
    }

    @Test fun autoFallsBackToHlsRemuxForDtsTrueHdOrOddCodecs() {
        assertEquals(PlaybackPlan(SourceKind.HLS, "original", 0), plan(Quality.AUTO, ProbeSummary(hasDts = true)))
        assertEquals(SourceKind.HLS, plan(Quality.AUTO, ProbeSummary(hasTrueHd = true)).kind)
        assertEquals(SourceKind.HLS, plan(Quality.AUTO, ProbeSummary(), "wmv3").kind)
        assertEquals(SourceKind.HLS, plan(Quality.AUTO, null, null, "old.avi").kind)
        // Picking a non-default audio track goes through the server.
        assertEquals(SourceKind.HLS, plan(Quality.AUTO, ProbeSummary(), audio = 1).kind)
    }

    @Test fun transcodeDisabledMeansDirect() {
        assertEquals(SourceKind.DIRECT, plan(Quality.P720, transcode = false).kind)
    }

    @Test fun sessionAndSharePaths() {
        assertEquals("/api/stream/5/hls", MediaSource.Session.hlsStartPath(5, "original", 0))
        assertEquals("/api/stream/5/hls?quality=720p&audio=1", MediaSource.Session.hlsStartPath(5, "720p", 1))
        assertEquals("/api/stream/5/raw", MediaSource.Session.rawPath(5))
        // Signed access token from /unlock — the share password never appears in a URL.
        val s = MediaSource.Share("tok", "v1.k9.sig")
        assertEquals("/api/public/share/tok/item/7/hls?quality=480p&access=v1.k9.sig", s.hlsStartPath(7, "480p", 0))
        assertEquals("/api/public/share/tok/item/7/stream?access=v1.k9.sig", s.rawPath(7))
        assertEquals(false, s.rawPath(7).contains("password"))
        assertEquals("/api/public/share/tok/item/7/thumb.jpg", MediaSource.Share("tok", null).thumbPath(7))
    }
}
