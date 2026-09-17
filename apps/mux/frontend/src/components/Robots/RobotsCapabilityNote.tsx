import { FC, ReactNode } from 'react';
import { Box, Note, Paragraph } from '@contentful/f36-components';
import { RobotsCapabilityState } from '../../util/robotsTypes';
import { ROBOTS_DOCS_URL, ROBOTS_PRICING_URL, ROBOTS_TOKEN_DOCS_URL } from '../../util/robots';
import ExternalLink from '../ExternalLink';

/**
 * The three non-enabled capability states, each with its own copy.
 *
 * They are only distinguishable because `muxProxy` forwards Mux's `error.type`: with a status code
 * alone, "your org has not enabled Robots", "your token predates the `robots:*` scope" and "you
 * are out of units" are all just a 403, and an editor cannot act on that.
 */

interface RobotsCapabilityNoteProps {
  state: Exclude<RobotsCapabilityState, 'enabled'>;
  /** Mux's own message, when there is one worth showing verbatim. */
  message?: string;
}

interface CapabilityCopy {
  variant: 'warning' | 'neutral';
  title: string;
  testId: string;
  body: ReactNode;
}

const COPY: Record<Exclude<RobotsCapabilityState, 'enabled'>, CapabilityCopy> = {
  'scope-missing': {
    variant: 'warning',
    title: 'This Mux token cannot use Robots',
    testId: 'robots-scope-missing',
    body: (
      <>
        The <code>robots:*</code> scope cannot be added to a token that already exists, so this
        needs a new access token rather than a settings change. Generate one with the{' '}
        <code>robots:*</code> scope in{' '}
        <ExternalLink href={ROBOTS_TOKEN_DOCS_URL}>your Mux dashboard</ExternalLink> and paste it
        into this app&apos;s configuration.
      </>
    ),
  },
  'units-exhausted': {
    variant: 'warning',
    title: 'Out of Mux AI units this month',
    testId: 'robots-units-exhausted',
    body: (
      <>
        Every Mux account gets 100,000 AI units a month at no cost, and this one has used them up.
        Runs will work again next month, or sooner on a paid plan —{' '}
        <ExternalLink href={ROBOTS_PRICING_URL}>see Robots pricing</ExternalLink>.
      </>
    ),
  },
  'not-enabled': {
    variant: 'neutral',
    title: 'Robots is not enabled for this Mux account',
    testId: 'robots-not-enabled',
    body: (
      <>
        Robots runs AI workflows — captions, dubs, summaries, chapters, moderation — against your
        Mux videos, and writes the results back here.{' '}
        <ExternalLink href={ROBOTS_DOCS_URL}>Read how to turn it on</ExternalLink>.
      </>
    ),
  },
};

const RobotsCapabilityNote: FC<RobotsCapabilityNoteProps> = ({ state, message }) => {
  const copy = COPY[state] ?? COPY['not-enabled'];

  return (
    <Box marginTop="spacingM" marginBottom="spacingM">
      <Note variant={copy.variant} title={copy.title} data-testid={copy.testId}>
        <Paragraph marginBottom="none">{copy.body}</Paragraph>
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
