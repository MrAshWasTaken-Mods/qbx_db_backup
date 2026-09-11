import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type GDriveAuthConfig,
  GDriveError,
  type GDriveOAuthConfig,
  type GDriveServiceAccountConfig,
  type GDriveTokenResponse,
  isOAuthConfig,
} from './types';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

function base64UrlEncode(strOrBuffer: string | Buffer): string {
  const buf = typeof strOrBuffer === 'string' ? Buffer.from(strOrBuffer, 'utf8') : strOrBuffer;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Exchanges an OAuth 2.0 refresh token for a short-lived access token.
 */
export async function refreshOAuthToken(
  config: GDriveOAuthConfig,
  fetchFn: typeof fetch = fetch
): Promise<GDriveTokenResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errJson = (await response.json()) as { error?: string; error_description?: string };
      if (errJson.error_description) {
        errorDetail = `${errJson.error}: ${errJson.error_description}`;
      } else if (errJson.error) {
        errorDetail = errJson.error;
      }
    } catch {
      // Ignore JSON parse error, use default errorDetail
    }
    throw new GDriveError(`OAuth token refresh failed: ${errorDetail}`, response.status);
  }

  return (await response.json()) as GDriveTokenResponse;
}

/**
 * Exchanges a Service Account private key via RS256 JWT for an access token.
 */
export async function authenticateServiceAccount(
  config: GDriveServiceAccountConfig,
  fetchFn: typeof fetch = fetch
): Promise<GDriveTokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: config.clientEmail,
    scope: DRIVE_FULL_SCOPE,
    aud: GOOGLE_TOKEN_ENDPOINT,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const payloadToSign = `${encodedHeader}.${encodedClaims}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payloadToSign);
  signer.end();
  const signature = signer.sign(config.privateKey);
  const jwt = `${payloadToSign}.${base64UrlEncode(signature)}`;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errJson = (await response.json()) as { error?: string; error_description?: string };
      if (errJson.error_description) {
        errorDetail = `${errJson.error}: ${errJson.error_description}`;
      } else if (errJson.error) {
        errorDetail = errJson.error;
      }
    } catch {
      // Ignore parse failure
    }
    throw new GDriveError(`Service account authentication failed: ${errorDetail}`, response.status);
  }

  return (await response.json()) as GDriveTokenResponse;
}

/**
 * Loads and parses a credentials JSON file exported from Google Cloud Console.
 *
 * Supports two file shapes:
 *   - OAuth 2.0 Desktop client:  { "installed": { "client_id", "client_secret" } } + a "refresh_token" field
 *   - Service Account key file:  { "type": "service_account", "client_email", "private_key" }
 *
 * Exported from Google Cloud Console -> APIs & Services -> Credentials -> Download JSON.
 */
export async function loadCredentialsFile(
  filePath: string
): Promise<GDriveAuthConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new GDriveError(
      `Cannot read credentials file at '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new GDriveError(`Credentials file at '${filePath}' is not valid JSON.`);
  }

  // Shape 1: Service Account key (Google Cloud Console -> Service Accounts -> JSON key)
  if (parsed['type'] === 'service_account') {
    const clientEmail = parsed['client_email'];
    const privateKey = parsed['private_key'];
    if (typeof clientEmail !== 'string' || !clientEmail) {
      throw new GDriveError(`Service account credentials file missing 'client_email'.`);
    }
    if (typeof privateKey !== 'string' || !privateKey) {
      throw new GDriveError(`Service account credentials file missing 'private_key'.`);
    }
    return { clientEmail, privateKey };
  }

  // Shape 2: OAuth 2.0 client (installed/web) + refresh_token
  // The refresh_token must also be present in the file (e.g. from a saved token exchange)
  const installedOrWeb =
    (parsed['installed'] as Record<string, unknown> | undefined) ??
    (parsed['web'] as Record<string, unknown> | undefined) ??
    parsed;

  const clientId = (installedOrWeb as Record<string, unknown>)['client_id'] ?? parsed['client_id'];
  const clientSecret =
    (installedOrWeb as Record<string, unknown>)['client_secret'] ?? parsed['client_secret'];
  const refreshToken = parsed['refresh_token'];

  if (typeof clientId !== 'string' || !clientId) {
    throw new GDriveError(
      `Credentials file at '${filePath}' is missing 'client_id'. ` +
        `For OAuth 2.0, include a 'refresh_token' field alongside the downloaded client JSON.`
    );
  }
  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new GDriveError(`Credentials file at '${filePath}' is missing 'client_secret'.`);
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new GDriveError(
      `Credentials file at '${filePath}' is missing 'refresh_token'. ` +
        `Add the refresh_token obtained from the OAuth consent flow to the file.`
    );
  }

  return { clientId, clientSecret, refreshToken };
}

/**
 * Manages Google Drive authentication and token lifecycle caching.
 */
export class GDriveAuthManager {
  private cachedToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly config: GDriveAuthConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  /**
   * Returns a valid access token, automatically refreshing if expired.
   */
  public async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    // Use cached token if valid for at least another 60 seconds
    if (!forceRefresh && this.cachedToken && now < this.expiresAt - 60_000) {
      return this.cachedToken;
    }

    let tokenResponse: GDriveTokenResponse;
    if (isOAuthConfig(this.config)) {
      tokenResponse = await refreshOAuthToken(this.config, this.fetchFn);
    } else {
      tokenResponse = await authenticateServiceAccount(this.config, this.fetchFn);
    }

    this.cachedToken = tokenResponse.access_token;
    const expiresInSec = tokenResponse.expires_in || 3600;
    this.expiresAt = Date.now() + expiresInSec * 1000;

    return this.cachedToken;
  }

  public invalidateToken(): void {
    this.cachedToken = null;
    this.expiresAt = 0;
  }
}
