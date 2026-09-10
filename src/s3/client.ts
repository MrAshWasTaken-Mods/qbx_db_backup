import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { sha256Hex, signS3Request } from "./signer";
import type {
  S3ClientOptions,
  S3DeleteResult,
  S3ListResult,
  S3ObjectInfo,
  S3PutOptions,
  S3PutResult,
} from "./types";

export class S3Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly rawBody?: string,
  ) {
    super(`S3 Error [${code}]: ${message}`);
    this.name = "S3Error";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class S3Client {
  public readonly bucket: string;
  public readonly region: string;
  public readonly endpoint?: string;
  public readonly forcePathStyle: boolean;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly timeoutMs: number;

  constructor(options: S3ClientOptions) {
    if (!options.bucket || options.bucket.trim().length === 0) {
      throw new Error("S3 bucket name is required");
    }
    if (!options.accessKeyId || options.accessKeyId.trim().length === 0) {
      throw new Error("S3 access key ID is required");
    }
    if (!options.secretAccessKey || options.secretAccessKey.trim().length === 0) {
      throw new Error("S3 secret access key is required");
    }

    this.bucket = options.bucket.trim();
    this.accessKeyId = options.accessKeyId.trim();
    this.secretAccessKey = options.secretAccessKey.trim();
    this.region = options.region?.trim() || "us-east-1";
    this.endpoint = options.endpoint?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // By default, custom endpoints use path style (e.g. MinIO, R2), while AWS standard uses virtual-hosted
    this.forcePathStyle =
      options.forcePathStyle ?? (this.endpoint !== undefined && this.endpoint.length > 0);
  }

  public buildUrl(key = "", query?: Record<string, string>): URL {
    let baseUrl: string;
    const cleanKey = key.replace(/^\/+/, "");

    if (this.endpoint) {
      const ep = this.endpoint.replace(/\/+$/, "");
      if (this.forcePathStyle) {
        baseUrl = cleanKey.length > 0 ? `${ep}/${this.bucket}/${cleanKey}` : `${ep}/${this.bucket}`;
      } else {
        const parsed = new URL(ep);
        baseUrl = `${parsed.protocol}//${this.bucket}.${parsed.host}${parsed.pathname.replace(/\/+$/, "")}/${cleanKey}`;
      }
    } else {
      if (this.forcePathStyle) {
        baseUrl =
          cleanKey.length > 0
            ? `https://s3.${this.region}.amazonaws.com/${this.bucket}/${cleanKey}`
            : `https://s3.${this.region}.amazonaws.com/${this.bucket}`;
      } else {
        baseUrl =
          cleanKey.length > 0
            ? `https://${this.bucket}.s3.${this.region}.amazonaws.com/${cleanKey}`
            : `https://${this.bucket}.s3.${this.region}.amazonaws.com/`;
      }
    }

    const url = new URL(baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) {
          url.searchParams.set(k, v);
        }
      }
    }
    return url;
  }

  public async putObject(
    key: string,
    body: Readable | Buffer,
    sizeBytes: number,
    payloadSha256: string,
    options?: S3PutOptions,
  ): Promise<S3PutResult> {
    const url = this.buildUrl(key);
    const contentType = options?.contentType ?? "application/zip";

    const customHeaders: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(sizeBytes),
    };

    if (options?.metadata) {
      for (const [mKey, mVal] of Object.entries(options.metadata)) {
        customHeaders[`x-amz-meta-${mKey.toLowerCase()}`] = mVal;
      }
    }

    const signed = signS3Request({
      method: "PUT",
      url,
      headers: customHeaders,
      payloadHash: payloadSha256,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });

    const response = await this.executeRequest(signed, body);
    const etag = (response.headers.etag as string | undefined)?.replace(/"/g, "") ?? "";
    return { etag };
  }

  public async listObjectsV2(options?: {
    prefix?: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<S3ListResult> {
    const query: Record<string, string> = { "list-type": "2" };
    if (options?.prefix) query.prefix = options.prefix;
    if (options?.continuationToken) query["continuation-token"] = options.continuationToken;
    if (options?.maxKeys) query["max-keys"] = String(options.maxKeys);

    const url = this.buildUrl("", query);

    const signed = signS3Request({
      method: "GET",
      url,
      payloadHash: sha256Hex(""),
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });

    const response = await this.executeRequest(signed);
    return parseListObjectsV2Xml(response.body);
  }

  public async deleteObjects(keys: string[]): Promise<S3DeleteResult> {
    if (keys.length === 0) {
      return { deletedKeys: [], errors: [] };
    }

    const objectsXml = keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("");
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${objectsXml}</Delete>`;
    const bodyBuffer = Buffer.from(xmlBody, "utf8");
    const payloadHash = sha256Hex(bodyBuffer);

    const url = this.buildUrl("", { delete: "" });

    const signed = signS3Request({
      method: "POST",
      url,
      headers: {
        "content-type": "application/xml",
        "content-length": String(bodyBuffer.length),
      },
      payloadHash,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });

    const response = await this.executeRequest(signed, bodyBuffer);
    return parseDeleteResultXml(response.body, keys);
  }

  public async testConnection(): Promise<{ ok: true; bucket: string; region: string }> {
    // Perform a lightweight ListObjectsV2 with max-keys=1 to verify credentials and bucket access
    await this.listObjectsV2({ maxKeys: 1 });
    return { ok: true, bucket: this.bucket, region: this.region };
  }

  private executeRequest(
    signed: { method: string; url: string; headers: Record<string, string> },
    body?: Readable | Buffer,
  ): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> {
    const target = new URL(signed.url);
    const send = target.protocol === "http:" ? httpRequest : httpsRequest;

    return new Promise((resolve, reject) => {
      let aborted = false;
      const timer = setTimeout(() => {
        aborted = true;
        req.destroy(new Error(`S3 request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const req = send(
        target,
        {
          method: signed.method,
          headers: signed.headers,
        },
        (res) => {
          clearTimeout(timer);
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            if (chunks.length < 1024) chunks.push(chunk);
          });
          res.on("error", (resErr) => {
            clearTimeout(timer);
            reject(resErr);
          });
          res.on("end", () => {
            clearTimeout(timer);
            const statusCode = res.statusCode ?? 0;
            const resBody = Buffer.concat(chunks).toString("utf8");

            if (statusCode >= 200 && statusCode < 300) {
              resolve({ statusCode, headers: res.headers, body: resBody });
              return;
            }

            const parsedError = parseS3ErrorXml(resBody, statusCode);
            reject(parsedError);
          });
        },
      );

      req.on("error", (reqErr) => {
        clearTimeout(timer);
        if (!aborted) reject(reqErr);
      });

      if (body) {
        if (Buffer.isBuffer(body)) {
          req.end(body);
        } else {
          body.on("error", (streamErr) => {
            clearTimeout(timer);
            req.destroy(streamErr);
            reject(streamErr);
          });
          body.pipe(req);
        }
      } else {
        req.end();
      }
    });
  }
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function parseS3ErrorXml(xml: string, statusCode: number): S3Error {
  const codeMatch = /<Code>(.*?)<\/Code>/s.exec(xml);
  const messageMatch = /<Message>(.*?)<\/Message>/s.exec(xml);

  const code = codeMatch?.[1]?.trim() ?? `HTTP_${statusCode}`;
  const message =
    messageMatch?.[1]?.trim() ??
    (xml.slice(0, 200).trim() || `Request failed with HTTP status ${statusCode}`);

  return new S3Error(code, message, statusCode, xml);
}

export function parseListObjectsV2Xml(xml: string): S3ListResult {
  const isTruncated =
    /<IsTruncated>(true|false)<\/IsTruncated>/i.exec(xml)?.[1]?.toLowerCase() === "true";
  const nextToken = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/s.exec(xml)?.[1]?.trim();

  const objects: S3ObjectInfo[] = [];
  const contentsRegex = /<Contents>(.*?)<\/Contents>/gs;
  let match: RegExpExecArray | null = null;

  while (true) {
    match = contentsRegex.exec(xml);
    if (!match) break;
    const itemXml = match[1] ?? "";

    const key = /<Key>(.*?)<\/Key>/s.exec(itemXml)?.[1]?.trim();
    const lastModifiedRaw = /<LastModified>(.*?)<\/LastModified>/s.exec(itemXml)?.[1]?.trim();
    const sizeRaw = /<Size>(\d+)<\/Size>/s.exec(itemXml)?.[1]?.trim();
    const etag = (
      / <ETag>(.*?)<\/ETag>/s.exec(itemXml)?.[1] ??
      /<ETag>(.*?)<\/ETag>/s.exec(itemXml)?.[1]?.trim() ??
      ""
    ).replace(/"/g, "");

    if (key && lastModifiedRaw) {
      objects.push({
        key,
        lastModified: new Date(lastModifiedRaw),
        sizeBytes: sizeRaw ? Number.parseInt(sizeRaw, 10) : 0,
        etag,
      });
    }
  }

  return {
    objects,
    isTruncated,
    nextContinuationToken: nextToken,
  };
}

export function parseDeleteResultXml(xml: string, fallbackKeys: string[]): S3DeleteResult {
  const deletedKeys: string[] = [];
  const errors: { key: string; code: string; message: string }[] = [];

  const deletedRegex = /<Deleted>(.*?)<\/Deleted>/gs;
  let dMatch: RegExpExecArray | null = null;
  while (true) {
    dMatch = deletedRegex.exec(xml);
    if (!dMatch) break;
    const k = /<Key>(.*?)<\/Key>/s.exec(dMatch[1] ?? "")?.[1]?.trim();
    if (k) deletedKeys.push(k);
  }

  const errorRegex = /<Error>(.*?)<\/Error>/gs;
  let eMatch: RegExpExecArray | null = null;
  while (true) {
    eMatch = errorRegex.exec(xml);
    if (!eMatch) break;
    const eXml = eMatch[1] ?? "";
    const k = /<Key>(.*?)<\/Key>/s.exec(eXml)?.[1]?.trim() ?? "";
    const code = /<Code>(.*?)<\/Code>/s.exec(eXml)?.[1]?.trim() ?? "Unknown";
    const msg = /<Message>(.*?)<\/Message>/s.exec(eXml)?.[1]?.trim() ?? "";
    errors.push({ key: k, code, message: msg });
  }

  // If the S3 provider returned empty response on 200 OK without errors, all requested keys were deleted
  if (deletedKeys.length === 0 && errors.length === 0) {
    return { deletedKeys: [...fallbackKeys], errors: [] };
  }

  return { deletedKeys, errors };
}
