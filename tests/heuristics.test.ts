import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMediaFile,
  generateToken,
  isVideo,
  isAudio,
} from '../src/scanner/heuristics';

describe('extension helpers', () => {
  it('detects video extensions including mov/ts', () => {
    assert.equal(isVideo('a.mp4'), true);
    assert.equal(isVideo('a.mkv'), true);
    assert.equal(isVideo('a.avi'), true);
    assert.equal(isVideo('a.webm'), true);
    assert.equal(isVideo('a.mov'), true);
    assert.equal(isVideo('a.ts'), true);
    assert.equal(isVideo('a.mp3'), false);
  });

  it('detects audio extensions including ogg/aac', () => {
    assert.equal(isAudio('t.mp3'), true);
    assert.equal(isAudio('t.flac'), true);
    assert.equal(isAudio('t.m4a'), true);
    assert.equal(isAudio('t.opus'), true);
    assert.equal(isAudio('t.wav'), true);
    assert.equal(isAudio('t.ogg'), true);
    assert.equal(isAudio('t.aac'), true);
    assert.equal(isAudio('t.mkv'), false);
  });
});

describe('series heuristics', () => {
  it('parses Show.S01E02 style', () => {
    const p = parseMediaFile('Series/Breaking.Bad/Breaking.Bad.S01E02.mkv');
    assert.ok(p);
    assert.equal(p!.library, 'series');
    assert.equal(p!.type, 'episode');
    assert.equal(p!.show_name, 'Breaking Bad');
    assert.equal(p!.season, 1);
    assert.equal(p!.episode, 2);
  });

  it('parses 1x02 style', () => {
    const p = parseMediaFile('Series/The.Office/The.Office.1x02.avi');
    assert.ok(p);
    assert.equal(p!.library, 'series');
    assert.equal(p!.season, 1);
    assert.equal(p!.episode, 2);
  });

  it('respects forced series type', () => {
    const p = parseMediaFile('Random.File.mp4', 'series');
    assert.ok(p);
    assert.equal(p!.library, 'series');
    assert.equal(p!.type, 'episode');
  });
});

describe('movie heuristics', () => {
  it('classifies Movies folder as movie', () => {
    const p = parseMediaFile('Movies/Inception (2010)/Inception.mkv');
    assert.ok(p);
    assert.equal(p!.library, 'movies');
    assert.equal(p!.type, 'movie');
    assert.match(p!.title, /Inception/i);
  });

  it('strips release tags and preserves distinct titles inside category subfolders', () => {
    const p1 = parseMediaFile('Movies/Action/Die.Hard.1988.1080p.BluRay.x264.mkv', 'movies');
    const p2 = parseMediaFile('Movies/Action/Mad.Max.Fury.Road.2015.2160p.UHD.Remux.mkv', 'movies');
    assert.ok(p1 && p2);
    assert.equal(p1!.title, 'Die Hard');
    assert.equal(p2!.title, 'Mad Max Fury Road');
  });

  it('forced movies type', () => {
    const p = parseMediaFile('foo/bar.mkv', 'movies');
    assert.ok(p);
    assert.equal(p!.library, 'movies');
  });
});

describe('music heuristics', () => {
  it('parses Artist - Album - Track', () => {
    const p = parseMediaFile('Music/Daft Punk - Discovery - 01 - One More Time.mp3');
    assert.ok(p);
    assert.equal(p!.library, 'music');
    assert.equal(p!.type, 'track');
    assert.equal(p!.artist, 'Daft Punk');
    assert.equal(p!.album, 'Discovery');
    assert.equal(p!.title, 'One More Time');
    assert.equal(p!.track_num, 1);
  });

  it('parses Artist/Album/track folder layout', () => {
    const p = parseMediaFile('Music/Radiohead/OK Computer/01 - Airbag.flac');
    assert.ok(p);
    assert.equal(p!.library, 'music');
    assert.equal(p!.artist, 'Radiohead');
    assert.equal(p!.album, 'OK Computer');
    assert.equal(p!.title, 'Airbag');
    assert.equal(p!.track_num, 1);
  });
});

describe('token generation', () => {
  it('generates hex tokens of expected length', () => {
    const t = generateToken(24);
    assert.equal(t.length, 48);
    assert.match(t, /^[0-9a-f]+$/);
  });

  it('generates unique tokens', () => {
    assert.notEqual(generateToken(), generateToken());
  });
});
