/**
 * One-time mint of GOOGLE_CALENDAR_REFRESH_TOKEN for the gcal_* tools.
 *
 *   npm run google:auth
 *
 * Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from `.env` (a "Desktop app" OAuth client),
 * opens Google's consent page, catches the redirect on a loopback port, exchanges the code,
 * and writes the refresh token into `.env`. The token is never printed, so it stays out of
 * terminal scrollback and logs.
 *
 * Desktop-app clients accept any http://127.0.0.1:<port> redirect, so nothing has to be
 * registered in the Cloud Console. While the consent screen is in "Testing", Google expires
 * refresh tokens after 7 days — rerun this, or publish the app, when gcal_* starts failing
 * with invalid_grant.
 */
import 'dotenv/config';
import { exec } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const ENV_FILE = '.env';
const ENV_KEY = 'GOOGLE_CALENDAR_REFRESH_TOKEN';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

/** Replace `KEY=…` in .env, or append it; every other line is left untouched. */
function writeEnv(key: string, value: string): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) {
    lines[i] = `${key}=${value}`;
  } else {
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }
    lines.push(`${key}=${value}`, '');
  }
  writeFileSync(ENV_FILE, lines.join('\n'));
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = '';
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !error && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(ok ? 'Done. You can close this tab.' : `Authorization failed: ${error ?? 'bad state'}`);
      server.close();
      if (ok) {
        resolve({ code: got, redirectUri });
      } else {
        reject(new Error(`Authorization failed: ${error ?? 'state mismatch'}`));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        // offline + consent is what makes Google return a refresh token every time.
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      console.log('Opening Google consent in your browser. If it does not open, visit:\n');
      console.log(`${auth.toString()}\n`);
      openBrowser(auth.toString());
    });
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code.code,
      code_verifier: verifier,
      redirect_uri: code.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    throw new Error(
      `Token exchange failed: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim(),
    );
  }
  writeEnv(ENV_KEY, body.refresh_token);
  console.log(`Saved ${ENV_KEY} to ${ENV_FILE}. Restart the server and check /ready.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
