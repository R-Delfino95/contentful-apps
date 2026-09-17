import { describe, expect, it, vi } from 'vitest';

vi.mock('contentful-management', () => ({ createClient: vi.fn() }));
vi.mock('./helpers/muxClient', () => ({ muxFetch: vi.fn() }));

import { buildMuxAssetMirror, findPendingActionsInMuxFields } from './onPublish';
import { MUX_ASSET_MIRROR_KEYS, mergeMuxAssetIntoField } from './helpers/muxField';

const muxField = (locales: Record<string, unknown>) => ({ muxVideo: locales });

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 'asset-1',
  status: 'ready',
  playback_ids: [{ id: 'playback-1', policy: 'public' }],
  ...overrides,
});

const captionTrack = (overrides: Record<string, unknown> = {}) => ({
  id: 'track-1',
  type: 'text',
  text_type: 'subtitles',
  status: 'ready',
  language_code: 'en-US',
  ...overrides,
});

describe('findPendingActionsInMuxFields', () => {
  it('ignores fields with no pending actions', () => {
    expect(
      findPendingActionsInMuxFields(muxField({ 'en-US': { assetId: 'asset-1', ready: true } }))
    ).toEqual({});
  });

  it('ignores fields that are not Mux fields', () => {
    expect(findPendingActionsInMuxFields({ title: { 'en-US': 'A title' } })).toEqual({});
    expect(findPendingActionsInMuxFields(undefined)).toEqual({});
    expect(findPendingActionsInMuxFields(null)).toEqual({});
  });

  it('collects actions from the default locale', () => {
    const result = findPendingActionsInMuxFields(
      muxField({
        'en-US': {
          assetId: 'asset-1',
          pendingActions: {
            delete: [{ type: 'caption', id: 'track-1', retry: 0 }],
            create: [],
            update: [],
          },
        },
      })
    );

    expect(result).toEqual({
      muxVideo: { delete: [{ type: 'caption', id: 'track-1', retry: 0 }], assetId: 'asset-1' },
    });
  });

  it('reads only the first locale, unchanged from before Robots', () => {
    // Deliberate: scanning every locale would make this publish execute actions queued in a
    // non-default locale that have never run, which for an asset delete is destructive and would
    // arrive as a surprise on installs that already exist.
    const result = findPendingActionsInMuxFields(
      muxField({
        'en-US': { assetId: 'asset-1', ready: true },
        'de-DE': {
          assetId: 'asset-1',
          pendingActions: { delete: [{ type: 'audio', id: 'track-2', retry: 0 }] },
        },
      })
    );

    expect(result).toEqual({});
  });

  it('drops actions that have exhausted their retries', () => {
    expect(
      findPendingActionsInMuxFields(
        muxField({
          'en-US': {
            assetId: 'asset-1',
            pendingActions: { delete: [{ type: 'caption', id: 'track-1', retry: 4 }] },
          },
        })
      )
    ).toEqual({});
  });

  it('drops actions with no retry counter', () => {
    expect(
      findPendingActionsInMuxFields(
        muxField({
          'en-US': {
            assetId: 'asset-1',
            pendingActions: { delete: [{ type: 'caption', id: 'track-1' }] },
          },
        })
      )
    ).toEqual({});
  });

  it('tolerates a null pendingActions left behind by a previous publish', () => {
    expect(
      findPendingActionsInMuxFields(
        muxField({ 'en-US': { assetId: 'asset-1', pendingActions: null } })
      )
    ).toEqual({});
  });
});

/**
 * The caption filter, and the mirror keys that never cleared.
 *
 * Both are about the same failure: a publish leaving the entry holding tracks the asset does not
 * have. One did it by filtering differently from the browser, the other by omitting the key so
 * the merge kept the stale array.
 */
describe('buildMuxAssetMirror', () => {
  it('writes every mirror key, so each one can clear', () => {
    const mirror = buildMuxAssetMirror(asset());

    // Not `toContain` per key: the point is that the mirror and the key list cannot drift. A key
    // added to `MUX_ASSET_MIRROR_KEYS` and forgotten here is the bug this pins.
    expect(Object.keys(mirror).sort()).toEqual([...MUX_ASSET_MIRROR_KEYS].sort());
  });

  it('clears captions and audioTracks when the asset has none left', () => {
    const mirror = buildMuxAssetMirror(asset({ tracks: [] }));

    // Present-and-undefined, not absent. Absent is what used to leave the stale list in place.
    expect('captions' in mirror).toBe(true);
    expect(mirror.captions).toBeUndefined();
    expect('audioTracks' in mirror).toBe(true);
    expect(mirror.audioTracks).toBeUndefined();
  });

  it('drops a caption the asset no longer has, instead of preserving it through the merge', () => {
    const existing = {
      version: 3,
      assetId: 'asset-1',
      captions: [captionTrack()],
      audioTracks: [{ id: 'audio-1', type: 'audio' }],
      robotsOutputs: { summarize: { title: 'Kept' } },
    };

    const merged = mergeMuxAssetIntoField(existing, buildMuxAssetMirror(asset({ tracks: [] })));

    // `undefined` survives to the CMA as an absent key — the same mechanism every other mirror
    // key has always relied on.
    expect(merged.captions).toBeUndefined();
    expect(merged.audioTracks).toBeUndefined();
    expect('captions' in JSON.parse(JSON.stringify(merged))).toBe(false);
    // The correction must not cost the browser-owned keys on its way past.
    expect(merged.robotsOutputs).toEqual({ summarize: { title: 'Kept' } });
  });

  it('keeps the tracks that are still there', () => {
    const tracks = [captionTrack(), { id: 'audio-1', type: 'audio', status: 'ready' }];
    const mirror = buildMuxAssetMirror(asset({ tracks }));

    expect(mirror.captions).toEqual([tracks[0]]);
    expect(mirror.audioTracks).toEqual([tracks[1]]);
  });

  it('filters captions the way the browser does, not by track type alone', () => {
    const tracks = [
      captionTrack({ id: 'ready' }),
      captionTrack({ id: 'preparing', status: 'preparing' }),
      // The three the old `t.type === 'text'` filter let through. Each one reappeared on the
      // entry at publish time after the browser had already filtered it out.
      captionTrack({ id: 'errored', status: 'errored' }),
      captionTrack({ id: 'deleted', status: 'deleted' }),
      captionTrack({ id: 'cues', text_type: 'cues' }),
    ];

    const mirror = buildMuxAssetMirror(asset({ tracks }));

    expect((mirror.captions as { id: string }[]).map((t) => t.id)).toEqual(['ready', 'preparing']);
  });

  it('survives an asset with no tracks and no playback ids at all', () => {
    const mirror = buildMuxAssetMirror({ id: 'asset-1', status: 'preparing' });

    expect(mirror.assetId).toBe('asset-1');
    expect(mirror.ready).toBe(false);
    expect(mirror.playbackId).toBeUndefined();
    expect(mirror.captions).toBeUndefined();
  });
});
