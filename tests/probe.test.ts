import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ffprobe parsing + labels (DTS / 5.1 detection)', () => {
  let probe: typeof import('../src/media/probe');

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-probe-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    probe = await import('../src/media/probe');
  });

  const DTS_HD_MKV = {
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        profile: 'High',
        width: 1920,
        height: 1080,
        avg_frame_rate: '24000/1001',
        pix_fmt: 'yuv420p',
        bit_rate: '8000000',
      },
      {
        index: 1,
        codec_name: 'dts',
        codec_type: 'audio',
        profile: 'DTS-HD MA',
        channels: 6,
        channel_layout: '5.1',
        sample_rate: '48000',
        bit_rate: '1500000',
        tags: { language: 'eng', title: 'DTS-HD MA 5.1' },
        disposition: { default: 1 },
      },
      {
        index: 2,
        codec_name: 'ac3',
        codec_type: 'audio',
        channels: 2,
        sample_rate: '48000',
        tags: { language: 'fre' },
        disposition: { default: 0 },
      },
      {
        index: 3,
        codec_name: 'subrip',
        codec_type: 'subtitle',
        tags: { language: 'fre' },
        disposition: { default: 0, forced: 0 },
      },
      {
        index: 4,
        codec_name: 'hdmv_pgs_subtitle',
        codec_type: 'subtitle',
        tags: { language: 'eng' },
        disposition: {},
      },
    ],
    format: { format_name: 'matroska,webm', duration: '7200.5', size: '8000000000', bit_rate: '8800000' },
  };

  it('parses streams, indexes and duration', () => {
    const p = probe.parseFfprobeJson(DTS_HD_MKV, '.mkv');
    assert.equal(p.video.length, 1);
    assert.equal(p.audio.length, 2);
    assert.equal(p.subtitles.length, 2);
    assert.equal(p.video[0].codec, 'h264');
    assert.equal(p.video[0].width, 1920);
    assert.equal(p.audio[0].index, 0); // 0:a:0
    assert.equal(p.audio[1].index, 1); // 0:a:1
    assert.equal(p.audio[0].streamIndex, 1);
    assert.equal(p.durationMs, 7200500);
    assert.equal(p.subtitles[0].imageBased, false);
    assert.equal(p.subtitles[1].imageBased, true);
  });

  it('labels DTS-HD MA 5.1 and AC-3 stereo', () => {
    const p = probe.parseFfprobeJson(DTS_HD_MKV, '.mkv');
    assert.equal(probe.audioTrackLabel(p.audio[0]), 'DTS-HD MA 5.1 · ENG — DTS-HD MA 5.1');
    assert.equal(probe.audioCodecLabel('dts', 'DTS-HD MA'), 'DTS-HD MA');
    assert.equal(probe.audioCodecLabel('dts', 'DTS-ES'), 'DTS-ES');
    assert.equal(probe.audioCodecLabel('truehd'), 'TrueHD');
    assert.equal(probe.audioCodecLabel('eac3'), 'E-AC-3');
    assert.equal(probe.channelLabel(6), '5.1');
    assert.equal(probe.channelLabel(8), '7.1');
    assert.equal(probe.channelLabel(2), 'Stéréo');
  });

  it('summarizes surround / DTS flags for UI badges', () => {
    const p = probe.parseFfprobeJson(DTS_HD_MKV, '.mkv');
    const s = probe.summarizeProbe(p);
    assert.equal(s.hasSurround, true);
    assert.equal(s.hasDts, true);
    assert.equal(s.hasTrueHd, false);
    assert.equal(s.videoLabel, 'H.264 1080p');
    assert.equal(s.audioTracks, 2);
    assert.equal(s.textSubtitleTracks, 1);
    assert.ok(s.audioLabels[0].includes('5.1'));
  });

  it('detects TrueHD 7.1 + HDR', () => {
    const raw = {
      streams: [
        {
          index: 0,
          codec_name: 'hevc',
          codec_type: 'video',
          width: 3840,
          height: 2160,
          color_transfer: 'smpte2084',
          pix_fmt: 'yuv420p10le',
        },
        { index: 1, codec_name: 'truehd', codec_type: 'audio', channels: 8, disposition: {} },
      ],
      format: { duration: '60' },
    };
    const s = probe.summarizeProbe(probe.parseFfprobeJson(raw, '.mkv'));
    assert.equal(s.hasTrueHd, true);
    assert.equal(s.hasSurround, true);
    assert.equal(s.hasHdr, true);
    assert.equal(s.videoLabel, 'HEVC 4K HDR');
    assert.ok(s.audioLabels[0].includes('7.1'));
  });

  it('handles empty / corrupt ffprobe output gracefully', () => {
    const s = probe.summarizeProbe(probe.parseFfprobeJson({}, '.mp4'));
    assert.equal(s.hasVideo, false);
    assert.equal(s.hasAudio, false);
    assert.equal(s.hasSurround, false);
    assert.equal(s.videoLabel, null);
  });

  it('skips attached pictures (album art)', () => {
    const raw = {
      streams: [
        { index: 0, codec_name: 'mjpeg', codec_type: 'video', disposition: { attached_pic: 1 } },
        { index: 1, codec_name: 'flac', codec_type: 'audio', channels: 2, disposition: {} },
      ],
      format: {},
    };
    const p = probe.parseFfprobeJson(raw, '.flac');
    assert.equal(p.video.length, 0);
    assert.equal(p.audio.length, 1);
  });
});
