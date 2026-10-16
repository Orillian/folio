// @vitest-environment jsdom
/**
 * A lazy chunk that is gone: the first failure reloads the page and reports nothing; when the reload did not help
 * (the chunk really is missing) the boundary shows the "could not load" screen with Retry and, with Sentry on, the
 * report button, and the error reaches Sentry exactly once however often the screen renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { PageCrashed } from '../routes/PageCrashed';
import { resetStaleChunkStateForTests } from '../stale-chunk';
import { resetConnectivityForTests } from '../offline/connectivity';
import '../i18n/register';

const captureError = vi.hoisted(() => vi.fn<(e: unknown) => string | undefined>(() => 'evt-1'));
vi.mock('../../sentry', async (orig) => ({ ...(await orig<typeof import('../../sentry')>()), captureError, isSentryEnabled: () => true }));

const missing = () => new Error('Failed to fetch dynamically imported module: https://folio.example/assets/Graph-abc12345.js');

function Page() {
  const Lazy = lazy(() => Promise.reject(missing()));
  return (
    <ErrorBoundary fallback={(error, reset, eventId) => <PageCrashed onRetry={reset} eventId={eventId} error={error} />}>
      <Suspense fallback={<p>loading</p>}>
        <Lazy />
      </Suspense>
    </ErrorBoundary>
  );
}

describe('a missing lazy chunk under ErrorBoundary', () => {
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetStaleChunkStateForTests();
    resetConnectivityForTests();
    captureError.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetStaleChunkStateForTests();
  });

  it('first failure reloads and does not report', async () => {
    render(<Page />);
    await screen.findByText(/could not be loaded/);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(captureError).not.toHaveBeenCalled();
  });

  it('after the reload did not help: no second reload, friendly error with Retry and Report, one Sentry event', async () => {
    render(<Page />); // the first load: reloads
    await screen.findByText(/could not be loaded/);
    expect(reload).toHaveBeenCalledTimes(1);
    cleanup();
    const stored = sessionStorage.getItem('folio:stale-chunk-reloads');
    resetStaleChunkStateForTests(); // the new page: module state is gone, sessionStorage is not
    sessionStorage.setItem('folio:stale-chunk-reloads', stored!);

    render(<Page />);
    expect(await screen.findByText('Part of the app could not be loaded. Reload the page.')).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeTruthy();

    // Retry for a chunk is a reload (the browser remembers a failed import), asked for by the person.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(2);

    // Rendering the same broken chunk again does not report it again.
    cleanup();
    render(<Page />);
    await screen.findByText('Part of the app could not be loaded. Reload the page.');
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
