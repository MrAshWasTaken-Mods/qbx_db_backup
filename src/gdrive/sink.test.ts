import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GDriveClient } from './client';
import { GDriveSink } from './sink';
import type { GDriveOAuthConfig } from './types';

describe('GDriveSink', () => {
  let tmpDir: string;

  const validConfig: GDriveOAuthConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  };

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gdrive-sink-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('spools zip, uploads directly to Google Drive, and cleans up temp files', async () => {
    let uploadCalled = false;

    const mockFetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'valid_token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/files?uploadType=resumable')) {
        return new Response('', {
          status: 200,
          headers: { Location: 'https://upload.example.com/session_sink' },
        });
      }
      if (urlStr === 'https://upload.example.com/session_sink') {
        uploadCalled = true;
        return new Response(
          JSON.stringify({
            id: 'gdrive_file_id_999',
            name: 'qbx-2026-09-11_12-00-00Z.zip',
            size: '1024',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const sink = new GDriveSink({
      client,
      fileName: 'qbx-2026-09-11_12-00-00Z.zip',
      folderId: 'folder_root_123',
      tmpDir,
    });

    const openSink = await sink.open({ entryName: 'dump.sql', zipLevel: 6 });
    openSink.append(Readable.from(['-- MySQL dump test content\nINSERT INTO users VALUES (1);']));

    const result = await openSink.finish();

    expect(uploadCalled).toBe(true);
    expect(result.bytesZip).toBeGreaterThan(0);
    expect(result.sha256).toHaveLength(64);
    expect(result.location).toContain('gdrive://folder_root_123/gdrive_file_id_999');

    // Confirm tmp directory was cleaned up
    const remainingFiles = await fs.promises.readdir(tmpDir);
    expect(remainingFiles.length).toBe(0);
  });

  it('supports dual-write with keepLocalPath', async () => {
    const mockFetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'valid_token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/files?uploadType=resumable')) {
        return new Response('', {
          status: 200,
          headers: { Location: 'https://upload.example.com/session_sink2' },
        });
      }
      if (urlStr === 'https://upload.example.com/session_sink2') {
        return new Response(
          JSON.stringify({
            id: 'gdrive_file_id_local_copy',
            name: 'backup.zip',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const localCopyPath = path.join(tmpDir, 'local_backups', 'backup.zip');
    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const sink = new GDriveSink({
      client,
      fileName: 'backup.zip',
      tmpDir,
      keepLocalPath: localCopyPath,
    });

    const openSink = await sink.open({ entryName: 'dump.sql', zipLevel: 1 });
    openSink.append(Readable.from(['Sample SQL']));
    const result = await openSink.finish();

    expect(result.location).toContain('local:');
    expect(fs.existsSync(localCopyPath)).toBe(true);
  });

  it('cleans up temp directory on abort', async () => {
    const mockFetch = mock(async () => new Response(''));
    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const sink = new GDriveSink({
      client,
      fileName: 'backup.zip',
      tmpDir,
    });

    const openSink = await sink.open({ entryName: 'dump.sql', zipLevel: 1 });
    openSink.append(Readable.from(['abort test']));
    await openSink.abort();

    const remainingFiles = await fs.promises.readdir(tmpDir);
    expect(remainingFiles.length).toBe(0);
  });
});
