import { FC } from 'react';
import { Box, Checkbox, FormControl, Note, TextLink } from '@contentful/f36-components';
import { ExternalLinkIcon } from '@contentful/f36-icons';
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
 * Directive *ids* rather than names, deliberately: resolving names needs a Mux call, and paying
 * for one on every upload modal open to label a checkbox is not worth it. The configuration
 * screen, where the ids are chosen, shows the names.
 */

interface AutomationConfigurationProps {
  /** Directive ids from the installation parameters. */
  availableDirectiveIds: string[];
  /** Directive ids selected for this upload. */
  selectedDirectiveIds: string[];
  onChange: (directiveIds: string[]) => void;
}

const AutomationConfiguration: FC<AutomationConfigurationProps> = ({
  availableDirectiveIds,
  selectedDirectiveIds,
  onChange,
}) => {
  if (availableDirectiveIds.length === 0) {
    return (
      <Note variant="neutral">
        No default Robots directives are configured. An admin can add them in this app&apos;s
        configuration so every new upload runs them automatically.{' '}
        <TextLink
          href={`${ROBOTS_DOCS_URL}-directives`}
          target="_blank"
          rel="noopener noreferrer"
          icon={<ExternalLinkIcon />}
          alignIcon="end">
          About directives
        </TextLink>
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
        {availableDirectiveIds.map((directiveId) => (
          <Checkbox
            key={directiveId}
            id={`mux-directive-${directiveId}`}
            name={`mux-directive-${directiveId}`}
            isChecked={selectedDirectiveIds.includes(directiveId)}
            onChange={(event) =>
              toggle(directiveId, (event.target as HTMLInputElement).checked)
            }>
            <code>{directiveId}</code>
          </Checkbox>
        ))}
      </Box>
    </FormControl>
  );
};

export default AutomationConfiguration;
