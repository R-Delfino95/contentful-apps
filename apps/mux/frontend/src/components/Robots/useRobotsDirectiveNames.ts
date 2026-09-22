import { useEffect, useState } from 'react';
import { MuxApiService } from '../../util/muxApi';
import { RobotsDirective } from '../../util/robotsTypes';

/**
 * Turning directive ids into the names a person chose in Mux.
 *
 * Only the ids are stored — `muxDefaultDirectiveIds` on the installation parameters, and
 * `directiveId` on a recorded run — because an id is the only part of a directive that is stable
 * and ours to keep. A name is a label someone can rename at any time, so it is resolved on
 * demand and never persisted.
 *
 * `GET /robots/v0/directives` is the only way to resolve one, which is an app-action round trip,
 * so the rule everywhere this is used is the same: the names are a convenience and the id is the
 * truth. Nothing waits on the listing, and every caller renders the id when the listing fails or
 * when a directive has been deleted in Mux since it was configured.
 */

/** id → display name, falling back to the id for anything the listing does not cover. */
export function directiveNamesById(
  directives: RobotsDirective[],
  fallbackIds: string[] = []
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of fallbackIds) names[id] = id;
  for (const directive of directives) {
    if (directive.id) names[directive.id] = directive.name || directive.id;
  }
  return names;
}

/**
 * Resolves names for a set of directive ids, once, while `isEnabled`.
 *
 * Deliberately not fetched on mount of whatever renders it: the callers are a modal and a tab,
 * both opened on purpose, and an install with no directives configured resolves nothing and
 * calls nothing.
 */
export function useRobotsDirectiveNames(
  muxApi: MuxApiService | undefined,
  directiveIds: string[],
  isEnabled: boolean
): Record<string, string> {
  const [directives, setDirectives] = useState<RobotsDirective[]>([]);
  const idKey = [...directiveIds].sort().join(',');

  useEffect(() => {
    if (!isEnabled || !muxApi || !idKey) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await muxApi.listRobotsDirectives({ limit: 100 });
        if (!cancelled) setDirectives(response.data ?? []);
      } catch (error) {
        // The ids still render, and they are what the request is built from either way. A failed
        // listing must never be able to hold up an upload.
        console.error('[robots] Could not resolve directive names', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [muxApi, idKey, isEnabled]);

  return directiveNamesById(directives, directiveIds);
}
