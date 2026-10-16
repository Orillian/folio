// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NewVersionNotice } from './NewVersionNotice';
import { resetConnectivityForTests } from '../offline/connectivity';
import '../i18n/register';

function mount(entry: string | null) {
  document.head.innerHTML = entry ? `<script type="module" src="/assets/${entry}"></script>` : '';
}
function serverBuild(entry: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ 'index.html': { file: `assets/${entry}`, isEntry: true } }),
  } as Response);
}
const becomeVisible = () => act(async () => void document.dispatchEvent(new Event('visibilitychange')));

describe('NewVersionNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetConnectivityForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.head.innerHTML = '';
  });

  it('shows the banner when the server has a newer build than the tab runs', async () => {
    mount('index-OLD11111.js');
    const fetchSpy = serverBuild('index-NEW22222.js');
    render(<NewVersionNotice />);
    expect(screen.queryByRole('status')).toBeNull();
    await becomeVisible();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('A new version of Folio is available.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('stays quiet while the builds match', async () => {
    mount('index-SAME1111.js');
    serverBuild('index-SAME1111.js');
    render(<NewVersionNotice />);
    await becomeVisible();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not ask more than once a minute, and stops asking once stale', async () => {
    mount('index-OLD11111.js');
    const fetchSpy = serverBuild('index-OLD11111.js');
    render(<NewVersionNotice />);
    await becomeVisible();
    await becomeVisible();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(61_000));
    await becomeVisible();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does nothing in development (no built entry) and while offline', async () => {
    mount(null);
    const fetchSpy = serverBuild('index-NEW22222.js');
    render(<NewVersionNotice />);
    await becomeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
    mount('index-OLD11111.js');
    resetConnectivityForTests({ state: 'offline' });
    render(<NewVersionNotice />);
    await becomeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('can be dismissed', async () => {
    mount('index-OLD11111.js');
    serverBuild('index-NEW22222.js');
    render(<NewVersionNotice />);
    await becomeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
