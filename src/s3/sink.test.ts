import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "./client";
import { S3Sink } from "./sink";

type ReceivedPut = {
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: string;
};

const received: ReceivedPut[] = [];
let server: Server;
let mockPort: number;

beforeEach(async () => {
  received.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
        url: req.url ?? "",
      });
      res.writeHead(200, { etag: '"test-etag-123"' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mockPort = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "qbx-s3-sink-test-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sql = Buffer.from("CREATE TABLE users (id INT);\n".repeat(100), "utf8");

describe("S3Sink", () => {
  it("spools zip, uploads directly to S3 with SigV4 headers, and cleans up temp files", async () => {
    await withTempDir(async (dir) => {
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${mockPort}`,
        bucket: "backups-bucket",
        accessKeyId: "KEY123",
        secretAccessKey: "SECRET123",
        region: "us-east-1",
        forcePathStyle: true,
      });

      const sink = new S3Sink({
        client,
        s3Key: "qbox-2026-09-10.zip",
        tmpDir: dir,
      });

      const open = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
      open.append(Readable.from([sql]));
      const result = await open.finish();

      expect(result.bytesZip).toBeGreaterThan(0);
      expect(result.location).toBe("s3://backups-bucket/qbox-2026-09-10.zip");

      expect(received).toHaveLength(1);
      const put = received[0]!;
      expect(put.method).toBe("PUT");
      expect(put.url).toBe("/backups-bucket/qbox-2026-09-10.zip");
      expect(put.headers.authorization).toContain("AWS4-HMAC-SHA256");
      expect(put.headers["content-type"]).toBe("application/zip");
      expect(put.headers["content-length"]).toBe(String(result.bytesZip));
      expect(createHash("sha256").update(put.body).digest("hex")).toBe(result.sha256);

      // Verify temp dir is clean
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("supports dual-write with keepLocalPath", async () => {
    await withTempDir(async (dir) => {
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${mockPort}`,
        bucket: "backups-bucket",
        accessKeyId: "KEY123",
        secretAccessKey: "SECRET123",
        region: "us-east-1",
        forcePathStyle: true,
      });

      const localCopyPath = path.join(dir, "local-copy.zip");

      const sink = new S3Sink({
        client,
        s3Key: "qbox-dual.zip",
        tmpDir: path.join(dir, ".tmp"),
        keepLocalPath: localCopyPath,
      });

      const open = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
      open.append(Readable.from([sql]));
      const result = await open.finish();

      expect(result.location).toContain("s3://backups-bucket/qbox-dual.zip");
      expect(result.location).toContain("local:");

      const localFile = await readFile(localCopyPath);
      expect(localFile.length).toBe(result.bytesZip);
      expect(createHash("sha256").update(localFile).digest("hex")).toBe(result.sha256);
    });
  });

  it("cleans up temp directory on abort", async () => {
    await withTempDir(async (dir) => {
      const client = new S3Client({
        endpoint: `http://127.0.0.1:${mockPort}`,
        bucket: "backups-bucket",
        accessKeyId: "KEY123",
        secretAccessKey: "SECRET123",
        region: "us-east-1",
        forcePathStyle: true,
      });

      const sink = new S3Sink({
        client,
        s3Key: "qbox-aborted.zip",
        tmpDir: dir,
      });

      const open = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
      open.append(Readable.from([sql]));
      await open.abort();

      expect(received).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
