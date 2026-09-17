import { describe, expect, it, vi } from 'vitest';
import { FieldExtensionSDK } from '@contentful/app-sdk';
import {
  RobotsOutputCandidate,
  applyOutputsToEntry,
  buildOutputCandidates,
  currentFieldValue,
  entryFieldOptions,
  formatFieldValue,
  wouldOverwrite,
} from './robotsEntryMapping';
import { RobotsOutputs } from './robotsTypes';

interface FakeField {
  id: string;
  type: string;
  items?: { type: string };
  value?: unknown;
  locales?: string[];
  setValue?: ReturnType<typeof vi.fn>;
}

const buildSdk = (fields: FakeField[], muxFieldId = 'muxVideo'): FieldExtensionSDK => {
  const entryFields = Object.fromEntries(
    fields.map((field) => [
      field.id,
      {
        id: field.id,
        type: field.type,
        items: field.items,
        locales: field.locales ?? ['en-US'],
        getValue: () => field.value,
        setValue: field.setValue ?? vi.fn(async () => undefined),
      },
    ])
  );

  return {
    field: { id: muxFieldId },
    locales: { default: 'en-US' },
    contentType: {
      fields: fields.map((field) => ({ id: field.id, name: `${field.id} label` })),
    },
    entry: { fields: entryFields },
    notifier: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  } as unknown as FieldExtensionSDK;
};

const summary: RobotsOutputs = {
  summarize: {
    jobId: 'rjob_1',
    title: 'Generated title',
    description: 'Generated description',
    tags: ['alpha', 'beta'],
  },
};

describe('entryFieldOptions', () => {
  it('reads names and types straight off the SDK, needing no configuration', () => {
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol' },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
      { id: 'muxVideo', type: 'Object' },
    ]);

    expect(entryFieldOptions(sdk)).toEqual([
      { id: 'title', name: 'title label', type: 'Symbol', itemsType: undefined },
      { id: 'tags', name: 'tags label', type: 'Array', itemsType: 'Symbol' },
    ]);
  });
});

describe('buildOutputCandidates', () => {
  it('pre-fills by convention', () => {
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol' },
      { id: 'description', type: 'Text' },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
    ]);

    const candidates = buildOutputCandidates(sdk, summary);

    expect(candidates.map((candidate) => [candidate.key, candidate.suggestedFieldId])).toEqual([
      ['title', 'title'],
      ['description', 'description'],
      ['tags', 'tags'],
    ]);
  });

  it('prefers the more specific name when several match', () => {
    const sdk = buildSdk([
      { id: 'description', type: 'Text' },
      { id: 'seoDescription', type: 'Text' },
    ]);

    const description = buildOutputCandidates(sdk, summary).find(
      (candidate) => candidate.key === 'description'
    );
    expect(description?.suggestedFieldId).toBe('seoDescription');
  });

  it('only offers type-compatible fields', () => {
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol' },
      { id: 'publishedAt', type: 'Date' },
      { id: 'viewCount', type: 'Integer' },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
    ]);

    const candidates = buildOutputCandidates(sdk, summary);
    const titleCandidate = candidates.find((candidate) => candidate.key === 'title');
    const tagsCandidate = candidates.find((candidate) => candidate.key === 'tags');

    expect(titleCandidate?.compatibleFieldIds).toEqual(['title']);
    expect(tagsCandidate?.compatibleFieldIds).toEqual(['tags']);
  });

  it('reports no suggestion rather than guessing when nothing matches the convention', () => {
    const sdk = buildSdk([{ id: 'someOtherText', type: 'Symbol' }]);

    const titleCandidate = buildOutputCandidates(sdk, summary).find(
      (candidate) => candidate.key === 'title'
    );

    expect(titleCandidate?.suggestedFieldId).toBeUndefined();
    expect(titleCandidate?.compatibleFieldIds).toEqual(['someOtherText']);
  });

  it('offers nothing without a summary', () => {
    const sdk = buildSdk([{ id: 'title', type: 'Symbol' }]);
    expect(buildOutputCandidates(sdk, undefined)).toEqual([]);
    expect(buildOutputCandidates(sdk, { moderate: { jobId: 'rjob_2' } })).toEqual([]);
  });

  it('skips outputs the job did not produce', () => {
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol' },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
    ]);

    const candidates = buildOutputCandidates(sdk, {
      summarize: { jobId: 'rjob_1', title: 'Only a title' },
    });

    expect(candidates.map((candidate) => candidate.key)).toEqual(['title']);
  });
});

describe('wouldOverwrite', () => {
  it('treats empty values as safe to fill', () => {
    expect(wouldOverwrite(undefined)).toBe(false);
    expect(wouldOverwrite('')).toBe(false);
    expect(wouldOverwrite([])).toBe(false);
  });

  it('flags anything the editor already wrote', () => {
    expect(wouldOverwrite('Existing')).toBe(true);
    expect(wouldOverwrite(['a'])).toBe(true);
    expect(wouldOverwrite(0)).toBe(true);
  });
});

describe('currentFieldValue', () => {
  it('falls back to the field’s own locale when it is not localized', () => {
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol', locales: ['de-DE'], value: 'Ein Titel' },
    ]);
    expect(currentFieldValue(sdk, 'title', 'en-US')).toBe('Ein Titel');
  });

  it('returns undefined for a field that no longer exists', () => {
    const sdk = buildSdk([{ id: 'title', type: 'Symbol' }]);
    expect(currentFieldValue(sdk, 'gone', 'en-US')).toBeUndefined();
  });
});

describe('formatFieldValue', () => {
  it('renders lists readably', () => {
    expect(formatFieldValue(['a', 'b'])).toBe('a, b');
    expect(formatFieldValue('plain')).toBe('plain');
    expect(formatFieldValue(undefined)).toBe('');
  });
});

describe('applyOutputsToEntry', () => {
  it('writes only the selected fields, in the requested locale', async () => {
    const titleSetValue = vi.fn(async () => undefined);
    const tagsSetValue = vi.fn(async () => undefined);
    const sdk = buildSdk([
      { id: 'title', type: 'Symbol', setValue: titleSetValue },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' }, setValue: tagsSetValue },
    ]);
    const candidates = buildOutputCandidates(sdk, summary);
    const titleCandidate = candidates.find(
      (candidate) => candidate.key === 'title'
    ) as RobotsOutputCandidate;

    const result = await applyOutputsToEntry(
      sdk,
      [{ candidate: titleCandidate, fieldId: 'title' }],
      'en-US'
    );

    expect(titleSetValue).toHaveBeenCalledWith('Generated title', 'en-US');
    expect(tagsSetValue).not.toHaveBeenCalled();
    expect(result.applied).toEqual([{ fieldId: 'title', key: 'title' }]);
    expect(result.failed).toEqual([]);
  });

  it('keeps going when one field is rejected, and reports which', async () => {
    const sdk = buildSdk([
      {
        id: 'title',
        type: 'Symbol',
        setValue: vi.fn(async () => {
          throw new Error('Too long');
        }),
      },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
    ]);
    const candidates = buildOutputCandidates(sdk, summary);

    const result = await applyOutputsToEntry(
      sdk,
      candidates
        .filter((candidate) => candidate.key !== 'description')
        .map((candidate) => ({ candidate, fieldId: candidate.key })),
      'en-US'
    );

    expect(result.applied).toEqual([{ fieldId: 'tags', key: 'tags' }]);
    expect(result.failed).toEqual([{ fieldId: 'title', key: 'title', message: 'Too long' }]);
  });

  it('reports a field that disappeared instead of throwing', async () => {
    const sdk = buildSdk([{ id: 'title', type: 'Symbol' }]);
    const candidate = buildOutputCandidates(sdk, summary)[0];

    const result = await applyOutputsToEntry(sdk, [{ candidate, fieldId: 'gone' }], 'en-US');

    expect(result.failed[0].message).toBe('Field no longer exists.');
  });
});
