import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../app/api';
import { initSentry, setSentryUser } from '.';

/**
 * Starts error reporting once the server says it is on (GET /api/auth/state carries `sentry` only when the
 * operator set SENTRY_DSN). Mounted once above every route, signed in or not, so that the public pages are covered
 * too. Shares the auth query with AuthProvider (same key), so it costs no extra request on a signed-in page.
 * Draws nothing.
 */
export function SentryHost() {
  const { data } = useQuery({ queryKey: ['auth', 'state'], queryFn: api.getAuthState });
  const config = data?.sentry;
  const userId = data?.user?.id ?? null;

  useEffect(() => {
    initSentry(config);
  }, [config]);

  useEffect(() => {
    setSentryUser(userId);
  }, [userId, config]);

  return null;
}
