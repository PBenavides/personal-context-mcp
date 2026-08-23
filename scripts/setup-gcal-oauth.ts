#!/usr/bin/env -S npx tsx
/**
 * One-time local utility: mint a Google Calendar OAuth refresh token.
 *
 * Replaces the old my-mcp-platform/servers/gcalendar/setup_oauth.py flow (that repo is
 * deprecated) with a self-contained equivalent — no dependency on any other repo, nothing
 * written to disk. Prints the refresh token to the terminal; you paste it into SSM yourself
 * (see docs/personal-tools.md → Secrets).
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/setup-gcal-oauth.ts
 *
 * client_id/client_secret come from a Google Cloud Console OAuth "Desktop app" client
 * (Calendar API enabled) — read the two fields out of the downloaded client JSON, then you
 * can discard that file.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Generous by default: the consent flow includes an "unverified app" click-through. */
const TIMEOUT_MS = Number(process.env.OAUTH_TIMEOUT_MS ?? 300_000);

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from the Desktop app OAuth client JSON) and retry.');
  process.exit(1);
}

async function awaitCallback(): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const error = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');
      // Ignore incidental hits (favicon etc.) — only the redirect carries code/error.
      if (!error && !authCode) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(error ? `<p>Denied: ${error}. You can close this tab.</p>` : '<p>Authorized — you can close this tab.</p>');
      clearTimeout(timer);
      server.close();
      if (error || !authCode) {
        reject(new Error(`Google returned an error: ${error ?? 'no code in callback'}`));
      } else {
        resolve({ code: authCode, redirectUri });
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s waiting for the Google redirect.`));
    }, TIMEOUT_MS);

    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      // Google's documented loopback form for Desktop-app clients: any port on the
      // loopback IP is accepted regardless of the port registered on the client.
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = new URL(AUTH_URL);
      authUrl.search = new URLSearchParams({
        client_id: clientId!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
      }).toString();

      console.log('Open this URL and grant Calendar access (or it should open automatically):\n');
      console.log(authUrl.toString(), '\n');
      execFile('open', [authUrl.toString()], () => {
        /* best-effort browser launch (macOS); ignore failure, URL is printed above */
      });
    });
  });
}

async function main(): Promise<void> {
  const { code, redirectUri } = await awaitCallback();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { refresh_token?: string; access_token: string; expires_in: number };
  if (!body.refresh_token) {
    throw new Error(
      'No refresh_token in the response — Google only issues one on first consent for a given ' +
        'account+client. Revoke prior access at https://myaccount.google.com/permissions and rerun.',
    );
  }

  console.log('\nSuccess. Put these in SSM (see docs/personal-tools.md → Secrets):\n');
  console.log(`GOOGLE_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${body.refresh_token}`);
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
