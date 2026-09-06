import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UploadInfo, UploadSink } from "./zip-sink";

type ReceivedPut = {
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

const received: ReceivedPut[] = [];
let server: Server;
let uploadUrl: string;

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
      });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  uploadUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/put`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "qbx-upload-sink-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sql = Buffer.from("INSERT INTO players VALUES (1);\n".repeat(500), "utf8");

describe("UploadSink", () => {
  it("resolves the upload with the spooled size and digest, then PUTs it", async () => {
    await withTempDir(async (dir) => {
      const resolved: UploadInfo[] = [];
      const sink = new UploadSink({
        tmpDir: dir,
        resolveUpload: async (info) => {
          resolved.push(info);
          return { url: uploadUrl, headers: { "x-qbx-signature": "abc123" } };
        },
      });

      const open = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
      open.append(Readable.from([sql]));
      const result = await open.finish();

      expect(resolved).toHaveLength(1);
      const info = resolved[0]!;
      expect(info.sizeBytes).toBe(result.bytesZip);
      expect(info.sha256).toBe(result.sha256);

      expect(received).toHaveLength(1);
      const put = received[0]!;
      expect(put.method).toBe("PUT");
      expect(put.headers["content-length"]).toBe(String(info.sizeBytes));
      expect(put.headers["content-type"]).toBe("application/zip");
      expect(put.headers["x-qbx-signature"]).toBe("abc123");
      expect(put.body.length).toBe(info.sizeBytes);
      expect(createHash("sha256").update(put.body).digest("hex")).toBe(info.sha256);

      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("aborts without uploading when the upload cannot be resolved", async () => {
    await withTempDir(async (dir) => {
      const sink = new UploadSink({
        tmpDir: dir,
        resolveUpload: async () => {
          throw new Error("Backup is larger than the storage pool for this plan");
        },
      });

      const open = await sink.open({ entryName: "dump.sql", zipLevel: 1 });
      open.append(Readable.from([sql]));

      await expect(open.finish()).rejects.toThrow(/larger than the storage pool/);
      expect(received).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
