import { FC, useCallback, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  Note,
  Paragraph,
  Spinner,
  Text,
  TextInput,
} from '@contentful/f36-components';
import { CycleIcon, PlusIcon } from '@contentful/f36-icons';
import ExternalLink from './ExternalLink';
import ApiClient from '../util/apiClient';
import { RobotsDirective } from '../util/robotsTypes';
import { ROBOTS_DOCS_URL } from '../util/robots';

/**
 * The Robots section of the app configuration screen: which directives run on every new upload.
 *
 * **Why this calls `api.mux.com` directly** rather than going through `muxProxy` like the rest of
 * the app: this screen has to work *before* the app is installed. App action calls are scoped to
 * an app installation, and the first thing a new customer does here is paste credentials and
 * validate them — the same reason signing-key creation is a direct call. `muxProxy` also reads
 * credentials from `context.appInstallationParameters`, i.e. the *saved* ones, so a token pasted
 * but not yet saved would list the wrong account's directives, or none.
 *
 * **What happens if that direct call is blocked.** Mux granted Contentful a browser-CORS
 * exception, and whether it covers `/robots/v0/*` as well as the Video API paths is not settled.
 * So the picker degrades rather than breaking: if the fetch fails, directive ids can be pasted by
 * hand and everything downstream works identically. The list is a convenience, not the mechanism.
 */

interface RobotsConfigurationProps {
  tokenId?: string;
  tokenSecret?: string;
  directiveIds: string[];
  onChange: (directiveIds: string[]) => void;
}

/** `GET /robots/v0/directives` is paginated, so an account with many would silently truncate. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const RobotsConfiguration: FC<RobotsConfigurationProps> = ({
  tokenId,
  tokenSecret,
  directiveIds,
  onChange,
}) => {
  const [directives, setDirectives] = useState<RobotsDirective[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [hasTried, setHasTried] = useState(false);
  const [manualId, setManualId] = useState('');

  const hasCredentials = !!tokenId && !!tokenSecret;

  const loadDirectives = useCallback(async () => {
    if (!hasCredentials) return;
    setIsLoading(true);
    setLoadError(undefined);

    const apiClient = new ApiClient(tokenId as string, tokenSecret as string);
    const collected: RobotsDirective[] = [];

    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await apiClient.get(
          `/robots/v0/directives?limit=${PAGE_SIZE}&page=${page}`
        );

        if (response.status === 401) {
          setLoadError('Those Mux credentials were rejected. Check the token and secret above.');
          break;
        }
        if (response.status === 403) {
          setLoadError(
            'This token cannot read Robots directives. It needs the robots:* scope, which cannot be added to an existing token — generate a new one.'
          );
          break;
        }
        if (!response.ok) {
          setLoadError(`Mux returned ${response.status} when listing directives.`);
          break;
        }

        const body = await response.json();
        const items: RobotsDirective[] = body?.data ?? [];
        collected.push(...items);
        if (items.length < PAGE_SIZE) break;
      }

      setDirectives(collected);
    } catch (error) {
      // A CORS rejection surfaces as a TypeError with no useful detail, which is exactly the case
      // the manual entry below exists for.
      setLoadError(
        'Could not reach the Mux Robots API from the browser. Paste directive IDs below instead.'
      );
      console.error('[robots] Directive listing failed', error);
    } finally {
      setIsLoading(false);
      setHasTried(true);
    }
  }, [hasCredentials, tokenId, tokenSecret]);

  // Deliberately no fetch on mount.
  //
  // This section is on a screen every existing customer opens, and most of them do not have
  // Robots. Listing directives automatically would fire a cross-origin request to
  // `api.mux.com/robots/v0/directives` for all of them and, on a 403, put an error notice on a
  // configuration screen they came to for something else. Nothing happens until someone asks.

  const toggle = (directiveId: string, isChecked: boolean) => {
    onChange(
      isChecked
        ? Array.from(new Set([...directiveIds, directiveId]))
        : directiveIds.filter((id) => id !== directiveId)
    );
  };

  const addManualId = () => {
    const trimmed = manualId.trim();
    if (!trimmed) return;
    onChange(Array.from(new Set([...directiveIds, trimmed])));
    setManualId('');
  };

  const knownIds = new Set(directives.map((directive) => directive.id));
  const unlistedIds = directiveIds.filter((id) => !knownIds.has(id));

  return (
    <>
      <Paragraph>
        A directive runs several Robots workflows in order. Pick the ones that should run
        automatically on every video uploaded through this app — editors can still deselect them
        per upload, and run any directive ad hoc from the Robots tab.{' '}
        <ExternalLink href={`${ROBOTS_DOCS_URL}-directives`}>Author directives in Mux</ExternalLink>
      </Paragraph>

      {directiveIds.length > 0 ? (
        <Note variant="warning" title="This spends money on every upload">
          The {directiveIds.length === 1 ? 'directive' : 'directives'} selected below run on every
          video uploaded through this app and consume Mux AI units, with no per-video confirm step.
          Editors can deselect them per upload.
        </Note>
      ) : (
        <Note variant="neutral">
          Nothing runs automatically. Selecting a directive here means it runs on every new upload
          and consumes Mux AI units — leave this empty unless you want that.
        </Note>
      )}

      {!hasCredentials && (
        <Box marginTop="spacingM">
          <Note variant="neutral">
            Enter your Mux access token above to list this account&apos;s directives.
          </Note>
        </Box>
      )}

      {hasCredentials && (
        <Box marginTop="spacingM">
          <Flex alignItems="center" gap="spacingS" marginBottom="spacingS">
            <Button
              size="small"
              variant="secondary"
              startIcon={<CycleIcon />}
              isDisabled={isLoading}
              onClick={loadDirectives}>
              {directives.length > 0 ? 'Reload directives' : 'List directives'}
            </Button>
            {isLoading && <Spinner size="small" />}
          </Flex>

          {loadError && (
            <Box marginBottom="spacingM">
              <Note variant="warning">{loadError}</Note>
            </Box>
          )}

          {directives.map((directive) => (
            <Checkbox
              key={directive.id}
              id={`mux-robots-directive-${directive.id}`}
              name={`mux-robots-directive-${directive.id}`}
              helpText={directive.id}
              isChecked={directiveIds.includes(directive.id)}
              onChange={(event) =>
                toggle(directive.id, (event.target as HTMLInputElement).checked)
              }>
              {directive.name || directive.id}
            </Checkbox>
          ))}

          {hasTried && !isLoading && directives.length === 0 && !loadError && (
            <Note variant="neutral">
              This Mux account has no directives yet. Create one in Mux, then reload.
            </Note>
          )}

          {unlistedIds.length > 0 && (
            <Box marginTop="spacingM">
              <Text fontWeight="fontWeightDemiBold">Selected by ID</Text>
              {unlistedIds.map((id) => (
                <Checkbox
                  key={id}
                  id={`mux-robots-directive-manual-${id}`}
                  name={`mux-robots-directive-manual-${id}`}
                  isChecked
                  onChange={() => toggle(id, false)}>
                  <code>{id}</code>
                </Checkbox>
              ))}
            </Box>
          )}

          <FormControl id="mux-robots-directive-id" marginTop="spacingM">
            <FormControl.Label>Add a directive by ID</FormControl.Label>
            <Flex gap="spacingS">
              <TextInput
                name="mux-robots-directive-id"
                value={manualId}
                placeholder="drv_..."
                onChange={(event) => setManualId((event.target as HTMLInputElement).value)}
              />
              <Button
                variant="secondary"
                startIcon={<PlusIcon />}
                isDisabled={!manualId.trim()}
                onClick={addManualId}>
                Add
              </Button>
            </Flex>
            <FormControl.HelpText>
              Use this if the list above cannot load. IDs are shown on the directive in your Mux
              dashboard.
            </FormControl.HelpText>
          </FormControl>
        </Box>
      )}
    </>
  );
};

export default RobotsConfiguration;
