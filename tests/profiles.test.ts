import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MediaProbe } from '../src/media/probe';

describe('ffmpeg profile builder (remux / surround / qualities)', () => {
  let profiles: typeof import('../src/transcode/profiles');
  let decision: typeof import('../src/transcode/decision');
  let hls: typeof import('../src/transcode/hls');

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasm-profiles-'));
    process.env.DATA_PATH = path.join(tmp, 'data');
    process.env.MEDIA_PATH = path.join(tmp, 'media');
    profiles = await import('../src/transcode/profiles');
    decision = await import('../src/transcode/decision');
    hls = await import('../src/transcode/hls');
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

  function build(probe: MediaProbe | null, filename: string, profile: Parameters<typeof decision.decideHls>[2]) {
    return profiles.buildFfmpegArgs({
      inputPath: '/media/film.mkv',
      probe,
      filenameOrPath: filename,
      profile,
      playlistPath: '/tmp/out/playlist.m3u8',
      segmentPattern: '/tmp/out/seg_%05d.ts',
      forceHw: { encoder: 'libx264', hw: 'none' },
    });
  }

  function hasFlag(args: string[], ...seq: string[]): boolean {
    for (let i = 0; i + seq.length <= args.length; i++) {
      if (seq.every((s, j) => args[i + j] === s)) return true;
    }
    return false;
  }

  it('copies H264 video (Direct Stream) and downmixes to AAC stereo by default', () => {
    const { args } = build(mkProbe({ video: [H264], audio: [DTS51] }), 'film.mkv', decision.DEFAULT_PROFILE);
    assert.ok(hasFlag(args, '-c:v', 'copy'));
    assert.ok(hasFlag(args, '-c:a', 'aac'));
    assert.ok(hasFlag(args, '-ac', '2'));
    assert.ok(hasFlag(args, '-map', '0:a:0?'));
    assert.ok(hasFlag(args, '-f', 'hls'));
  });

  it('builds AAC 5.1 surround audio with channel layout', () => {
    const { args } = build(
      mkProbe({ video: [H264], audio: [DTS51] }),
      'film.mkv',
      { quality: 'original', audioIndex: 0, surround: true, passthrough: false }
    );
    assert.ok(hasFlag(args, '-ac', '6'));
    assert.ok(hasFlag(args, '-channel_layout', '5.1'));
    assert.ok(hasFlag(args, '-b:a', '384k'));
  });

  it('fully remuxes H264 + AAC stereo (video copy + audio copy)', () => {
    const { args, plan } = build(
      mkProbe({ video: [H264], audio: [AAC_STEREO] }),
      'film.mkv',
      decision.DEFAULT_PROFILE
    );
    assert.equal(plan.decision.mode, 'direct-stream');
    assert.ok(hasFlag(args, '-c:v', 'copy'));
    assert.ok(hasFlag(args, '-c:a', 'copy'));
  });

  it('scales + caps bitrate for 720p', () => {
    const { args } = build(
      mkProbe({ video: [H264], audio: [AAC_STEREO] }),
      'film.mkv',
      { quality: '720p', audioIndex: 0, surround: false, passthrough: false }
    );
    assert.ok(hasFlag(args, '-c:v', 'libx264'));
    assert.ok(args.some((a) => a.includes('720')), `expected scale filter, got: ${args.join(' ')}`);
    assert.ok(hasFlag(args, '-maxrate', '5M'));
  });

  it('maps the requested audio track', () => {
    const SECOND = { ...DTS51, index: 1, streamIndex: 2, isDefault: false };
    const { args } = build(
      mkProbe({ video: [H264], audio: [AAC_STEREO, SECOND] }),
      'film.mkv',
      { quality: 'original', audioIndex: 1, surround: true, passthrough: false }
    );
    assert.ok(hasFlag(args, '-map', '0:a:1?'));
    assert.ok(hasFlag(args, '-ac', '6'));
  });

  it('keeps the historical software flags without a probe', () => {
    const { args } = build(null, 'film.mkv', decision.DEFAULT_PROFILE);
    assert.ok(hasFlag(args, '-c:v', 'libx264'));
    assert.ok(hasFlag(args, '-preset', 'veryfast'));
    assert.ok(hasFlag(args, '-profile:v', 'main'));
    assert.ok(hasFlag(args, '-pix_fmt', 'yuv420p'));
    assert.ok(hasFlag(args, '-c:a', 'aac'));
    assert.ok(hasFlag(args, '-ac', '2'));
  });

  it('isolates segment files per profile and blocks traversal', () => {
    assert.equal(hls.getSegmentFile(1, '../../etc/passwd'), null);
    assert.equal(hls.getSegmentFile(1, 'seg_00001.ts'), null); // nothing transcoded
    assert.equal(
      hls.getSegmentFile(1, 'seg_00001.ts', { quality: '720p', audioIndex: 0, surround: false, passthrough: false }),
      null
    );
    assert.deepEqual(hls.listTranscodeJobs(), []);
    assert.equal(hls.killTranscodeJob('1:default'), false);
  });
});
