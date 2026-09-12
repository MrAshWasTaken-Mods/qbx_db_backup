import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GDriveClient } from "./client";
import type { GDriveOAuthConfig } from "./types";

describe("Google Drive REST Client", () => {
  let tmpDir: string;
  let testFilePath: string;

  const validConfig: GDriveOAuthConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
  };

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gdrive-test-"));
    testFilePath = path.join(tmpDir, "backup.zip");
    // Create an 8MB dummy file for multi-chunk test
    const dummyBuffer = Buffer.alloc(8 * 1024 * 1024, 0x41);
    await fs.promises.writeFile(testFilePath, dummyBuffer);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("fetches storage quota correctly from about API", async () => {
    const mockFetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/about?fields=storageQuota")) {
        return new Response(
          JSON.stringify({
            storageQuota: {
              limit: "16106127360", // 15 GB
              usage: "5368709120", // 5 GB
              usageInDrive: "4294967296",
              usageInDriveTrash: "1073741824",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const quota = await client.getStorageQuota();

    expect(quota.limit).toBe(16106127360);
    expect(quota.usage).toBe(5368709120);
    expect(quota.usageInDrive).toBe(4294967296);
  });

  it("initiates resumable upload and returns session URI", async () => {
    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/files?uploadType=resumable")) {
        expect(init?.headers).toBeDefined();
        const headers = init?.headers as Headers;
        expect(headers.get("Authorization")).toBe("Bearer valid_token");
        expect(headers.get("X-Upload-Content-Type")).toBe("application/zip");
        expect(headers.get("X-Upload-Content-Length")).toBe("8388608");

        return new Response("", {
          status: 200,
          headers: {
            Location:
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_xyz",
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const sessionUri = await client.initiateResumableUpload("backup.zip", 8388608, "folder_123");

    expect(sessionUri).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_xyz",
    );
  });

  it("streams multi-chunk resumable upload with 308 resume incomplete handling", async () => {
    let chunksUploaded = 0;

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/files?uploadType=resumable")) {
        return new Response("", {
          status: 200,
          headers: {
            Location: "https://upload.example.com/session_123",
          },
        });
      }
      if (urlStr === "https://upload.example.com/session_123") {
        chunksUploaded++;
        // First chunk (4MB of 8MB) returns 308
        if (chunksUploaded === 1) {
          expect(init?.headers).toBeDefined();
          return new Response("", {
            status: 308,
            headers: { Range: "bytes=0-4194303" },
          });
        }
        // Second chunk finishes upload with 200 OK
        return new Response(
          JSON.stringify({
            id: "file_id_final",
            name: "backup.zip",
            size: "8388608",
            mimeType: "application/zip",
            md5Checksum: "abc123md5",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const uploadedFile = await client.uploadFileResumable({
      name: "backup.zip",
      filePath: testFilePath,
      chunkSize: 4 * 1024 * 1024, // 4MB chunks
    });

    expect(chunksUploaded).toBe(2);
    expect(uploadedFile.id).toBe("file_id_final");
    expect(uploadedFile.name).toBe("backup.zip");
    expect(uploadedFile.md5Checksum).toBe("abc123md5");
  });

  it("lists files and handles pagination and ordering", async () => {
    let listCallCount = 0;
    const mockFetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/drive/v3/files")) {
        listCallCount++;
        if (listCallCount === 1) {
          return new Response(
            JSON.stringify({
              files: [{ id: "f1", name: "qbx-2026-09-11_12-00-00Z.zip", size: "1000" }],
              nextPageToken: "page2",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            files: [{ id: "f2", name: "qbx-2026-09-10_12-00-00Z.zip", size: "2000" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const files = await client.listFiles("folder_abc", "qbx");

    expect(files.length).toBe(2);
    expect(files[0]!.id).toBe("f1");
    expect(files[1]!.id).toBe("f2");
    expect(listCallCount).toBe(2);
  });

  it("deletes a file permanently with DELETE request", async () => {
    let deletedId = "";
    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "valid_token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/drive/v3/files/file_to_delete")) {
        expect(init?.method).toBe("DELETE");
        deletedId = "file_to_delete";
        return new Response("", { status: 204 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    await client.deleteFile("file_to_delete");

    expect(deletedId).toBe("file_to_delete");
  });

  it("refreshes token on 401 Unauthorized and retries request", async () => {
    let tokenCallCount = 0;
    let driveCallCount = 0;

    const mockFetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://oauth2.googleapis.com/token") {
        tokenCallCount++;
        return new Response(
          JSON.stringify({ access_token: `token_${tokenCallCount}`, expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/about?fields=storageQuota")) {
        driveCallCount++;
        if (driveCallCount === 1) {
          // Simulate expired token on first try
          return new Response(
            JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ storageQuota: { limit: "1000" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new GDriveClient(validConfig, mockFetch as unknown as typeof fetch);
    const quota = await client.getStorageQuota();

    expect(quota.limit).toBe(1000);
    expect(tokenCallCount).toBe(2);
    expect(driveCallCount).toBe(2);
  });
});
