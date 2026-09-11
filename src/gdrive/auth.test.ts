import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { GDriveAuthManager, authenticateServiceAccount, refreshOAuthToken } from './auth';
import { GDriveError, type GDriveOAuthConfig, type GDriveServiceAccountConfig } from './types';

describe('Google Drive Auth Engine', () => {
  it('successfully refreshes OAuth access token', async () => {
    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url.toString()).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST');
      expect(init?.body).toContain('grant_type=refresh_token');
      expect(init?.body).toContain('client_id=test-client-id');
      expect(init?.body).toContain('refresh_token=test-refresh-token');

      return new Response(
        JSON.stringify({
          access_token: 'ya29.mock_access_token_123',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const config: GDriveOAuthConfig = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token',
    };

    const res = await refreshOAuthToken(config, mockFetch as unknown as typeof fetch);
    expect(res.access_token).toBe('ya29.mock_access_token_123');
    expect(res.expires_in).toBe(3600);
  });

  it('throws GDriveError when OAuth refresh fails with error description', async () => {
    const mockFetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Bad Request - Token has been expired or revoked.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const config: GDriveOAuthConfig = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'invalid-token',
    };

    try {
      await refreshOAuthToken(config, mockFetch as unknown as typeof fetch);
      expect().fail('Expected refreshOAuthToken to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GDriveError);
      expect((err as GDriveError).message).toContain('invalid_grant');
      expect((err as GDriveError).code).toBe(400);
    }
  });

  it('caches access token and reuses it without re-fetching within expiry window', async () => {
    let callCount = 0;
    const mockFetch = mock(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          access_token: `token_${callCount}`,
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const config: GDriveOAuthConfig = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token',
    };

    const auth = new GDriveAuthManager(config, mockFetch as unknown as typeof fetch);

    const token1 = await auth.getAccessToken();
    expect(token1).toBe('token_1');
    expect(callCount).toBe(1);

    // Second call should return cached token
    const token2 = await auth.getAccessToken();
    expect(token2).toBe('token_1');
    expect(callCount).toBe(1);

    // Force refresh should make a new call
    const token3 = await auth.getAccessToken(true);
    expect(token3).toBe('token_2');
    expect(callCount).toBe(2);
  });

  it('authenticates with Service Account RS256 JWT key', async () => {
    // Generate a test RSA key pair
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url.toString()).toBe('https://oauth2.googleapis.com/token');
      expect(init?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
      return new Response(
        JSON.stringify({
          access_token: 'service_account_token_abc',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const config: GDriveServiceAccountConfig = {
      clientEmail: 'test-sa@project.iam.gserviceaccount.com',
      privateKey,
    };

    const res = await authenticateServiceAccount(config, mockFetch as unknown as typeof fetch);
    expect(res.access_token).toBe('service_account_token_abc');
  });
});
