import { FC } from 'react';
import { Box, Note, Paragraph, TextLink } from '@contentful/f36-components';
import { ExternalLinkIcon } from '@contentful/f36-icons';
import { RobotsCapabilityState } from '../../util/robotsTypes';
import { ROBOTS_DOCS_URL, ROBOTS_PRICING_URL, ROBOTS_TOKEN_DOCS_URL } from '../../util/robots';

/**
 * The four capability states, each with its own copy.
 *
 * They are only distinguishable because `muxProxy` forwards Mux's `error.type`: with a status
 * code alone, "your org has not enabled Robots", "your token predates the `robots:*` scope" and
 * "you are out of units" are all just a 403, and an editor cannot act on that.
 */
interface RobotsCapabilityNoteProps {
  state: Exclude<RobotsCapabilityState, 'enabled'>;
  /** Mux's own message, when there is one worth showing verbatim. */
  message?: string;
}

const RobotsCapabilityNote: FC<RobotsCapabilityNoteProps> = ({ state, message }) => {
  if (state === 'scope-missing') {
    return (
      <Box marginTop="spacingM" marginBottom="spacingM">
        <Note variant="warning" title="This Mux token cannot use Robots" data-testid="robots-scope-missing">
          <Paragraph marginBottom="none">
            The <code>robots:*</code> scope cannot be added to a token that already exists, so this
            needs a new access token rather than a settings change. Generate one with the{' '}
            <code>robots:*</code> scope in{' '}
            <TextLink
              href={ROBOTS_TOKEN_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLinkIcon />}
              alignIcon="end">
              your Mux dashboard
            </TextLink>{' '}
            and paste it into this app&apos;s configuration.
          </Paragraph>
          {message && (
            <Paragraph marginTop="spacingXs" marginBottom="none">
              <small>Mux said: {message}</small>
            </Paragraph>
          )}
        </Note>
      </Box>
    );
  }

  if (state === 'units-exhausted') {
    return (
      <Box marginTop="spacingM" marginBottom="spacingM">
        <Note variant="warning" title="Out of Mux AI units this month" data-testid="robots-units-exhausted">
          <Paragraph marginBottom="none">
            Every Mux account gets 100,000 AI units a month at no cost, and this one has used them
            up. Runs will work again next month, or sooner on a paid plan —{' '}
            <TextLink
              href={ROBOTS_PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLinkIcon />}
              alignIcon="end">
              see Robots pricing
            </TextLink>
            .
          </Paragraph>
          {message && (
            <Paragraph marginTop="spacingXs" marginBottom="none">
              <small>Mux said: {message}</small>
            </Paragraph>
          )}
        </Note>
      </Box>
    );
  }

  return (
    <Box marginTop="spacingM" marginBottom="spacingM">
      <Note variant="neutral" title="Robots is not enabled for this Mux account" data-testid="robots-not-enabled">
        <Paragraph marginBottom="none">
          Robots runs AI workflows — captions, dubs, summaries, chapters, moderation — against
          your Mux videos, and writes the results back here.{' '}
          <TextLink
            href={ROBOTS_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            icon={<ExternalLinkIcon />}
            alignIcon="end">
            Read how to turn it on
          </TextLink>
          .
        </Paragraph>
        {message && (
          <Paragraph marginTop="spacingXs" marginBottom="none">
            <small>Mux said: {message}</small>
          </Paragraph>
        )}
      </Note>
    </Box>
  );
};

export default RobotsCapabilityNote;
