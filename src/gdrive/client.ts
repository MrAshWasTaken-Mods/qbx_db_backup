import fs from 'node:fs';
import { GDriveAuthManager } from './auth';
import {
  type GDriveAuthConfig,
  type GDriveErrorResponse,
  GDriveError,
  type GDriveFile,
  type GDriveListResponse,
  type GDriveStorageQuota,
} from './types';

const DRIVE_API_V3 = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_V3 = 'https://www.googleapis.com/upload/drive/v3';
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB chunks (multiple of 256 KiB)

export interface ResumableUploadParams {
  name: string;
  filePath: string;
  folderId?: string;
  mimeType?: string;
  description?: string;
  chunkSize?: number;
  onProgress?: (bytesUploaded: number, totalBytes: number) => void;
}

export class GDriveClient {
  private readonly auth: GDriveAuthManager;

  constructor(
    private readonly config: GDriveAuthConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.auth = new GDriveAuthManager(config, fetchFn);
  }

  /**
   * Helper to execute an authenticated request with automatic token refresh.
   */
  private async fetchAuth(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    let response = await this.fetchFn(url, { ...init, headers });

    // Handle 401 Unauthorized by refreshing token once.
    // Consume the 401 body first to release the underlying TCP connection before retry.
    if (response.status === 401) {
      await response.body?.cancel();
      this.auth.invalidateToken();
      const freshToken = await this.auth.getAccessToken(true);
      headers.set('Authorization', `Bearer ${freshToken}`);
      response = await this.fetchFn(url, { ...init, headers });
    }

    return response;
  }

  /**
   * Parses Google Drive API errors into typed GDriveError.
   */
  private async parseErrorResponse(response: Response, contextMsg: string): Promise<never> {
    let errorDetail = `HTTP ${response.status} ${response.statusText}`;
    let reason: string | undefined;

    try {
      const errJson = (await response.json()) as GDriveErrorResponse;
      if (errJson.error?.message) {
        errorDetail = errJson.error.message;
      }
      if (errJson.error?.errors?.[0]?.reason) {
        reason = errJson.error.errors[0].reason;
      }
    } catch {
      // Fall back to status text
    }

    throw new GDriveError(`${contextMsg}: ${errorDetail}`, response.status, response.statusText, reason);
  }

  /**
   * Retrieves Google Drive storage quota and user information.
   */
  public async getStorageQuota(): Promise<GDriveStorageQuota> {
    const url = `${DRIVE_API_V3}/about?fields=storageQuota`;
    const response = await this.fetchAuth(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      await this.parseErrorResponse(response, 'Failed to fetch storage quota');
    }

    const data = (await response.json()) as { storageQuota?: Record<string, string> };
    const sq = data.storageQuota || {};

    return {
      limit: sq.limit ? Number(sq.limit) : undefined,
      usage: sq.usage ? Number(sq.usage) : undefined,
      usageInDrive: sq.usageInDrive ? Number(sq.usageInDrive) : undefined,
      usageInDriveTrash: sq.usageInDriveTrash ? Number(sq.usageInDriveTrash) : undefined,
    };
  }

  /**
   * Initiates a resumable upload session and returns the session URI.
   */
  public async initiateResumableUpload(
    name: string,
    fileSize: number,
    folderId?: string,
    mimeType = 'application/zip',
    description?: string
  ): Promise<string> {
    const url = `${DRIVE_UPLOAD_V3}/files?uploadType=resumable`;
    const metadata: Record<string, unknown> = {
      name,
      mimeType,
      description: description || 'Database Backup archive created by qbx_db_backup',
    };

    if (folderId && folderId.toLowerCase() !== 'root') {
      metadata.parents = [folderId];
    }

    const response = await this.fetchAuth(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': fileSize.toString(),
      },
      body: JSON.stringify(metadata),
    });

    if (!response.ok) {
      await this.parseErrorResponse(response, `Failed to initiate resumable upload for '${name}'`);
    }

    const sessionUri = response.headers.get('Location');
    if (!sessionUri) {
      throw new GDriveError('Google Drive did not return a resumable session URI Location header');
    }

    return sessionUri;
  }

  /**
   * Streams a local file to Google Drive using the Resumable Upload protocol in chunks.
   */
  public async uploadFileResumable(params: ResumableUploadParams): Promise<GDriveFile> {
    const { name, filePath, folderId, mimeType = 'application/zip', description, chunkSize = DEFAULT_CHUNK_SIZE, onProgress } = params;

    const stats = await fs.promises.stat(filePath);
    const totalBytes = stats.size;

    const sessionUri = await this.initiateResumableUpload(name, totalBytes, folderId, mimeType, description);

    // If file is 0 bytes (edge case)
    if (totalBytes === 0) {
      const response = await this.fetchFn(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': 'bytes */0',
        },
      });

      if (!response.ok) {
        await this.parseErrorResponse(response, `Failed to upload empty file '${name}'`);
      }
      return (await response.json()) as GDriveFile;
    }

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
      let offset = 0;
      const buffer = Buffer.alloc(chunkSize);

      while (offset < totalBytes) {
        const bytesToRead = Math.min(chunkSize, totalBytes - offset);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        const chunk = buffer.subarray(0, bytesRead);
        const endByte = offset + bytesRead - 1;

        const response = await this.fetchFn(sessionUri, {
          method: 'PUT',
          headers: {
            'Content-Length': bytesRead.toString(),
            'Content-Range': `bytes ${offset}-${endByte}/${totalBytes}`,
            'Content-Type': mimeType,
          },
          body: chunk,
        });

        // 308 Resume Incomplete: chunk accepted, server confirms offset via Range header.
        // FIX #3: Cancel the response body to release the TCP connection immediately.
        // FIX #4: Use the server-confirmed Range end-byte as the authoritative next offset,
        //         rather than blindly trusting our local counter. Per Google's resumable upload
        //         spec (https://developers.google.com/drive/api/guides/manage-uploads#uploading_the_file),
        //         the server returns 'Range: bytes=0-N' where N is the last confirmed byte.
        if (response.status === 308) {
          await response.body?.cancel();
          const rangeHeader = response.headers.get('Range');
          if (rangeHeader) {
            // Range: bytes=0-<lastConfirmedByte>  =>  next offset = lastConfirmedByte + 1
            const match = /bytes=\d+-(?<end>\d+)/.exec(rangeHeader);
            if (match?.groups?.['end'] !== undefined) {
              offset = Number(match.groups['end']) + 1;
            } else {
              offset += bytesRead;
            }
          } else {
            // No Range header: server accepted nothing yet (rare), stay at current offset
            // (don't advance — retry the same chunk)
          }
          if (onProgress) {
            onProgress(offset, totalBytes);
          }
          continue;
        }

        if (response.ok) {
          offset += bytesRead;
          if (onProgress) {
            onProgress(totalBytes, totalBytes);
          }
          return (await response.json()) as GDriveFile;
        }

        await this.parseErrorResponse(response, `Failed to upload chunk ${offset}-${endByte} for '${name}'`);
      }

      throw new GDriveError(`Upload ended unexpectedly without server confirmation for '${name}'`);
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Lists files in a given Google Drive folder matching optional criteria.
   */
  public async listFiles(folderId?: string, namePrefix?: string): Promise<GDriveFile[]> {
    const queryParts: string[] = ['trashed = false'];

    if (folderId && folderId.toLowerCase() !== 'root') {
      queryParts.push(`'${folderId}' in parents`);
    }

    if (namePrefix) {
      queryParts.push(`name contains '${namePrefix}'`);
    }

    const q = queryParts.join(' and ');
    const fields = 'files(id, name, size, mimeType, createdTime, modifiedTime, md5Checksum), nextPageToken';
    const allFiles: GDriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q,
        fields,
        pageSize: '100',
        orderBy: 'createdTime desc',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const url = `${DRIVE_API_V3}/files?${params.toString()}`;
      const response = await this.fetchAuth(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        await this.parseErrorResponse(response, 'Failed to list Google Drive files');
      }

      const data = (await response.json()) as GDriveListResponse;
      if (data.files) {
        for (const f of data.files) {
          allFiles.push({
            id: f.id,
            name: f.name,
            size: f.size ? Number(f.size) : undefined,
            mimeType: f.mimeType,
            createdTime: f.createdTime,
            modifiedTime: f.modifiedTime,
            md5Checksum: f.md5Checksum,
          });
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return allFiles;
  }

  /**
   * Deletes a file permanently from Google Drive by file ID.
   */
  public async deleteFile(fileId: string): Promise<void> {
    const url = `${DRIVE_API_V3}/files/${encodeURIComponent(fileId)}`;
    const response = await this.fetchAuth(url, {
      method: 'DELETE',
    });

    // 204 No Content or 200 OK means successful deletion
    if (!response.ok && response.status !== 204 && response.status !== 200) {
      await this.parseErrorResponse(response, `Failed to delete Google Drive file '${fileId}'`);
    }
  }

  /**
   * Verifies that the target folder is accessible.
   */
  public async verifyFolder(folderId: string): Promise<{ id: string; name: string }> {
    if (!folderId || folderId.toLowerCase() === 'root') {
      return { id: 'root', name: 'My Drive' };
    }

    const url = `${DRIVE_API_V3}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`;
    const response = await this.fetchAuth(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      await this.parseErrorResponse(response, `Cannot access folder ID '${folderId}'`);
    }

    const data = (await response.json()) as { id: string; name: string; mimeType: string; trashed?: boolean };
    if (data.trashed) {
      throw new GDriveError(`Folder ID '${folderId}' is in the trash.`);
    }

    return { id: data.id, name: data.name };
  }
}
