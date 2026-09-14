import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlaybackHint,
  needsCompatByDefault,
  extOf,
} from '../src/transcode/formats';

describe('playback format hints', () => {
  it('suggests compatible for mkv/avi', () => {
    const h = getPlaybackHint('Movie.Remux.mkv', 'movie');
    assert.equal(h.suggestedMode, 'compatible');
    assert.equal(h.directLikely, false);
    assert.equal(needsCompatByDefault('film.avi', 'movie'), true);
  });

  it('suggests direct for mp4/webm', () => {
    const h = getPlaybackHint('clip.mp4', 'movie');
    assert.equal(h.suggestedMode, 'direct');
    assert.equal(h.directLikely, true);
    assert.equal(needsCompatByDefault('x.webm', 'movie'), false);
  });

  it('handles audio tracks', () => {
    const h = getPlaybackHint('track.mp3', 'track');
    assert.equal(h.suggestedMode, 'direct');
    assert.equal(extOf('/a/b/c.MKV'), '.mkv');
  });
});
