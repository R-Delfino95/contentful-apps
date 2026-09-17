import { FC, useEffect, useMemo, useState } from 'react';
import { FieldExtensionSDK } from '@contentful/app-sdk';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Modal,
  Note,
  Paragraph,
  Select,
  Table,
  Text,
} from '@contentful/f36-components';
import {
  ApplySelection,
  RobotsOutputCandidate,
  applyOutputsToEntry,
  buildOutputCandidates,
  currentFieldValue,
  entryFieldOptions,
  formatFieldValue,
  wouldOverwrite,
} from '../../util/robotsEntryMapping';
import { RobotsOutputs } from '../../util/robotsTypes';

/**
 * "Apply to entry" — and the mapping UI, in one dialog.
 *
 * The mapping is not configured anywhere: the target dropdown is pre-filled by convention and
 * filtered to type-compatible fields, and the generated value sits beside the current one so the
 * editor can see exactly what a row would replace. A row that would overwrite existing content is
 * unchecked by default; nothing is written without an explicit confirm.
 */

interface ApplyToEntryModalProps {
  isShown: boolean;
  onClose: () => void;
  sdk: FieldExtensionSDK;
  outputs?: RobotsOutputs;
}

interface RowState {
  fieldId: string;
  isSelected: boolean;
}

const ApplyToEntryModal: FC<ApplyToEntryModalProps> = ({ isShown, onClose, sdk, outputs }) => {
  const locale = sdk.locales?.default ?? 'en-US';
  const candidates = useMemo(
    () => (isShown ? buildOutputCandidates(sdk, outputs) : []),
    [isShown, sdk, outputs]
  );
  const fieldOptions = useMemo(() => (isShown ? entryFieldOptions(sdk) : []), [isShown, sdk]);
  const fieldNames = useMemo(
    () => Object.fromEntries(fieldOptions.map((field) => [field.id, field.name])),
    [fieldOptions]
  );

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (!isShown) return;
    const initial: Record<string, RowState> = {};
    for (const candidate of candidates) {
      const fieldId = candidate.suggestedFieldId ?? candidate.compatibleFieldIds[0] ?? '';
      const existing = fieldId ? currentFieldValue(sdk, fieldId, locale) : undefined;
      initial[candidate.key] = {
        fieldId,
        // Pre-select only where nothing is lost. A row that would replace the editor's own copy
        // has to be ticked deliberately.
        isSelected: !!fieldId && !wouldOverwrite(existing),
      };
    }
    setRows(initial);
  }, [isShown, candidates, sdk, locale]);

  const handleApply = async () => {
    const selections: ApplySelection[] = candidates
      .map((candidate) => ({ candidate, fieldId: rows[candidate.key]?.fieldId ?? '' }))
      .filter(({ candidate, fieldId }) => !!fieldId && rows[candidate.key]?.isSelected);

    if (selections.length === 0) {
      onClose();
      return;
    }

    setIsApplying(true);
    try {
      const result = await applyOutputsToEntry(sdk, selections, locale);
      if (result.applied.length > 0) {
        sdk.notifier.success(
          `Applied ${result.applied.length} generated ${
            result.applied.length === 1 ? 'value' : 'values'
          } to this entry.`
        );
      }
      for (const failure of result.failed) {
        sdk.notifier.error(
          `Could not write ${fieldNames[failure.fieldId] ?? failure.fieldId}: ${failure.message}`
        );
      }
      onClose();
    } finally {
      setIsApplying(false);
    }
  };

  const selectedCount = candidates.filter((candidate) => rows[candidate.key]?.isSelected).length;

  return (
    <Modal isShown={isShown} onClose={onClose} size="large">
      {() => (
        <>
          <Modal.Header title="Apply generated text to this entry" onClose={onClose} />
          <Modal.Content>
            {candidates.length === 0 ? (
              <Note variant="neutral">
                There is no generated summary to apply yet. Run the Summarize workflow first.
              </Note>
            ) : (
              <>
                <Paragraph>
                  Writing to the <strong>{locale}</strong> locale. Nothing is saved to Mux — these
                  are your own entry fields, and the change stays a draft until you publish.
                </Paragraph>
                <Table>
                  <Table.Head>
                    <Table.Row>
                      <Table.Cell>Apply</Table.Cell>
                      <Table.Cell>Output</Table.Cell>
                      <Table.Cell>Target field</Table.Cell>
                      <Table.Cell>Current value</Table.Cell>
                      <Table.Cell>New value</Table.Cell>
                    </Table.Row>
                  </Table.Head>
                  <Table.Body>
                    {candidates.map((candidate) => (
                      <CandidateRow
                        key={candidate.key}
                        candidate={candidate}
                        state={rows[candidate.key]}
                        fieldNames={fieldNames}
                        locale={locale}
                        sdk={sdk}
                        onChange={(next) =>
                          setRows((previous) => ({ ...previous, [candidate.key]: next }))
                        }
                      />
                    ))}
                  </Table.Body>
                </Table>
                {candidates.some((candidate) => candidate.compatibleFieldIds.length === 0) && (
                  <Box marginTop="spacingM">
                    <Note variant="warning">
                      Some outputs have no field on this content type that could hold them. Add a
                      short-text, long-text or list-of-text field to map them.
                    </Note>
                  </Box>
                )}
              </>
            )}
          </Modal.Content>
          <Modal.Controls>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="positive"
              isDisabled={selectedCount === 0 || isApplying}
              isLoading={isApplying}
              onClick={handleApply}>
              Apply {selectedCount > 0 ? selectedCount : ''}
            </Button>
          </Modal.Controls>
        </>
      )}
    </Modal>
  );
};

interface CandidateRowProps {
  candidate: RobotsOutputCandidate;
  state?: RowState;
  fieldNames: Record<string, string>;
  locale: string;
  sdk: FieldExtensionSDK;
  onChange: (next: RowState) => void;
}

const CandidateRow: FC<CandidateRowProps> = ({
  candidate,
  state,
  fieldNames,
  locale,
  sdk,
  onChange,
}) => {
  const fieldId = state?.fieldId ?? '';
  const current = fieldId ? currentFieldValue(sdk, fieldId, locale) : undefined;
  const overwrites = wouldOverwrite(current);

  if (candidate.compatibleFieldIds.length === 0) {
    return (
      <Table.Row>
        <Table.Cell />
        <Table.Cell>{candidate.label}</Table.Cell>
        <Table.Cell colSpan={3}>
          <Text fontColor="gray600">No compatible field on this content type.</Text>
        </Table.Cell>
      </Table.Row>
    );
  }

  return (
    <Table.Row>
      <Table.Cell>
        <Checkbox
          id={`robots-apply-${candidate.key}`}
          isChecked={!!state?.isSelected}
          isDisabled={!fieldId}
          onChange={(event) =>
            onChange({ fieldId, isSelected: (event.target as HTMLInputElement).checked })
          }>
          {''}
        </Checkbox>
      </Table.Cell>
      <Table.Cell>{candidate.label}</Table.Cell>
      <Table.Cell>
        <Select
          id={`robots-apply-target-${candidate.key}`}
          value={fieldId}
          onChange={(event) => {
            const nextFieldId = (event.target as HTMLSelectElement).value;
            const nextCurrent = nextFieldId
              ? currentFieldValue(sdk, nextFieldId, locale)
              : undefined;
            onChange({
              fieldId: nextFieldId,
              isSelected: !!nextFieldId && !wouldOverwrite(nextCurrent),
            });
          }}>
          <Select.Option value="">Do not apply</Select.Option>
          {candidate.compatibleFieldIds.map((id) => (
            <Select.Option key={id} value={id}>
              {fieldNames[id] ?? id}
            </Select.Option>
          ))}
        </Select>
      </Table.Cell>
      <Table.Cell>
        {overwrites ? (
          <>
            <Badge variant="warning">Will be replaced</Badge>
            <Box marginTop="spacingXs">
              <Text fontSize="fontSizeS">{formatFieldValue(current)}</Text>
            </Box>
          </>
        ) : (
          <Text fontColor="gray600">Empty</Text>
        )}
      </Table.Cell>
      <Table.Cell>
        <Text fontSize="fontSizeS">{formatFieldValue(candidate.value)}</Text>
      </Table.Cell>
    </Table.Row>
  );
};

export default ApplyToEntryModal;
