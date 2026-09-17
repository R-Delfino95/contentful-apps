import { FC } from 'react';
import { Badge } from '@contentful/f36-components';
import {
  RobotsDirectiveRunStatus,
  RobotsJobStatus,
  RobotsNodeStatus,
} from '../../util/robotsTypes';

/**
 * The status badge for a job, a directive run or one of a run's steps.
 *
 * Three vocabularies, one mapping, so the same idea does not pick a different colour depending on
 * which table it is in — `errored` was negative on a job and on a run, but `failed` on a node had
 * to be kept in step by hand.
 */

type Variant = 'primary' | 'positive' | 'negative' | 'warning' | 'secondary';

const JOB_VARIANT: Record<RobotsJobStatus, Variant> = {
  pending: 'secondary',
  processing: 'primary',
  completed: 'positive',
  errored: 'negative',
  cancelled: 'secondary',
};

const RUN_VARIANT: Record<RobotsDirectiveRunStatus, Variant> = {
  pending: 'secondary',
  dispatching: 'primary',
  running: 'primary',
  waiting: 'secondary',
  completed: 'positive',
  partial: 'warning',
  errored: 'negative',
};

const NODE_VARIANT: Record<RobotsNodeStatus, Variant> = {
  dispatched: 'primary',
  failed: 'negative',
  waiting_for_resources: 'secondary',
  waiting_for_source_workflow: 'secondary',
};

const VARIANTS: Record<string, Record<string, Variant>> = {
  job: JOB_VARIANT,
  run: RUN_VARIANT,
  node: NODE_VARIANT,
};

interface RobotsStatusBadgeProps {
  kind: 'job' | 'run' | 'node';
  /** Absent statuses render as `unknown` rather than as an empty badge. */
  status?: string;
}

const RobotsStatusBadge: FC<RobotsStatusBadgeProps> = ({ kind, status }) => {
  const label = status ?? (kind === 'run' ? 'pending' : 'unknown');
  return (
    <Badge variant={VARIANTS[kind][label] ?? 'secondary'}>
      {/* Node statuses are snake_case on the wire; the others are single words. */}
      {label.replace(/_/g, ' ')}
    </Badge>
  );
};

export default RobotsStatusBadge;
