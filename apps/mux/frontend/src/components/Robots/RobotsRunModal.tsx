import { FC, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Flex,
  Form,
  FormControl,
  Modal,
  Note,
  Paragraph,
  Select,
  Text,
  TextLink,
} from '@contentful/f36-components';
import { ExternalLinkIcon } from '@contentful/f36-icons';
import {
  ROBOTS_CATALOG,
  ROBOTS_CATALOG_BY_KEY,
  ROBOTS_CATEGORIES,
  defaultParamValues,
  paramsFromFormValues,
  validateParams,
} from '../../util/robotsCatalog';
import { RobotsWorkflow } from '../../util/robotsTypes';
import { ROBOTS_PRICING_URL } from '../../util/robots';
import { Track } from '../../util/types';
import RobotsParamFields from './RobotsParamFields';

interface RobotsRunModalProps {
  isShown: boolean;
  onClose: () => void;
  onRun: (workflow: RobotsWorkflow, parameters: Record<string, unknown>) => Promise<void>;
  assetId: string;
  captions: Track[];
  audioTracks: Track[];
  /**
   * Whether the Mux asset is audio-only. Optional and deliberately tri-state: `undefined` means
   * the caller does not know, which must never block a run.
   */
  isAudioOnly?: boolean;
  /** True while a create is in flight, or unconfirmed — Run stays disabled either way. */
  isRunDisabled: boolean;
  /** Why Run is unavailable, when it is for a reason worth explaining. */
  runDisabledReason?: string;
  initialWorkflow?: RobotsWorkflow;
}

const RobotsRunModal: FC<RobotsRunModalProps> = ({
  isShown,
  onClose,
  onRun,
  assetId,
  captions,
  audioTracks,
  isAudioOnly,
  isRunDisabled,
  runDisabledReason,
  initialWorkflow,
}) => {
  const [workflow, setWorkflow] = useState<RobotsWorkflow>(initialWorkflow ?? 'summarize');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const definition = ROBOTS_CATALOG_BY_KEY[workflow];

  // One context object for all three consumers — which fields render, which are validated, and
  // which are sent. Sharing it is the point: a field hidden because of what the asset is must not
  // then be validated or sent, exactly as with the `showWhen`s that key off another field.
  const context = useMemo(
    () => ({ hasCaptions: captions.length > 0, isAudioOnly }),
    [captions.length, isAudioOnly]
  );

  // Reset the form whenever the modal opens or the workflow changes, so options from a previous
  // workflow can never leak into the next job's parameters.
  useEffect(() => {
    setValues(defaultParamValues(definition.params));
    setConfirming(false);
  }, [definition, isShown]);

  useEffect(() => {
    if (isShown && initialWorkflow) setWorkflow(initialWorkflow);
  }, [isShown, initialWorkflow]);

  const errors = useMemo(
    () => validateParams(definition, values, context),
    [definition, values, context]
  );

  const handleChange = (name: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [name]: value }));
  };

  const handleContinue = () => {
    if (errors.length > 0) return;
    setConfirming(true);
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onRun(workflow, paramsFromFormValues(definition, assetId, values, context));
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isShown={isShown} onClose={onClose} size="large">
      {() => (
        <>
          <Modal.Header title={confirming ? 'Confirm this run' : 'Run a Robots workflow'} onClose={onClose} />
          <Modal.Content>
            {confirming ? (
              <>
                {/* CF 4: nothing runs without an explicit confirm that names the workflow and
                    links pricing. Robots is billed per AI unit, and the editor is the one
                    spending them. */}
                <Paragraph>
                  This will run <strong>{definition.label}</strong> on this video and consume Mux AI
                  units from your account.
                </Paragraph>
                <Paragraph>
                  Robots is billed per AI unit. The first 100,000 units each month are free —{' '}
                  <TextLink
                    href={ROBOTS_PRICING_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    icon={<ExternalLinkIcon />}
                    alignIcon="end">
                    see pricing
                  </TextLink>
                  .
                </Paragraph>
                {definition.producesTrack && (
                  <Note variant="neutral">
                    The result is attached to the Mux video, so it works in your players straight
                    away. It also lands in this entry as an unpublished change until you publish.
                  </Note>
                )}
                {(definition.notes ?? []).map((note) => (
                  <Box key={note} marginTop="spacingS">
                    <Note variant="warning">{note}</Note>
                  </Box>
                ))}
              </>
            ) : (
              <Form>
                {/* The id lives on FormControl, which is what wires `htmlFor` to the control. */}
                <FormControl id="robots-workflow" marginBottom="spacingM">
                  <FormControl.Label>Workflow</FormControl.Label>
                  <Select
                    value={workflow}
                    onChange={(event) =>
                      setWorkflow((event.target as HTMLSelectElement).value as RobotsWorkflow)
                    }>
                    {ROBOTS_CATEGORIES.map((category) => (
                      <optgroup key={category} label={category}>
                        {ROBOTS_CATALOG.filter(
                          (candidate) => candidate.category === category
                        ).map((candidate) => (
                          <Select.Option key={candidate.key} value={candidate.key}>
                            {candidate.label}
                          </Select.Option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                  <FormControl.HelpText>{definition.description}</FormControl.HelpText>
                </FormControl>

                <Flex gap="spacingXs" marginBottom="spacingM" flexWrap="wrap">
                  {definition.producesTrack && <Badge variant="primary">Adds a track</Badge>}
                  {definition.planRestricted && <Badge variant="warning">Plan dependent</Badge>}
                  {definition.requiresViewData && (
                    <Badge variant="secondary">Needs Mux Data views</Badge>
                  )}
                </Flex>

                {(definition.notes ?? []).map((note) => (
                  <Box key={note} marginBottom="spacingM">
                    <Note variant="neutral">{note}</Note>
                  </Box>
                ))}

                <RobotsParamFields
                  fields={definition.params}
                  values={values}
                  onChange={handleChange}
                  captions={captions}
                  audioTracks={audioTracks}
                  context={context}
                />

                {/* Shown from the moment the form can say something is wrong, not held back
                    until Continue is pressed. These are the conditions that stop the run; a
                    validation message the editor first meets on the confirm step arrives after
                    they have committed, which is where "Needs at least one replacement rule" used
                    to surface. */}
                {errors.length > 0 && (
                  <Note variant="negative" title="Fix these before running">
                    {errors.map((error) => (
                      <Text key={error} as="p" marginBottom="none">
                        {error}
                      </Text>
                    ))}
                  </Note>
                )}
              </Form>
            )}
          </Modal.Content>
          <Modal.Controls>
            {confirming ? (
              <>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  Back
                </Button>
                <Button
                  variant="positive"
                  isDisabled={isRunDisabled || isSubmitting}
                  isLoading={isSubmitting}
                  onClick={handleConfirm}>
                  Run {definition.label}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  isDisabled={isRunDisabled}
                  onClick={handleContinue}
                  title={runDisabledReason}>
                  Continue
                </Button>
              </>
            )}
          </Modal.Controls>
        </>
      )}
    </Modal>
  );
};

export default RobotsRunModal;
