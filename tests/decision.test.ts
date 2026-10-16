import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MediaProbe } from '../src/media/probe';

describe('playback decision engine (Direct Stream / Transcode / Surround)', () => {
  let decision: typeof import('../src/transcode/decision');

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-decision-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    decision = await import('../src/transcode/decision');
  });

  function mkProbe(over: Partial<MediaProbe>): MediaProbe {
    return {
      container: '.mkv',
      durationMs: 3600000,
      sizeBytes: 1000,
      bitrate: 1000,
      video: [],
      audio: [],
      subtitles: [],
      probedAt: new Date().toISOString(),
      ...over,
    };
  }

  const H264 = { index: 0, codec: 'h264', width: 1920, height: 1080, fps: 24, bitrate: 1, hdr: false };
  const HEVC = { index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 24, bitrate: 1, hdr: true };
  const DTS51 = {
    index: 0,
    streamIndex: 1,
    codec: 'dts',
    profile: 'DTS-HD MA',
    channels: 6,
    sampleRate: 48000,
    bitrate: 1,
    isDefault: true,
  };
  const AAC_STEREO = {
    index: 0,
    streamIndex: 1,
    codec: 'aac',
    channels: 2,
    sampleRate: 48000,
    bitrate: 1,
    isDefault: true,
  };

  it('parses session profiles from query strings', () => {
    const d = decision;
    assert.deepEqual(d.parseProfileFromQuery({}), {
      quality: 'original',
      audioIndex: 0,
      surround: false,
      passthrough: false,
    });
    assert.deepEqual(d.parseProfileFromQuery({ quality: '720p', audio: '1', surround: '1' }), {
      quality: '720p',
      audioIndex: 1,
      surround: true,
      passthrough: false,
    });
    assert.equal(d.parseProfileFromQuery({ quality: 'nope' }).quality, 'original');
    assert.equal(d.profileKey(d.DEFAULT_PROFILE), 'default');
    assert.equal(
      d.profileKey({ quality: '720p', audioIndex: 1, surround: true, passthrough: false }),
      'q720p-a1-s51'
    );
  });

  it('direct-streams H264 video and preserves DTS 5.1 as AAC 5.1 in surround mode', () => {
    const d = decision;
    const probe = mkProbe({ video: [H264], audio: [DTS51] });
    const dec = d.decideHls(probe, 'film.mkv', {
      quality: 'original',
      audioIndex: 0,
      surround: true,
      passthrough: false,
    });
    assert.equal(dec.video, 'copy');
    assert.equal(dec.audio, 'transcode');
    assert.equal(dec.audioCodec, 'AAC');
    assert.equal(dec.audioChannels, 6);
    assert.equal(dec.mode, 'transcode'); // video copy + audio transcode = transcode session
    assert.equal(dec.sourceHasSurround, true);
    assert.match(dec.reason, /5\.1/);
  });

  it('fully remuxes (direct-stream) H264 + AAC stereo', () => {
    const d = decision;
    const probe = mkProbe({ video: [H264], audio: [AAC_STEREO] });
    const dec = d.decideHls(probe, 'film.mkv', d.DEFAULT_PROFILE);
    assert.equal(dec.video, 'copy');
    assert.equal(dec.audio, 'copy');
    assert.equal(dec.mode, 'direct-stream');
  });

  it('downmixes DTS 5.1 to stereo by default', () => {
    const d = decision;
    const probe = mkProbe({ video: [H264], audio: [DTS51] });
    const dec = d.decideHls(probe, 'film.mkv', d.DEFAULT_PROFILE);
    assert.equal(dec.audio, 'transcode');
    assert.equal(dec.audioCodec, 'AAC');
    assert.equal(dec.audioChannels, 2);
  });

  it('transcodes HEVC video even in original quality', () => {
    const d = decision;
    const probe = mkProbe({ video: [HEVC], audio: [AAC_STEREO] });
    const dec = d.decideHls(probe, 'film.mkv', d.DEFAULT_PROFILE);
    assert.equal(dec.video, 'transcode');
    assert.equal(dec.mode, 'transcode');
  });

  it('transcodes video when a lower quality is requested', () => {
    const d = decision;
    const probe = mkProbe({ video: [H264], audio: [AAC_STEREO] });
    const dec = d.decideHls(probe, 'film.mkv', {
      quality: '720p',
      audioIndex: 0,
      surround: false,
      passthrough: false,
    });
    assert.equal(dec.video, 'transcode');
    assert.match(dec.reason, /720p/);
  });

  it('falls back to full transcode without a probe', () => {
    const d = decision;
    const dec = d.decideHls(null, 'film.mkv', d.DEFAULT_PROFILE);
    assert.equal(dec.video, 'transcode');
    assert.equal(dec.audio, 'transcode');
    assert.equal(dec.audioChannels, 2);
    assert.equal(dec.mode, 'transcode');
  });

  it('warns on out-of-range audio track and clamps to 0', () => {
    const d = decision;
    const probe = mkProbe({ video: [H264], audio: [AAC_STEREO] });
    const dec = d.decideHls(probe, 'film.mkv', {
      quality: 'original',
      audioIndex: 5,
      surround: false,
      passthrough: false,
    });
    assert.equal(dec.audioSourceIndex, 0);
    assert.equal(dec.warnings.length, 1);
  });

  it('refuses passthrough when the server disables it', () => {
    const d = decision;
    const AC3 = { ...AAC_STEREO, codec: 'ac3', channels: 6 };
    const probe = mkProbe({ video: [H264], audio: [AC3] });
    const dec = d.decideHls(probe, 'film.mkv', {
      quality: 'original',
      audioIndex: 0,
      surround: false,
      passthrough: true,
    });
    // Default config: TRANSCODE_AUDIO_PASSTHROUGH=false
    assert.equal(dec.audio, 'transcode');
    assert.ok(dec.warnings.some((w) => /Passthrough/i.test(w)));
  });
});
