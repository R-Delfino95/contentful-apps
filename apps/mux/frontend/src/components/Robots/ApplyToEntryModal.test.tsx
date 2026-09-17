import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { FieldExtensionSDK } from '@contentful/app-sdk';
import ApplyToEntryModal from './ApplyToEntryModal';
import { richTextDocument } from '../../util/robotsEntryMapping';
import { RobotsOutputs } from '../../util/robotsTypes';

/**
 * The mapping dialog.
 *
 * One control per row is the thing these hold: the target dropdown is the entire decision, and
 * `Do not apply` is the only way to skip a row. There used to be a checkbox beside it, which meant
 * two controls disagreeing about a single choice — and a trap where picking an occupied field left
 * the row unticked, so Apply did nothing and said nothing.
 */

interface FakeField {
  id: string;
  type: string;
  items?: { type: string };
  value?: unknown;
  setValue?: ReturnType<typeof vi.fn>;
}

const buildSdk = (fields: FakeField[]) => {
  const setValues: Record<string, ReturnType<typeof vi.fn>> = {};
  const entryFields = Object.fromEntries(
    fields.map((field) => {
      setValues[field.id] = field.setValue ?? vi.fn(async () => undefined);
      return [
        field.id,
        {
          id: field.id,
          type: field.type,
          items: field.items,
          locales: ['en-US'],
          getValue: () => field.value,
          setValue: setValues[field.id],
        },
      ];
    })
  );

  const sdk = {
    field: { id: 'muxVideo' },
    locales: { default: 'en-US' },
    contentType: {
      fields: fields.map((field) => ({ id: field.id, name: `${field.id} label` })),
    },
    entry: { fields: entryFields },
    notifier: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  } as unknown as FieldExtensionSDK;

  return { sdk, setValues };
};

const outputs: RobotsOutputs = {
  summarize: {
    jobId: 'rjob_1',
    title: 'Generated title',
    description: 'Generated description',
    tags: ['alpha', 'beta'],
  },
};

const renderModal = (fields: FakeField[], summary: RobotsOutputs | undefined = outputs) => {
  const { sdk, setValues } = buildSdk(fields);
  const onClose = vi.fn();
  render(<ApplyToEntryModal isShown onClose={onClose} sdk={sdk} outputs={summary} />);
  return { sdk, setValues, onClose };
};

/** A content type with one obvious home for each of the three outputs. */
const oneFieldPerOutput: FakeField[] = [
  { id: 'title', type: 'Symbol' },
  { id: 'summary', type: 'Text' },
  { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
];

const applyButton = () => screen.getByRole('button', { name: /^Apply/ });
const targetFor = (label: string) => screen.getByLabelText(`Target field for ${label}`);

describe('ApplyToEntryModal — one control per row', () => {
  it('has no Apply column, and no checkbox anywhere', () => {
    renderModal([{ id: 'title', type: 'Symbol' }]);

    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent)
    ).toEqual(['Output', 'Target field', 'Current value', 'New value']);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('writes the field named in the dropdown, and nothing else', async () => {
    const { setValues } = renderModal([
      { id: 'title', type: 'Symbol' },
      { id: 'summary', type: 'Text' },
    ]);

    await userEvent.click(applyButton());

    await waitFor(() => expect(setValues.title).toHaveBeenCalledWith('Generated title', 'en-US'));
    expect(setValues.summary).toHaveBeenCalledWith('Generated description', 'en-US');
  });

  it('skips a row set to “Do not apply”, which is now the only way to skip one', async () => {
    const { sdk, setValues } = renderModal([
      { id: 'title', type: 'Symbol' },
      { id: 'summary', type: 'Text' },
    ]);

    await userEvent.selectOptions(targetFor('Title'), '');
    await userEvent.click(applyButton());

    await waitFor(() =>
      expect(setValues.summary).toHaveBeenCalledWith('Generated description', 'en-US')
    );
    expect(setValues.title).not.toHaveBeenCalled();
    // A skipped row must be dropped before the write, not handed to it as an empty field id —
    // which would come back as "Could not write : Field no longer exists." for a row the editor
    // deliberately turned off.
    expect(sdk.notifier.error).not.toHaveBeenCalled();
    expect(sdk.notifier.success).toHaveBeenCalledWith('Applied 1 generated value to this entry.');
  });

  it('disables Apply once every row is set to “Do not apply”', async () => {
    renderModal(oneFieldPerOutput);

    expect(applyButton()).toBeEnabled();
    for (const label of ['Title', 'Description', 'Tags']) {
      await userEvent.selectOptions(targetFor(label), '');
    }

    expect(applyButton()).toBeDisabled();
  });

  /**
   * The old two-control version reset the checkbox to unticked whenever the chosen field held
   * content, so deliberately picking a field to replace it did nothing at all. With the checkbox
   * gone, picking the field *is* the intent.
   */
  it('applies an occupied field the editor picks on purpose', async () => {
    const { setValues } = renderModal([
      { id: 'title', type: 'Symbol', value: 'The editor’s own title' },
    ]);

    expect(applyButton()).toBeDisabled();
    await userEvent.selectOptions(targetFor('Title'), 'title');

    expect(applyButton()).toBeEnabled();
    await userEvent.click(applyButton());
    await waitFor(() => expect(setValues.title).toHaveBeenCalledWith('Generated title', 'en-US'));
  });

  it('leaves a field that already has content unselected, and says which field that was', () => {
    renderModal([
      { id: 'title', type: 'Symbol', value: 'The editor’s own title' },
      { id: 'summary', type: 'Text' },
      { id: 'tags', type: 'Array', items: { type: 'Symbol' } },
    ]);

    expect(targetFor('Title')).toHaveValue('');
    const row = screen.getByText('Title').closest('tr') as HTMLElement;
    expect(
      within(row).getByText(
        /title label already has content\. Pick it as the target to replace it\./
      )
    ).toBeInTheDocument();
  });

  it('warns on the row it will overwrite, showing what is there now', async () => {
    renderModal([{ id: 'title', type: 'Symbol', value: 'The editor’s own title' }]);

    await userEvent.selectOptions(targetFor('Title'), 'title');

    const row = screen.getByText('Title').closest('tr') as HTMLElement;
    expect(within(row).getByText('Will be replaced')).toBeInTheDocument();
    expect(within(row).getByText('The editor’s own title')).toBeInTheDocument();
  });
});

describe('ApplyToEntryModal — rich text targets', () => {
  it('offers a rich text field for the description', () => {
    renderModal([{ id: 'description', type: 'RichText' }]);

    expect(
      Array.from((targetFor('Description') as HTMLSelectElement).options).map(
        (option) => option.value
      )
    ).toEqual(['', 'description']);
  });

  it('writes a document to it rather than a bare string', async () => {
    const { setValues } = renderModal([{ id: 'description', type: 'RichText' }]);

    await userEvent.click(applyButton());

    await waitFor(() =>
      expect(setValues.description).toHaveBeenCalledWith(
        richTextDocument('Generated description'),
        'en-US'
      )
    );
  });

  it('previews an occupied rich text field as its text, not as JSON', async () => {
    renderModal([
      { id: 'description', type: 'RichText', value: richTextDocument('What is there now') },
    ]);

    await userEvent.selectOptions(targetFor('Description'), 'description');

    const row = screen.getByText('Description').closest('tr') as HTMLElement;
    expect(within(row).getByText('What is there now')).toBeInTheDocument();
  });
});

describe('ApplyToEntryModal — table layout', () => {
  /**
   * Issue: the target dropdown rendered about one character wide. An F36 `Select` is
   * `width: 100%`, so it asks the table for no width of its own and the two prose columns took
   * everything. Every column therefore names its share, and the dropdown gets more than the label
   * beside it.
   */
  it('gives every column an explicit share, with Target field wider than Output', () => {
    renderModal([{ id: 'title', type: 'Symbol' }]);

    const widthOf = (name: string) =>
      Number.parseInt(
        screen.getByRole('columnheader', { name }).getAttribute('width') ?? '',
        10
      );

    for (const name of ['Output', 'Target field', 'Current value', 'New value']) {
      expect(widthOf(name)).toBeGreaterThan(0);
    }
    expect(widthOf('Target field')).toBeGreaterThan(widthOf('Output'));
    expect(
      ['Output', 'Target field', 'Current value', 'New value'].reduce(
        (total, name) => total + widthOf(name),
        0
      )
    ).toBe(100);
  });
});

describe('ApplyToEntryModal — nothing to map', () => {
  it('says so when no summary has been generated', () => {
    const { sdk } = buildSdk([{ id: 'title', type: 'Symbol' }]);
    render(<ApplyToEntryModal isShown onClose={vi.fn()} sdk={sdk} />);

    expect(screen.getByText(/There is no generated summary to apply yet/)).toBeInTheDocument();
  });

  it('names rich text among the field types that would work', () => {
    renderModal([{ id: 'publishedAt', type: 'Date' }]);

    expect(
      screen.getByText(/Add a short-text, long-text, rich-text or list-of-text field/)
    ).toBeInTheDocument();
  });
});
