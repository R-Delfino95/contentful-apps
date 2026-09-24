import { FC } from 'react';
import { Box, Checkbox, FormControl, Note, Text } from '@contentful/f36-components';
import ExternalLink from '../ExternalLink';
import DirectiveId from '../DirectiveId';
import { ROBOTS_DOCS_URL } from '../../util/robots';

/**
 * The Automation section of the upload modal: which configured Robots directives run on this
 * upload.
 *
 * Directives are chosen once in the app configuration and pre-selected here, so automation does
 * not depend on anyone remembering. Deselecting is per upload — an editor who does not want to
 * spend units on this particular file can say so before it is created, which is the only moment
 * it can be said: a directive attaches at asset creation and there is no later opt-out.
 *
 * Names, with the id underneath. It used to render the raw id as the whole label, on the
 * reasoning that resolving names costs a Mux call not worth paying on every modal open. That
 * reasoning does not survive contact with the thing being asked: `drv_01H8X...` is not a
 * question anyone can answer, and the editor is being asked to decide whether to spend money on
 * it. The listing is one call, on a modal opened deliberately, it is not awaited, and the id is
 * what renders until it lands — so the cost is one request and the failure mode is exactly the
 * old behaviour. The id stays visible as help text because it is what the configuration screen
 * and the Mux dashboard identify a directive by.
 */

interface AutomationConfigurationProps {
  /** Directive ids from the installation parameters. */
  availableDirectiveIds: string[];
  /** Directive ids selected for this upload. */
  selectedDirectiveIds: string[];
  /** Configured ids Mux says it does not have. Shown, and not selectable. */
  missingDirectiveIds?: string[];
  /** id → name, already falling back to the id. See `useRobotsDirectiveNames`. */
  directiveNames?: Record<string, string>;
  onChange: (directiveIds: string[]) => void;
}

const AutomationConfiguration: FC<AutomationConfigurationProps> = ({
  availableDirectiveIds,
  selectedDirectiveIds,
  missingDirectiveIds = [],
  directiveNames,
  onChange,
}) => {
  if (availableDirectiveIds.length === 0) {
    return (
      <Note variant="neutral">
        No default Robots directives are configured. An admin can add them in this app&apos;s
        configuration so every new upload runs them automatically.{' '}
        <ExternalLink href={`${ROBOTS_DOCS_URL}-directives`}>About directives</ExternalLink>
      </Note>
    );
  }

  const toggle = (directiveId: string, isChecked: boolean) => {
    onChange(
      isChecked
        ? [...selectedDirectiveIds, directiveId]
        : selectedDirectiveIds.filter((id) => id !== directiveId)
    );
  };

  return (
    <FormControl>
      <FormControl.HelpText>
        These Robots directives run once this video is ingested and consume Mux AI units. Uncheck
        any you do not want for this upload.
      </FormControl.HelpText>
      <Box marginTop="spacingS">
        {availableDirectiveIds.map((directiveId) => {
          const name = directiveNames?.[directiveId] || directiveId;
          const isMissing = missingDirectiveIds.includes(directiveId);
          return (
            <Box key={directiveId} marginBottom="spacingXs">
              <Checkbox
                id={`mux-directive-${directiveId}`}
                name={`mux-directive-${directiveId}`}
                isDisabled={isMissing}
                isChecked={!isMissing && selectedDirectiveIds.includes(directiveId)}
                onChange={(event) =>
                  toggle(directiveId, (event.target as HTMLInputElement).checked)
                }>
                {name === directiveId ? <DirectiveId id={directiveId} /> : name}
              </Checkbox>
              {/* The Checkbox's own `helpText` is a string, which cannot wrap an id with no spaces
                  in it; the same tokens and indent, by hand. Omitted when the label already is
                  the id, so an unresolved directive does not render the same string twice. */}
              {name !== directiveId && (
                <Text as="p" fontColor="gray500" marginLeft="spacingL" isWordBreak>
                  {directiveId}
                </Text>
              )}
              {isMissing && (
                <Text as="p" fontColor="gray500" marginLeft="spacingL">
                  Mux does not have this directive, so it will not run. It was deleted, or the
                  app&apos;s configuration changed after this page loaded — reloading picks that up.
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </FormControl>
  );
};

export default AutomationConfiguration;
