import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import RobotsConfiguration from './RobotsConfiguration';

/**
 * The config screen calls `api.mux.com` itself, because it has to work before the app is
 * installed (ADR-0006). It used to classify what came back on its own — every 403 as a missing
 * scope — and so told an account that had only not accepted the Robots terms to throw away a
 * working token. It now asks the Robots tab's classifier and shows the tab's notes.
 */

const TERMS_PAGE = 'https://dashboard.mux.com/organizations/org-1/environments/env-1/robots/jobs';

/** What `fetch` resolves with, reduced to what the screen reads. */
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const listWith = (response: ReturnType<typeof answer> | Error) => {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <RobotsConfiguration
      tokenId="token-id"
      tokenSecret="token-secret"
      directiveIds={[]}
      onChange={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'List directives' }));
  return fetchMock;
};

describe('RobotsConfiguration — what a refused listing says', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells an account that has not accepted the terms to accept them, not to replace its token', async () => {
    listWith(
      answer(403, {
        error: {
          type: 'forbidden',
          messages: [
            `Go to your Robots page in the Mux Dashboard to accept the terms: ${TERMS_PAGE}`,
          ],
        },
      })
    );

    const note = await screen.findByTestId('robots-not-enabled');
    expect(
      within(note).getByRole('link', { name: /Accept the Robots terms in your Mux dashboard/ })
    ).toHaveAttribute('href', TERMS_PAGE);
    expect(screen.queryByTestId('robots-scope-missing')).not.toBeInTheDocument();
    expect(screen.queryByText(/robots:\* scope/)).not.toBeInTheDocument();
    // Nor that the account has no directives, which is not what Mux said.
    expect(screen.queryByText(/has no directives yet/)).not.toBeInTheDocument();
  });

  it('drops the note once a reload succeeds', async () => {
    const fetchMock = listWith(answer(403, { error: { type: 'forbidden', messages: ['No'] } }));
    expect(await screen.findByTestId('robots-not-enabled')).toBeInTheDocument();

    fetchMock.mockImplementation(async () =>
      answer(200, { data: [{ id: 'drv_1', name: 'Ingest' }] })
    );
    fireEvent.click(screen.getByRole('button', { name: 'List directives' }));

    expect(await screen.findByLabelText('Ingest')).toBeInTheDocument();
    expect(screen.queryByTestId('robots-not-enabled')).not.toBeInTheDocument();
  });

  it('says a token without the scope needs a new one', async () => {
    listWith(
      answer(401, {
        error: {
          type: 'unauthorized',
          messages: ["This token hasn't been granted the correct scope for this operation."],
        },
      })
    );

    expect(await screen.findByTestId('robots-scope-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('robots-not-enabled')).not.toBeInTheDocument();
  });

  it('reports anything that says nothing about the account as what Mux returned', async () => {
    listWith(answer(500, { error: { type: 'server_error', messages: ['Down'] } }));

    expect(
      await screen.findByText('Mux returned 500 when listing directives.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('robots-not-enabled')).not.toBeInTheDocument();
  });

  it('still offers the manual route when the browser cannot reach Mux at all', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listWith(new TypeError('Failed to fetch'));

    expect(
      await screen.findByText(/Could not reach the Mux Robots API from the browser/)
    ).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('lists the directives when Mux answers', async () => {
    const fetchMock = listWith(answer(200, { data: [{ id: 'drv_1', name: 'Ingest' }] }));

    expect(await screen.findByLabelText('Ingest')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mux.com/robots/v0/directives?limit=100&page=1',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
