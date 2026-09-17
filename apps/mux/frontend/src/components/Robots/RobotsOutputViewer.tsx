import { FC, ReactElement, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Flex,
  List,
  Modal,
  Note,
  Paragraph,
  Spinner,
  Table,
  Tabs,
  Text,
} from '@contentful/f36-components';
import { RobotsJob, robotsJobErrorMessage } from '../../util/robotsTypes';
import { workflowLabel } from '../../util/robotsCatalog';
import { MuxApiService } from '../../util/muxApi';
import CodeBlock from '../CodeBlock';

/**
 * Shows a finished job's output, two ways.
 *
 * **Result** is shaped per workflow for the ones with an obvious reading — a summary, a scene list,
 * an answer table — and falls back to the raw JSON for the rest. Better a readable view of the four
 * outputs editors actually act on than twelve half-designed ones, so it is the tab that opens.
 *
 * **Raw JSON** is the whole job, pretty-printed, for every workflow. It exists because the shaped
 * views keep being wrong in the same direction: they read one key, the job populated another, and
 * the modal showed a table with no rows. Three fixes on this feature have been that bug. A shaped
 * view can only show what someone anticipated; the raw tab shows what actually came back, so the
 * next time the two disagree it takes one click to see it rather than a proxy log.
 *
 * It is the whole job rather than just `outputs` on purpose. Both of the bugs this is meant to
 * shorten were diagnosable only from *outside* `outputs`: the list summary that carries no
 * `outputs` at all looks identical to an empty result until you can see that the key is missing
 * rather than empty, and an empty `audible_narrative` is explained by `parameters.use_shots` being
 * on — the run read the picture, not the transcript. `units_consumed` and `errors` are on the same
 * object and are the next two questions anyone asks. `outputs` is nested inside it, complete, so
 * nothing is lost by showing more.
 *
 * Every shaped view still goes through `shapedOrRaw`, and that is not decoration: a view that finds
 * nothing it knows how to draw hands back the raw JSON inline, which is never nothing.
 */

interface RobotsOutputViewerProps {
  /** The row the editor clicked. Comes from the job *list*, so it has no `outputs`. */
  job?: RobotsJob;
  muxApi?: MuxApiService;
  /**
   * Hands the fetched record back to the caller.
   *
   * This modal is the one place a job's full record is read on an interaction rather than on a
   * schedule, and the background read it complements is deliberately capped — so for a row past
   * that cap this fetch is the only detail that will ever exist for it. Throwing it away on close
   * meant the row went back to knowing nothing about its own Units immediately after showing the
   * editor the answer.
   */
  onLoaded?: (job: RobotsJob) => void;
  onClose: () => void;
}

const formatMs = (ms?: number): string => {
  if (typeof ms !== 'number') return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatSeconds = (seconds?: number): string =>
  typeof seconds === 'number' ? formatMs(seconds * 1000) : '—';

/**
 * Pretty-prints a payload for a JSON block, or returns undefined when there is nothing to print.
 *
 * `JSON.stringify` does not return a string for every input: `undefined` and a function both come
 * back as `undefined`, and a value with a cycle throws. Each of those rendered straight into a
 * block is a blank box, and a blank box is indistinguishable from a job that produced nothing —
 * the failure this feature has now relapsed into three times. So the ways of having nothing are
 * collapsed into one `undefined` here, and the caller says so in words.
 */
export const prettyJson = (value: unknown): string | undefined => {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
  } catch {
    // A cycle, or a `toJSON` that throws. Either way there is no text to show.
    return undefined;
  }
};

/**
 * The one way this app shows JSON.
 *
 * Same block as the Player code tab — boxed, scrollable inside itself, copyable through f36's
 * `CopyButton` and its `execCommand` fallback, which is what makes copy work inside the Contentful
 * iframe. Anything that used to reach for a bare `<pre>` comes through here instead.
 */
const JsonBlock: FC<{ value: unknown; what: string; testId?: string }> = ({
  value,
  what,
  testId,
}) => {
  const text = prettyJson(value);
  if (!text) {
    return (
      <Note variant="warning">
        There is nothing here to show as JSON — {what} came back empty or could not be read.
      </Note>
    );
  }
  return (
    <CodeBlock
      value={text}
      isMonospace
      tooltipText={`Copy ${what}`}
      tooltipCopiedText="Copied"
      testId={testId}
    />
  );
};

/**
 * A `find-key-moments` moment's narratives.
 *
 * Both are documented on every moment, and either can be empty depending on whether the job ran
 * on visual or transcript evidence — so both are labelled and neither is assumed.
 */
const NarrativeCell: FC<{ audible?: unknown; visual?: unknown; quotable?: string }> = ({
  audible,
  visual,
  quotable,
}) => {
  const spoken = typeof audible === 'string' ? audible.trim() : '';
  const seen = typeof visual === 'string' ? visual.trim() : '';
  if (!spoken && !seen && !quotable) return <>—</>;
  return (
    <>
      {!!spoken && (
        <Box marginBottom={seen || quotable ? 'spacingXs' : 'none'}>
          <Text fontColor="gray600">Heard: </Text>
          <Text>{spoken}</Text>
        </Box>
      )}
      {!!seen && (
        <Box marginBottom={quotable ? 'spacingXs' : 'none'}>
          <Text fontColor="gray600">Seen: </Text>
          <Text>{seen}</Text>
        </Box>
      )}
      {!!quotable && (
        <Box>
          <Text fontColor="gray600">Quote: </Text>
          <Text>{quotable}</Text>
        </Box>
      )}
    </>
  );
};

/**
 * The two `notable_*_concepts` arrays. They have different shapes on purpose — the audible one is
 * strings, the visual one is `{ concept, score, rationale }` objects — so each is read as what it
 * actually is rather than stringified.
 */
const ConceptBadges: FC<{ audible?: unknown; visual?: unknown }> = ({ audible, visual }) => {
  const spoken = Array.isArray(audible) ? (audible as unknown[]) : [];
  const seen = Array.isArray(visual) ? (visual as Array<Record<string, unknown>>) : [];
  if (spoken.length === 0 && seen.length === 0) return <>—</>;
  return (
    <Flex gap="spacingXs" flexWrap="wrap">
      {spoken
        .filter((concept): concept is string => typeof concept === 'string')
        .map((concept) => (
          <Badge key={`a-${concept}`} variant="secondary">
            {concept}
          </Badge>
        ))}
      {seen.map((concept, index) => (
        <Badge key={`v-${index}`} variant="primary">
          {String(concept.concept ?? '')}
          {typeof concept.score === 'number' ? ` · ${concept.score.toFixed(2)}` : ''}
        </Badge>
      ))}
    </Flex>
  );
};

/** A shaped view, or the raw JSON when the shape is not there after all. */
const shapedOrRaw = (
  hasContent: boolean,
  shaped: ReactElement,
  outputs: unknown
): ReactElement =>
  hasContent ? (
    shaped
  ) : (
    <>
      <Note variant="warning">
        This job completed, but its output is not in the shape this view knows how to draw. The
        raw result follows.
      </Note>
      <JsonBlock value={outputs} what="this output" testId="robots-output-json" />
    </>
  );

const OutputBody: FC<{ job: RobotsJob }> = ({ job }) => {
  const error = robotsJobErrorMessage(job);
  if (job.status === 'errored') {
    return <Note variant="negative">{error ?? 'This job failed without a message.'}</Note>;
  }
  if (job.status === 'cancelled') {
    return <Note variant="neutral">This job was cancelled.</Note>;
  }
  if (job.status !== 'completed') {
    return <Note variant="neutral">This job is still {job.status}.</Note>;
  }

  const outputs = job.outputs;
  if (!outputs || Object.keys(outputs).length === 0) {
    return (
      <Note variant="neutral">
        Mux reports this job as completed but returned no output for it.
      </Note>
    );
  }

  switch (job.workflow) {
    case 'summarize': {
      const tags = Array.isArray(outputs.tags) ? (outputs.tags as string[]) : [];
      return shapedOrRaw(
        typeof outputs.title === 'string' ||
          typeof outputs.description === 'string' ||
          tags.length > 0,
        <>
          {typeof outputs.title === 'string' && (
            <Box marginBottom="spacingM">
              <Text fontWeight="fontWeightDemiBold">Title</Text>
              <Paragraph marginBottom="none">{outputs.title}</Paragraph>
            </Box>
          )}
          {typeof outputs.description === 'string' && (
            <Box marginBottom="spacingM">
              <Text fontWeight="fontWeightDemiBold">Description</Text>
              <Paragraph marginBottom="none">{outputs.description}</Paragraph>
            </Box>
          )}
          {tags.length > 0 && (
            <Box marginBottom="spacingM">
              <Text fontWeight="fontWeightDemiBold">Tags</Text>
              <Flex gap="spacingXs" flexWrap="wrap" marginTop="spacingXs">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </Flex>
            </Box>
          )}
        </>,
        outputs
      );
    }

    case 'moderate': {
      const maxScores = (outputs.max_scores ?? {}) as Record<string, number>;
      return shapedOrRaw(
        Object.keys(maxScores).length > 0 || typeof outputs.exceeds_threshold === 'boolean',
        <>
          <Box marginBottom="spacingM">
            <Badge variant={outputs.exceeds_threshold ? 'negative' : 'positive'}>
              {outputs.exceeds_threshold ? 'Exceeds a threshold' : 'Within thresholds'}
            </Badge>
          </Box>
          <Table>
            <Table.Head>
              <Table.Row>
                <Table.Cell>Category</Table.Cell>
                <Table.Cell>Highest score</Table.Cell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {Object.entries(maxScores).map(([category, score]) => (
                <Table.Row key={category}>
                  <Table.Cell>{category}</Table.Cell>
                  <Table.Cell>{typeof score === 'number' ? score.toFixed(2) : '—'}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </>,
        outputs
      );
    }

    case 'ask-questions': {
      const answers = Array.isArray(outputs.answers)
        ? (outputs.answers as Array<Record<string, unknown>>)
        : [];
      return shapedOrRaw(
        answers.length > 0,
        <Table>
          <Table.Head>
            <Table.Row>
              <Table.Cell>Question</Table.Cell>
              <Table.Cell>Answer</Table.Cell>
              <Table.Cell>Confidence</Table.Cell>
              <Table.Cell>Reasoning</Table.Cell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {answers.map((answer, index) => (
              <Table.Row key={index}>
                <Table.Cell>{String(answer.question ?? '—')}</Table.Cell>
                <Table.Cell>
                  {answer.skipped ? <Badge variant="secondary">Skipped</Badge> : String(answer.answer ?? '—')}
                </Table.Cell>
                <Table.Cell>
                  {typeof answer.confidence === 'number' ? answer.confidence.toFixed(2) : '—'}
                </Table.Cell>
                <Table.Cell>{String(answer.reasoning ?? '')}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>,
        outputs
      );
    }

    case 'generate-chapters': {
      const chapters = Array.isArray(outputs.chapters)
        ? (outputs.chapters as Array<Record<string, unknown>>)
        : [];
      return shapedOrRaw(
        chapters.length > 0,
        <>
          <Note variant="neutral">
            Chapters are returned with the job. Mux does not store them on the video, so copy them
            wherever your player reads chapters from.
          </Note>
          <Box marginTop="spacingM">
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.Cell>Start</Table.Cell>
                  <Table.Cell>Title</Table.Cell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {chapters.map((chapter, index) => (
                  <Table.Row key={index}>
                    <Table.Cell>{formatSeconds(chapter.start_time as number)}</Table.Cell>
                    <Table.Cell>{String(chapter.title ?? '—')}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </Box>
        </>,
        outputs
      );
    }

    /**
     * The Summary column used to read `audible_narrative` and nothing else, and `visual_narrative`
     * was never rendered at all. A moment carries both, and which one is filled depends on the
     * evidence the job ran on: with `use_shots` on, selection reads the picture, so the visual
     * narrative is the one with the content and the audible one can be empty — a blank Summary
     * column on a job that had plenty to say. Both are shown, each labelled, so it is clear which
     * kind of evidence produced what.
     */
    case 'find-key-moments': {
      const moments = Array.isArray(outputs.moments)
        ? (outputs.moments as Array<Record<string, unknown>>)
        : [];
      return shapedOrRaw(
        moments.length > 0,
        <Table>
          <Table.Head>
            <Table.Row>
              <Table.Cell>Range</Table.Cell>
              <Table.Cell>Title</Table.Cell>
              <Table.Cell>Score</Table.Cell>
              <Table.Cell>Narrative</Table.Cell>
              <Table.Cell>Concepts</Table.Cell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {moments.map((moment, index) => {
              const quotable = moment.quotable_segment as { text?: unknown } | undefined;
              return (
                <Table.Row key={index}>
                  <Table.Cell>
                    {formatMs(moment.start_ms as number)} – {formatMs(moment.end_ms as number)}
                  </Table.Cell>
                  <Table.Cell>{String(moment.title ?? '—')}</Table.Cell>
                  <Table.Cell>
                    {typeof moment.overall_score === 'number'
                      ? moment.overall_score.toFixed(2)
                      : '—'}
                  </Table.Cell>
                  <Table.Cell>
                    <NarrativeCell
                      audible={moment.audible_narrative}
                      visual={moment.visual_narrative}
                      quotable={typeof quotable?.text === 'string' ? quotable.text : undefined}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <ConceptBadges
                      audible={moment.notable_audible_concepts}
                      visual={moment.notable_visual_concepts}
                    />
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>,
        outputs
      );
    }

    case 'find-scenes': {
      const scenes = Array.isArray(outputs.scenes)
        ? (outputs.scenes as Array<Record<string, unknown>>)
        : [];
      return shapedOrRaw(
        scenes.length > 0,
        <Table>
          <Table.Head>
            <Table.Row>
              <Table.Cell>Range</Table.Cell>
              <Table.Cell>Title</Table.Cell>
              <Table.Cell>Summary</Table.Cell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {scenes.map((scene, index) => (
              <Table.Row key={index}>
                <Table.Cell>
                  {formatMs(scene.start_ms as number)} – {formatMs(scene.end_ms as number)}
                </Table.Cell>
                <Table.Cell>{String(scene.title ?? '—')}</Table.Cell>
                <Table.Cell>
                  {String(
                    scene.blended_narrative ??
                      scene.audible_narrative ??
                      scene.visual_narrative ??
                      ''
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>,
        outputs
      );
    }

    case 'find-best-thumbnails': {
      const thumbnails = Array.isArray(outputs.best_thumbnails)
        ? (outputs.best_thumbnails as Array<Record<string, unknown>>)
        : [];
      return shapedOrRaw(
        thumbnails.length > 0,
        <Table>
          <Table.Head>
            <Table.Row>
              <Table.Cell>Timestamp</Table.Cell>
              <Table.Cell>Score</Table.Cell>
              <Table.Cell>Description</Table.Cell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {thumbnails.map((thumbnail, index) => (
              <Table.Row key={index}>
                <Table.Cell>{formatMs(thumbnail.timestamp_ms as number)}</Table.Cell>
                <Table.Cell>
                  {typeof thumbnail.overall === 'number' ? thumbnail.overall.toFixed(2) : '—'}
                </Table.Cell>
                <Table.Cell>{String(thumbnail.description ?? '')}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>,
        outputs
      );
    }

    case 'generate-engagement-insights': {
      const overall = (outputs.overall_insight ?? {}) as Record<string, unknown>;
      const trends = Array.isArray(overall.trends) ? (overall.trends as string[]) : [];
      const moments = Array.isArray(outputs.moment_insights)
        ? (outputs.moment_insights as unknown[])
        : [];
      return shapedOrRaw(
        typeof overall.summary === 'string' || trends.length > 0 || moments.length > 0,
        <>
          {typeof overall.summary === 'string' && <Paragraph>{overall.summary}</Paragraph>}
          {trends.length > 0 && (
            <List>
              {trends.map((trend) => (
                <List.Item key={trend}>{trend}</List.Item>
              ))}
            </List>
          )}
          {moments.length > 0 && (
            <JsonBlock value={moments} what="these moment insights" testId="robots-output-json" />
          )}
        </>,
        outputs
      );
    }

    /**
     * Nothing to shape: what these four produce is a track on the Mux asset, not a document. The
     * note is the result; the output alongside it is the track ids, which is what someone chasing
     * a track that has not appeared actually needs.
     */
    case 'generate-premium-captions':
    case 'edit-captions':
    case 'translate-captions':
    case 'translate-audio':
      return (
        <>
          <Note variant="positive">
            The generated track is on the Mux video. Resync the asset if it has not shown up in the
            Captions or Audio Tracks tab yet.
          </Note>
          <JsonBlock value={outputs} what="this output" testId="robots-output-json" />
        </>
      );

    /**
     * Unreachable for the twelve workflows in `ROBOTS_WORKFLOWS` — every one of them is cased
     * above. It catches a workflow Mux adds that this build has never heard of, which is exactly
     * when saying "no shaped view" out loud beats rendering an unlabelled block.
     */
    default:
      return (
        <>
          <Note variant="neutral">
            This app has no shaped view for {String(job.workflow)} yet. Here is what the job
            returned.
          </Note>
          <JsonBlock value={outputs} what="this output" testId="robots-output-json" />
        </>
      );
  }
};

/**
 * The Raw JSON tab: the whole job, for any status.
 *
 * The note is the point of the thing. A completed job with no `outputs` and a completed job whose
 * `outputs` this build cannot read look the same from the Result tab, and both used to look like
 * an empty modal. Here the difference is legible — and if there is no payload at all, the tab says
 * so rather than showing an empty box.
 */
const RawJobView: FC<{ job: RobotsJob }> = ({ job }) => {
  const hasOutputs = !!job.outputs && Object.keys(job.outputs).length > 0;
  return (
    <>
      {!hasOutputs && (
        <Note variant="warning">
          This job came back with no outputs. Everything Mux did return for it is below.
        </Note>
      )}
      <JsonBlock value={job} what="this job" testId="robots-raw-json" />
    </>
  );
};

/**
 * What one fetch came back with, and **which job it was about**.
 *
 * The id is the load-bearing part. This used to be three independent pieces of state — `detailed`,
 * `isLoading`, `error` — and only the first was ever tied to the job on screen. That is how the
 * reported hang worked. The panel reads a terminal job's detail in the background and hands the
 * viewer `jobDetails[id] ?? viewedJob`, so opening the modal inside that window starts a fetch
 * that the arriving detail then supersedes. The effect's cleanup set `cancelled`, which skipped
 * the `finally` that cleared `isLoading`; the effect run that replaced it returned early, because
 * the job now carried its outputs, without clearing it either. A spinner describing a request that
 * no longer existed, and nothing left to re-run the effect that would take it down. Not even
 * closing the modal: `job` going undefined cleared the payload and left the flag set, so the next
 * job opened inherited it. Only an F5 cleared it.
 *
 * So there is no flag any more. `isLoading` is *derived* — see below — which makes "the request
 * was cancelled and nothing replaced it" indistinguishable from "no answer yet", which is the
 * truth, rather than from "still loading forever".
 */
interface ViewerResult {
  jobId: string;
  /** The fetched record. Absent when the fetch failed, or when Mux answered with no job at all. */
  job?: RobotsJob;
  message?: string;
}

const RobotsOutputViewer: FC<RobotsOutputViewerProps> = ({ job, muxApi, onLoaded, onClose }) => {
  const [result, setResult] = useState<ViewerResult | undefined>();

  const jobId = job?.id;
  const workflow = job?.workflow;
  /** Present when the caller already holds the full record — a create response, or the panel's cache. */
  const inlineOutputs = job?.outputs;

  /**
   * Fetch the job in full when the modal opens.
   *
   * `GET /robots/v0/jobs` returns a summary of each job — enough for the status table, but with
   * no `outputs`. So the row the editor clicked has nothing to show, which is exactly what an
   * empty modal looked like. The single-job GET is the only place the output lives, and fetching
   * it here rather than for every job in the list means we only pay for the ones someone opens.
   *
   * Keyed on what the fetch actually depends on — the id, the workflow, and whether the outputs
   * are already in hand — rather than on the identity of the `job` object. The panel rebuilds that
   * object from a fresh list array on every poll tick, and while nothing upstream changes its
   * identity mid-view today, keying on identity means any future change that does would cancel and
   * restart this fetch on a six-second cadence: a spinner that cannot resolve for as long as
   * anything on the asset is in flight. Nothing on screen would distinguish that from a slow Mux,
   * so the effect does not depend on identity in the first place.
   */
  useEffect(() => {
    // Nothing to fetch: no job open, or the caller already handed over the whole record.
    if (!jobId || !workflow || inlineOutputs) return;

    if (!muxApi) {
      setResult({ jobId, message: 'The Mux client is not ready yet.' });
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await muxApi.getRobotsJob(workflow, jobId);
        // `cancelled` means a later effect run superseded this one, and that run owns the state
        // now. Nothing is left behind by saying nothing here, because there is no flag to clear.
        if (cancelled) return;
        setResult({ jobId, job: response.data });
        // The caller keeps the record, so the row behind this modal stops saying it never asked.
        if (response.data) onLoaded?.(response.data);
      } catch (fetchError) {
        if (cancelled) return;
        setResult({
          jobId,
          message:
            fetchError instanceof Error ? fetchError.message : 'Could not load this job from Mux.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `onLoaded` is in the deps because the effect calls it, and it is safe to be: the panel hands
    // over a `useCallback` with no dependencies of its own, and the state it writes is guarded
    // against replacing a detail already held — so nothing here can re-trigger this effect.
  }, [jobId, workflow, inlineOutputs, muxApi, onLoaded]);

  /**
   * The result, but only if it is about the job on screen.
   *
   * A result carrying another id belongs to the job the modal was showing before this one, and
   * rendering it here would put one job's output under another's header.
   */
  const settled = result?.jobId === jobId ? result : undefined;

  // Prefer the fetched job, but never render nothing: the summary at least has status and workflow.
  const shown = settled?.job ?? job;
  const error = settled?.message;
  /**
   * Derived, never latched: loading is exactly "this job is open, its payload is not in hand, and
   * no fetch has answered for it yet". A cancelled request leaves no trace to get stuck on, and
   * the moment the payload arrives by any route — this fetch, or the panel's cache landing on the
   * prop — it is false.
   */
  const isLoading = !!jobId && !inlineOutputs && !settled;

  return (
    <Modal isShown={!!job} onClose={onClose} size="large">
      {() =>
        shown ? (
          <>
            <Modal.Header title={workflowLabel(shown.workflow)} onClose={onClose} />
            <Modal.Content>
              <Box marginBottom="spacingM">
                <Text fontColor="gray600">
                  Job {shown.id}
                  {typeof shown.units_consumed === 'number' &&
                    ` · ${shown.units_consumed} AI units`}
                </Text>
              </Box>
              {/*
                Loading and error stay whole-modal states rather than becoming a third and fourth
                tab. Neither has a payload yet, so a Raw JSON tab offered next to them could only
                show the summary row the editor clicked — and a summary row rendered as if it were
                the result is the original bug on this feature, not a diagnostic.
              */}
              {isLoading ? (
                <Flex alignItems="center" gap="spacingS">
                  <Spinner size="small" />
                  <Text>Loading the result from Mux…</Text>
                </Flex>
              ) : error ? (
                <Note variant="negative">{error}</Note>
              ) : (
                /*
                 * Tabs rather than a toggle button. Both labels stay on screen, so the raw view is
                 * discoverable by someone who did not know to look for it — a toggle reads as a
                 * setting and hides whichever half you are not in behind a state you have to
                 * guess at. It is also the pattern this app already uses for one thing shown two
                 * ways (Player code's Mux Player / iframe), and f36's Tabs unmount the panel that
                 * is not showing, so a large payload is not sitting in the DOM behind the table.
                 */
                <Tabs defaultTab="result">
                  <Tabs.List>
                    <Tabs.Tab panelId="result">Result</Tabs.Tab>
                    <Tabs.Tab panelId="raw">Raw JSON</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel id="result">
                    <Box marginTop="spacingM">
                      <OutputBody job={shown} />
                    </Box>
                  </Tabs.Panel>
                  <Tabs.Panel id="raw">
                    <Box marginTop="spacingM">
                      <RawJobView job={shown} />
                    </Box>
                  </Tabs.Panel>
                </Tabs>
              )}
            </Modal.Content>
          </>
        ) : null
      }
    </Modal>
  );
};

export default RobotsOutputViewer;
