import { FieldExtensionSDK } from '@contentful/app-sdk';
import { RobotsOutputs } from './robotsTypes';

/**
 * Mapping generated Robots output onto the editor's own entry fields.
 *
 * No configuration anywhere: the candidate fields and their types come straight off
 * `sdk.contentType` and `sdk.entry.fields`, both already at hand in the field location. A
 * convention *pre-fills* the choice — the same trick `MetadataConfiguration` already uses to find
 * a `title` field and sync it to the Mux asset — and the apply dialog is itself the mapping UI.
 *
 * The asymmetry that makes this safe: `MetadataConfiguration` only *reads*, so guessing wrong
 * costs nothing. Applying output *writes*, so guessing wrong would overwrite an editor's copy.
 * Hence the convention only suggests; nothing is written without an explicit confirm against a
 * side-by-side preview, and a row is unchecked by default when it would replace existing content.
 *
 * The alternative — per-content-type instance parameters — was ruled out: instance parameter
 * *definitions* live in the App Definition, which Contentful owns and which is not in this repo,
 * and the form Contentful generates from them is free-text boxes where a typo in a field ID fails
 * silently until an editor clicks Apply.
 */

/** The pieces of Robots output that can be written onto an entry field. */
export type RobotsOutputKey = 'title' | 'description' | 'tags';

export interface RobotsOutputCandidate {
  key: RobotsOutputKey;
  label: string;
  /** The generated value, in the shape the target field expects. */
  value: string | string[];
  /** Field IDs whose type can hold this value. */
  compatibleFieldIds: string[];
  /** Convention-based suggestion, or undefined when nothing matched. */
  suggestedFieldId?: string;
}

export interface EntryFieldOption {
  id: string;
  name: string;
  type: string;
  itemsType?: string;
}

/** Ordered by how specific the name is, so `seoDescription` beats `description` when both exist. */
const CONVENTION: Record<RobotsOutputKey, RegExp[]> = {
  title: [/^title$/i, /^seoTitle$/i, /^metaTitle$/i, /^headline$/i, /^name$/i],
  description: [
    /^seoDescription$/i,
    /^metaDescription$/i,
    /^description$/i,
    /^summary$/i,
    /^excerpt$/i,
    /^abstract$/i,
  ],
  tags: [/^tags$/i, /^keywords$/i, /^topics$/i, /^categories$/i],
};

function canHoldText(field: EntryFieldOption): boolean {
  return field.type === 'Symbol' || field.type === 'Text';
}

function canHoldStringList(field: EntryFieldOption): boolean {
  return field.type === 'Array' && (field.itemsType === 'Symbol' || field.itemsType === 'Text');
}

function isCompatible(key: RobotsOutputKey, field: EntryFieldOption): boolean {
  return key === 'tags' ? canHoldStringList(field) : canHoldText(field);
}

/**
 * Every field on this entry that could receive generated text, with its human name.
 *
 * The Mux field itself is excluded — it is a JSON object and would never be type-compatible, but
 * being explicit costs nothing and documents the intent.
 */
export function entryFieldOptions(sdk: FieldExtensionSDK): EntryFieldOption[] {
  const namesById = new Map<string, string>();
  for (const contentTypeField of sdk.contentType?.fields ?? []) {
    namesById.set(contentTypeField.id, contentTypeField.name || contentTypeField.id);
  }

  return Object.values(sdk.entry?.fields ?? {})
    .filter((field) => field.id !== sdk.field?.id)
    .map((field) => ({
      id: field.id,
      name: namesById.get(field.id) ?? field.id,
      type: field.type,
      itemsType: field.items?.type,
    }));
}

function suggestFieldId(
  key: RobotsOutputKey,
  compatible: EntryFieldOption[]
): string | undefined {
  for (const pattern of CONVENTION[key]) {
    const match = compatible.find((field) => pattern.test(field.id));
    if (match) return match.id;
  }
  return undefined;
}

/**
 * Turns stored summarize output into the rows the apply dialog renders.
 *
 * Only summarize is mappable: moderation scores are numbers an editor would not paste into a text
 * field, captions and dubs are already Mux tracks, and chapters/scenes/key moments are structured
 * arrays with no natural single-field home.
 */
export function buildOutputCandidates(
  sdk: FieldExtensionSDK,
  outputs: RobotsOutputs | undefined
): RobotsOutputCandidate[] {
  const summary = outputs?.summarize;
  if (!summary) return [];

  const options = entryFieldOptions(sdk);
  const candidates: RobotsOutputCandidate[] = [];

  const push = (key: RobotsOutputKey, label: string, value: string | string[] | undefined) => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
    const compatible = options.filter((field) => isCompatible(key, field));
    candidates.push({
      key,
      label,
      value,
      compatibleFieldIds: compatible.map((field) => field.id),
      suggestedFieldId: suggestFieldId(key, compatible),
    });
  };

  push('title', 'Title', summary.title);
  push('description', 'Description', summary.description);
  push('tags', 'Tags', summary.tags);

  return candidates;
}

export function currentFieldValue(
  sdk: FieldExtensionSDK,
  fieldId: string,
  locale: string
): unknown {
  const field = sdk.entry?.fields?.[fieldId];
  if (!field) return undefined;
  // A field not localized in this content type only has the default locale, and asking it for
  // another one throws.
  const target = field.locales?.includes(locale) ? locale : field.locales?.[0];
  return field.getValue(target);
}

export function formatFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** True when writing would replace content the editor already has. */
export function wouldOverwrite(current: unknown): boolean {
  if (current === undefined || current === null || current === '') return false;
  if (Array.isArray(current)) return current.length > 0;
  return true;
}

export interface ApplySelection {
  candidate: RobotsOutputCandidate;
  fieldId: string;
}

export interface ApplyResult {
  applied: Array<{ fieldId: string; key: RobotsOutputKey }>;
  failed: Array<{ fieldId: string; key: RobotsOutputKey; message: string }>;
}

/**
 * Writes the selected rows onto the entry.
 *
 * Each field is written independently and failures are collected rather than thrown, so one
 * field rejected by a validation does not silently discard the others the editor confirmed.
 */
export async function applyOutputsToEntry(
  sdk: FieldExtensionSDK,
  selections: ApplySelection[],
  locale: string
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], failed: [] };

  for (const { candidate, fieldId } of selections) {
    const field = sdk.entry?.fields?.[fieldId];
    if (!field) {
      result.failed.push({ fieldId, key: candidate.key, message: 'Field no longer exists.' });
      continue;
    }
    const target = field.locales?.includes(locale) ? locale : field.locales?.[0];
    try {
      await field.setValue(candidate.value, target);
      result.applied.push({ fieldId, key: candidate.key });
    } catch (error) {
      result.failed.push({
        fieldId,
        key: candidate.key,
        message: error instanceof Error ? error.message : 'Could not write this field.',
      });
    }
  }

  return result;
}
