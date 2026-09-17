import { FC } from 'react';
import { Badge, Box, Button, Table, Text, TextLink } from '@contentful/f36-components';
import { RobotsJob, isTerminalStatus, robotsJobErrorMessage } from '../../util/robotsTypes';
import { workflowLabel } from '../../util/robotsCatalog';
import { formatTimestamp } from '../../util/robotsFormat';
import EmptyTableNote from './EmptyTableNote';
import RobotsStatusBadge from './RobotsStatusBadge';

/** The job list, following the `TrackList` table convention used for captions and audio. */

/**
 * What is known about a job's *full* record, as opposed to the six-field list summary.
 *
 * `units_consumed` only exists on `GET /robots/v0/jobs/{workflow}/{id}`, and that read is bounded
 * (see `jobsNeedingDetail`), so a blank cell has three causes the editor cannot tell apart unless
 * the column says which one it is.
 */
export type RobotsJobDetailState =
  /** The full record is in hand. Anything missing from it is missing because Mux did not send it. */
  | 'loaded'
  /** The read was attempted and failed — a purged job, a proxy error. Asking again is pointless. */
  | 'unreadable'
  /** Never asked. Past the background window, or not its turn yet. */
  | 'unread';

interface RobotsUnitsCell {
  label: string;
  /** True when one detail read would turn `label` into an actual number. */
  isLoadable: boolean;
}

/**
 * What the Units column says.
 *
 * There is no unqualified em dash here: blank-because-unknown against blank-because-empty is the
 * ambiguity that has produced several bugs on this feature, so every state says which one it is.
 * `Not charged` comes first, ahead of any number, because it is knowable without reading anything
 * — Mux does not bill a job that errored or was cancelled, and the Actions column says the same.
 */
export function unitsCell(job: RobotsJob, detail: RobotsJobDetailState): RobotsUnitsCell {
  if (job.status === 'errored' || job.status === 'cancelled') {
    return { label: 'Not charged', isLoadable: false };
  }
  if (typeof job.units_consumed === 'number') {
    return { label: String(job.units_consumed), isLoadable: false };
  }
  if (!isTerminalStatus(job.status)) return { label: 'Not counted yet', isLoadable: false };
  if (detail === 'unreadable') return { label: 'Unavailable', isLoadable: false };
  // We read the whole job and it carried no count. Not the same as never having looked.
  if (detail === 'loaded') return { label: 'Not reported', isLoadable: false };
  return { label: 'Not loaded', isLoadable: true };
}

interface RobotsJobTableProps {
  jobs: RobotsJob[];
  /**
   * Ids of the jobs recorded on the entry. Everything else ran somewhere else — usually the Mux
   * dashboard — and is shown but not stored, so the row says so rather than leaving the editor to
   * notice the gap in the Data tab.
   */
  storedJobIds: Set<string>;
  /** Ids whose full record has been read. See `RobotsJobDetailState`. */
  detailedJobIds: Set<string>;
  /** Ids whose detail read was attempted and failed. */
  unreadableJobIds: Set<string>;
  onCancel: (job: RobotsJob) => void;
  onViewOutput: (job: RobotsJob) => void;
  /** Reads one job's full record, for a row the background pass never reached. */
  onLoadDetail: (job: RobotsJob) => void;
  /** Job ids with a cancel in flight. */
  cancellingIds: string[];
  /** Job ids with an on-demand detail read in flight. */
  loadingDetailIds: string[];
}

const detailState = (
  job: RobotsJob,
  detailedJobIds: Set<string>,
  unreadableJobIds: Set<string>
): RobotsJobDetailState => {
  if (detailedJobIds.has(job.id)) return 'loaded';
  if (unreadableJobIds.has(job.id)) return 'unreadable';
  return 'unread';
};

const RobotsJobTable: FC<RobotsJobTableProps> = ({
  jobs,
  storedJobIds,
  detailedJobIds,
  unreadableJobIds,
  onCancel,
  onViewOutput,
  onLoadDetail,
  cancellingIds,
  loadingDetailIds,
}) => {
  if (jobs.length === 0) {
    return <EmptyTableNote>No Robots jobs have run on this video yet.</EmptyTableNote>;
  }

  return (
    <Box marginBottom="spacingM">
      <Table data-testid="robots_job_table">
        <Table.Head>
          <Table.Row>
            <Table.Cell>Workflow</Table.Cell>
            <Table.Cell>Status</Table.Cell>
            <Table.Cell>Started</Table.Cell>
            <Table.Cell>Units</Table.Cell>
            <Table.Cell>Actions</Table.Cell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {jobs.map((job) => {
            const isRunning = job.status === 'pending' || job.status === 'processing';
            const error = robotsJobErrorMessage(job);
            const units = unitsCell(job, detailState(job, detailedJobIds, unreadableJobIds));
            const isLoadingDetail = loadingDetailIds.includes(job.id);
            const isCancelling = cancellingIds.includes(job.id);

            return (
              <Table.Row key={job.id}>
                <Table.Cell>
                  <Text>{workflowLabel(job.workflow)}</Text>
                  {!storedJobIds.has(job.id) && (
                    <Box marginTop="spacingXs">
                      <Badge variant="secondary">Not saved to this entry</Badge>
                    </Box>
                  )}
                  {error && (
                    <Box marginTop="spacingXs">
                      <Text fontColor="red600" fontSize="fontSizeS">
                        {error}
                      </Text>
                    </Box>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <RobotsStatusBadge kind="job" status={job.status} />
                </Table.Cell>
                <Table.Cell>{formatTimestamp(job.created_at)}</Table.Cell>
                <Table.Cell>
                  {units.isLoadable ? (
                    // A row past the background window says "Not loaded" rather than an em dash,
                    // and offers the one read that answers it — so request volume tracks how many
                    // rows somebody cares about, not how long this asset's history is.
                    <TextLink
                      as="button"
                      variant="primary"
                      isDisabled={isLoadingDetail}
                      data-testid={`robots-load-units-${job.id}`}
                      onClick={() => onLoadDetail(job)}>
                      {isLoadingDetail ? 'Loading…' : units.label}
                    </TextLink>
                  ) : (
                    <Text data-testid={`robots-units-${job.id}`}>{units.label}</Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {isRunning ? (
                    <Button
                      size="small"
                      variant="negative"
                      isDisabled={isCancelling}
                      isLoading={isCancelling}
                      onClick={() => onCancel(job)}>
                      Cancel
                    </Button>
                  ) : job.status === 'cancelled' ? (
                    // A cancelled job stopped before it produced anything, so the modal could only
                    // ever say so — after paying a round trip to find out. A missing button reads
                    // as a rendering bug, so the cell says what it would have shown instead.
                    <Text
                      fontColor="gray600"
                      fontSize="fontSizeS"
                      data-testid={`robots-no-output-${job.id}`}>
                      Nothing to view — cancelled before it produced output
                    </Text>
                  ) : (
                    <Button size="small" variant="secondary" onClick={() => onViewOutput(job)}>
                      View output
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </Box>
  );
};

export default RobotsJobTable;
