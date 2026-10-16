// @vitest-environment jsdom
/**
 * The shared page timer in the header: presets and the custom form (what is
 * sent), the countdown from the server's end moment through a skewed local
 * clock, the sound and the toast exactly once at zero, a latecomer, live
 * frames from the `/events` socket (and an out-of-order one), and who sees
 * what. The network is stubbed at `fetch`, the socket with a double; the real
 * two-browser run is in the round's QA.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import type { PageTimerResponse, PageTimerState } from '@shared/contracts';
import { NotificationsHost } from '../notifications/NotificationsHost';
import { ToastProvider } from '../ui/Toast';
import { PageTimer } from './PageTimer';
import '../i18n/register';

const chime = vi.hoisted(() => ({ playChime: vi.fn(() => true), locked: false }));
vi.mock('../timer/chime', () => ({
  playChime: chime.playChime,
  armAudioUnlock: () => undefined,
  unlockAudio: () => Promise.resolve(true),
  isMuted: () => false,
  setMuted: () => undefined,
  useAudioLocked: () => chime.locked,
}));

const T0 = new Date('2026-10-16T12:00:00.000Z').getTime();
const PAGE = 'page-1';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {}
  frame(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  chime.playChime.mockClear();
  chime.locked = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
});

/** What the server answers. `skewMs`: how far AHEAD of this device's clock the server's clock is. */
function serverAnswers(state: { timer: PageTimerState | null; canControl?: boolean; rev?: number; skewMs?: number }) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      const body: PageTimerResponse = { timer: state.timer, rev: state.rev ?? 10, serverNow: Date.now() + (state.skewMs ?? 0), canControl: state.canControl ?? true };
      return Promise.resolve({ ok: true, status: 200, statusText: '', json: () => Promise.resolve(body) });
    }),
  );
  return posts;
}

const running = (endsAt: number, extra: Partial<PageTimerState> = {}): PageTimerState => ({ durationMs: 300_000, endsAt, pausedRemainingMs: null, startedByName: 'Alice', updatedAt: T0, ...extra });

async function mount(options: { withSocket?: boolean; space?: string; pageId?: string | undefined } = {}) {
  vi.stubGlobal('WebSocket', FakeSocket);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {options.withSocket && <NotificationsHost />}
        <PageTimer space={options.space ?? 'docs'} pageId={'pageId' in options ? options.pageId : PAGE} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await settle();
  return queryClient;
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** react-query tells its observers on a zero-delay timer, which the fake clock holds back until it is moved. */
async function deliver(socket: FakeSocket, payload: unknown) {
  await act(async () => {
    socket.frame(payload);
    await vi.advanceTimersByTimeAsync(0);
  });
}
const clockText = () => screen.getByRole('timer').textContent;

describe('who sees what', () => {
  it('an editor with no timer running sees the icon; a reader sees nothing', async () => {
    serverAnswers({ timer: null, canControl: true });
    await mount();
    expect(screen.getByRole('button', { name: 'Timer' })).toBeTruthy();
    cleanup();

    serverAnswers({ timer: null, canControl: false });
    await mount();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a reader sees the running countdown but gets no controls', async () => {
    serverAnswers({ timer: running(T0 + 90_000), canControl: false });
    await mount();
    expect(clockText()).toBe('01:30');
    fireEvent.click(screen.getByRole('button', { name: /Timer: 01:30/ }));
    expect(screen.getByText('Started by Alice')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});

describe('starting a timer', () => {
  it('the presets are 1, 3, 5 and 10 minutes and send the length in milliseconds', async () => {
    const posts = serverAnswers({ timer: null });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Timer' }));
    expect(['1 min', '3 min', '5 min', '10 min'].map((name) => screen.getByRole('button', { name }).textContent)).toEqual(['1 min', '3 min', '5 min', '10 min']);
    fireEvent.click(screen.getByRole('button', { name: '5 min' }));
    await settle();
    expect(posts).toEqual([{ action: 'start', durationMs: 300_000 }]);
  });

  it('a custom time of minutes and seconds', async () => {
    const posts = serverAnswers({ timer: null });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Timer' }));
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await settle();
    expect(posts).toEqual([{ action: 'start', durationMs: 150_000 }]);
  });

  it('refuses nothing, zero and more than three hours: a message, and no request', async () => {
    const posts = serverAnswers({ timer: null });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Timer' }));
    const start = () => fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    start();
    expect(screen.getByRole('alert').textContent).toMatch(/between 1 second and 3 hours/);
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '181' } });
    expect(screen.queryByRole('alert')).toBeNull(); // typing clears the message
    start();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: 'ten' } });
    start();
    expect(screen.getByRole('alert')).toBeTruthy();
    await settle();
    expect(posts).toEqual([]);
  });

  it('on a folder listing (no page id) it is the space timer', async () => {
    serverAnswers({ timer: null });
    await mount({ pageId: undefined, space: 'docs' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe('/api/spaces/docs/timer');
  });
});

describe('the countdown and the end', () => {
  it('counts down from the SERVER end moment even when this device clock is 40 s off', async () => {
    // The server says: 90 s from ITS now. Its clock is 40 s ahead of ours.
    serverAnswers({ timer: running(T0 + 40_000 + 90_000), skewMs: 40_000 });
    await mount();
    expect(clockText()).toBe('01:30');
    await advance(1010);
    expect(clockText()).toBe('01:29');
    await advance(59_000);
    expect(clockText()).toBe('00:30');
  });

  it('the last ten seconds are marked urgent', async () => {
    serverAnswers({ timer: running(T0 + 12_000) });
    await mount();
    const pill = () => screen.getByRole('button', { name: /Timer: / });
    expect(pill().className).not.toMatch(/animate-pulse/);
    await advance(2000);
    expect(clockText()).toBe('00:10');
    expect(pill().className).toMatch(/animate-pulse/);
  });

  it('at zero: the chime plays ONCE, a toast says the time is up, and nothing repeats afterwards', async () => {
    serverAnswers({ timer: running(T0 + 5000) });
    await mount();
    await advance(4900);
    expect(chime.playChime).not.toHaveBeenCalled();
    await advance(200);
    expect(chime.playChime).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('status').some((el) => el.textContent === 'Time is up')).toBe(true);
    expect(clockText()).toBe('00:00');
    await advance(60_000);
    expect(chime.playChime).toHaveBeenCalledTimes(1);
  });

  it('with the browser still blocking audio the toast says how to enable it', async () => {
    chime.playChime.mockReturnValueOnce(false);
    chime.locked = true;
    serverAnswers({ timer: running(T0 + 2000) });
    await mount();
    await advance(2100);
    expect(screen.getAllByRole('status').some((el) => /Time is up · Click anywhere to enable the sound/.test(el.textContent ?? ''))).toBe(true);
  });

  it('a latecomer who opens the page long after the end sees it finished and hears nothing', async () => {
    serverAnswers({ timer: running(T0 - 60_000) });
    await mount();
    await advance(1000);
    expect(clockText()).toBe('00:00');
    expect(screen.getByRole('button', { name: 'Timer: time is up' })).toBeTruthy();
    expect(chime.playChime).not.toHaveBeenCalled();
  });

  it('a finished timer clears itself from view after five minutes', async () => {
    serverAnswers({ timer: running(T0 - 60_000), canControl: false });
    await mount();
    expect(screen.queryByRole('timer')).not.toBeNull();
    await advance(5 * 60_000);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('a latecomer joining mid-run sees the remaining time, not the full length', async () => {
    serverAnswers({ timer: running(T0 + 100_000, { durationMs: 300_000 }) });
    await mount();
    expect(clockText()).toBe('01:40');
  });

  it('a paused timer shows the frozen time and does not tick', async () => {
    serverAnswers({ timer: { durationMs: 300_000, endsAt: null, pausedRemainingMs: 125_000, startedByName: 'Alice', updatedAt: T0 } });
    await mount();
    expect(clockText()).toBe('02:05');
    await advance(30_000);
    expect(clockText()).toBe('02:05');
    expect(chime.playChime).not.toHaveBeenCalled();
  });
});

describe('controls', () => {
  it('pause, +1 min and reset send the right actions', async () => {
    const posts = serverAnswers({ timer: running(T0 + 90_000) });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Timer: 01:30/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '+1 min' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await settle();
    expect(posts).toEqual([{ action: 'pause' }, { action: 'add', ms: 60_000 }, { action: 'reset' }]);
  });
});

describe('live frames from the /events socket', () => {
  const frame = (timer: PageTimerState | null, rev: number, key = PAGE, skewMs = 0) => ({ type: 'timer', key, timer, rev, serverNow: Date.now() + skewMs });

  it('a timer started elsewhere appears, counts down in step and rings; a reset removes it', async () => {
    serverAnswers({ timer: null, canControl: false, rev: 10 });
    await mount({ withSocket: true });
    expect(screen.queryByRole('timer')).toBeNull();

    const socket = FakeSocket.instances[0];
    await deliver(socket, frame(running(T0 + 3000), 11));
    expect(clockText()).toBe('00:03');
    await advance(3100);
    expect(chime.playChime).toHaveBeenCalledTimes(1);

    await deliver(socket, frame(null, 12));
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('a frame older than what is held (out-of-order delivery) is dropped', async () => {
    serverAnswers({ timer: null, canControl: true, rev: 10 });
    await mount({ withSocket: true });
    const socket = FakeSocket.instances[0];
    await deliver(socket, frame(running(T0 + 60_000), 20));
    expect(clockText()).toBe('01:00');
    await deliver(socket, frame(null, 15)); // an older «reset» arriving late
    expect(clockText()).toBe('01:00');
    await deliver(socket, frame({ ...running(T0 + 60_000), endsAt: null, pausedRemainingMs: 45_000 }, 21));
    expect(clockText()).toBe('00:45');
  });

  it('frames about another page are not shown here', async () => {
    serverAnswers({ timer: null, canControl: false, rev: 10 });
    await mount({ withSocket: true });
    await deliver(FakeSocket.instances[0], frame(running(T0 + 60_000), 20, 'some-other-page'));
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('the frame clock offset keeps the countdown honest on a skewed device', async () => {
    serverAnswers({ timer: null, canControl: false, rev: 10, skewMs: 0 });
    await mount({ withSocket: true });
    // The server's clock is 25 s AHEAD of ours; the timer ends 60 s after the server's now.
    await deliver(FakeSocket.instances[0], frame(running(T0 + 25_000 + 60_000), 20, PAGE, 25_000));
    expect(clockText()).toBe('01:00');
  });
});
