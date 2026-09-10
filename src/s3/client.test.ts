import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { S3Client } from "./client";
import { sha256Hex } from "./signer";

type MockRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
};

describe("S3Client", () => {
  let server: Server;
  let mockPort: number;
  let receivedRequests: MockRequest[] = [];
  let mockHandler:
    | ((req: MockRequest) => { status: number; headers?: Record<string, string>; body: string })
    | null = null;

  beforeEach(async () => {
    receivedRequests = [];
    mockHandler = null;

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const mockReq: MockRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: bodyStr,
        };
        receivedRequests.push(mockReq);

        const response = mockHandler ? mockHandler(mockReq) : { status: 200, body: "" };
        res.writeHead(response.status, response.headers ?? { "content-type": "application/xml" });
        res.end(response.body);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    mockPort = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("constructs path-style and virtual-hosted URLs properly", () => {
    const r2Client = new S3Client({
      endpoint: "https://account123.r2.cloudflarestorage.com",
      bucket: "fivem-backups",
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "auto",
      forcePathStyle: true,
    });
    expect(r2Client.buildUrl("mydb/dump.zip").toString()).toBe(
      "https://account123.r2.cloudflarestorage.com/fivem-backups/mydb/dump.zip",
    );

    const awsClient = new S3Client({
      bucket: "my-aws-bucket",
      accessKeyId: "KEY",
      secretAccessKey: "SECRET",
      region: "us-west-2",
      forcePathStyle: false,
    });
    expect(awsClient.buildUrl("prod/backup.zip").toString()).toBe(
      "https://my-aws-bucket.s3.us-west-2.amazonaws.com/prod/backup.zip",
    );
  });

  it("streams putObject with SigV4 headers and payload hash", async () => {
    mockHandler = (req) => {
      expect(req.method).toBe("PUT");
      expect(req.url).toBe("/test-bucket/backups/dump.zip");
      expect(req.headers.authorization).toContain("AWS4-HMAC-SHA256");
      expect(req.headers["content-type"]).toBe("application/zip");
      expect(req.headers["x-amz-content-sha256"]).toBe(sha256Hex("test-content"));
      return { status: 200, headers: { etag: '"abc123etag"' }, body: "" };
    };

    const client = new S3Client({
      endpoint: `http://127.0.0.1:${mockPort}`,
      bucket: "test-bucket",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      region: "us-east-1",
      forcePathStyle: true,
    });

    const content = Buffer.from("test-content", "utf8");
    const result = await client.putObject(
      "backups/dump.zip",
      Readable.from([content]),
      content.length,
      sha256Hex(content),
    );

    expect(result.etag).toBe("abc123etag");
    expect(receivedRequests.length).toBe(1);
  });

  it("lists objects with ListObjectsV2 XML parsing", async () => {
    mockHandler = () => ({
      status: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>test-bucket</Name>
    <Prefix>backups/</Prefix>
    <KeyCount>2</KeyCount>
    <MaxKeys>1000</MaxKeys>
    <IsTruncated>false</IsTruncated>
    <Contents>
        <Key>backups/db-2026-09-09_12-00-00Z.zip</Key>
        <LastModified>2026-09-09T12:00:00.000Z</LastModified>
        <ETag>"123456"</ETag>
        <Size>1048576</Size>
    </Contents>
    <Contents>
        <Key>backups/db-2026-09-10_12-00-00Z.zip</Key>
        <LastModified>2026-09-10T12:00:00.000Z</LastModified>
        <ETag>"789012"</ETag>
        <Size>2097152</Size>
    </Contents>
</ListBucketResult>`,
    });

    const client = new S3Client({
      endpoint: `http://127.0.0.1:${mockPort}`,
      bucket: "test-bucket",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      region: "us-east-1",
      forcePathStyle: true,
    });

    const list = await client.listObjectsV2({ prefix: "backups/" });
    expect(list.isTruncated).toBe(false);
    expect(list.objects).toHaveLength(2);
    expect(list.objects[0]!.key).toBe("backups/db-2026-09-09_12-00-00Z.zip");
    expect(list.objects[0]!.sizeBytes).toBe(1048576);
    expect(list.objects[1]!.key).toBe("backups/db-2026-09-10_12-00-00Z.zip");
    expect(list.objects[1]!.sizeBytes).toBe(2097152);
  });

  it("deletes multiple objects in batch with DeleteObjects XML", async () => {
    mockHandler = (req) => {
      expect(req.method).toBe("POST");
      expect(req.url).toContain("delete");
      expect(req.body).toContain("<Key>backups/old1.zip</Key>");
      expect(req.body).toContain("<Key>backups/old2.zip</Key>");
      return {
        status: 200,
        body: `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Deleted><Key>backups/old1.zip</Key></Deleted>
    <Deleted><Key>backups/old2.zip</Key></Deleted>
</DeleteResult>`,
      };
    };

    const client = new S3Client({
      endpoint: `http://127.0.0.1:${mockPort}`,
      bucket: "test-bucket",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      region: "us-east-1",
      forcePathStyle: true,
    });

    const result = await client.deleteObjects(["backups/old1.zip", "backups/old2.zip"]);
    expect(result.deletedKeys).toEqual(["backups/old1.zip", "backups/old2.zip"]);
    expect(result.errors).toHaveLength(0);
  });

  it("parses S3 error XML and throws S3Error with code and message", async () => {
    mockHandler = () => ({
      status: 403,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Access Denied to bucket test-bucket</Message>
    <Resource>/test-bucket/file.zip</Resource>
</Error>`,
    });

    const client = new S3Client({
      endpoint: `http://127.0.0.1:${mockPort}`,
      bucket: "test-bucket",
      accessKeyId: "INVALID",
      secretAccessKey: "INVALID",
      region: "us-east-1",
      forcePathStyle: true,
    });

    await expect(
      client.putObject("file.zip", Readable.from([Buffer.from("a")]), 1, sha256Hex("a")),
    ).rejects.toThrow(/S3 Error \[AccessDenied\]: Access Denied/);
  });
});
