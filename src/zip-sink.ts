import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { ZipArchive } from "archiver";

export type SinkOpenOptions = {
  entryName: string;
  zipLevel: number;
  onZipBytes?: (total: number) => void;
};

export type SinkResult = {
  bytesZip: number;
  sha256: string;
  location?: string;
};

export type OpenSink = {
  append: (source: Readable) => void;
  finish: () => Promise<SinkResult>;
  abort: () => Promise<void>;
  failed: Promise<never>;
};

export type BackupSink = {
  open: (options: SinkOpenOptions) => Promise<OpenSink>;
};

export type UploadSinkOptions = {
  url: string;
  headers?: Record<string, string>;
  maxBytes: number;
  tmpDir?: string;
  keepLocalPath?: string;
};

export class LocalFileSink implements BackupSink {
  constructor(private readonly filePath: string) {}

  async open(options: SinkOpenOptions): Promise<OpenSink> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const partPath = `${this.filePath}.part`;
    const spool = createSpool(partPath, options);
    const filePath = this.filePath;
    return {
      append: spool.append,
      failed: spool.failed,
      finish: async () => {
        const result = await spool.finish();
        await rename(partPath, filePath);
        return { ...result, location: filePath };
      },
      abort: spool.abort,
    };
  }
}

export class UploadSink implements BackupSink {
  constructor(private readonly options: UploadSinkOptions) {}

  async open(options: SinkOpenOptions): Promise<OpenSink> {
    const root = this.options.tmpDir ?? tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(path.join(root, "qbx-db-backup-"));
    const spoolPath = path.join(dir, "backup.zip");
    const spool = createSpool(spoolPath, options, this.options.maxBytes);
    const upload = this.options;
    return {
      append: spool.append,
      failed: spool.failed,
      finish: async () => {
        try {
          const result = await spool.finish();
          if (result.bytesZip > upload.maxBytes) {
            throw new Error(
              `Backup zip is ${result.bytesZip} bytes, over the ${upload.maxBytes} byte limit for this job`,
            );
          }
          await putFile(upload.url, spoolPath, result.bytesZip, upload.headers ?? {});
          const location = await keepLocalCopy(spoolPath, upload.keepLocalPath);
          return location === null ? result : { ...result, location };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      abort: async () => {
        await spool.abort();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
}

type Spool = {
  append: (source: Readable) => void;
  finish: () => Promise<SinkResult>;
  abort: () => Promise<void>;
  failed: Promise<never>;
};

function createSpool(target: string, options: SinkOpenOptions, maxBytes?: number): Spool {
  const zip = new ZipArchive({ zlib: { level: options.zipLevel }, forceZip64: true });
  const counter = createCounter(options.onZipBytes, maxBytes);
  const file = createWriteStream(target);
  let source: Readable | null = null;

  const flushed = new Promise<void>((resolve, reject) => {
    file.once("close", () => resolve());
    file.once("error", reject);
    counter.transform.once("error", reject);
    zip.on("error", (zipError: Error) => reject(new Error(`Zip failed: ${zipError.message}`)));
    zip.on("warning", (warning: Error & { code?: string }) => {
      if (warning.code !== "ENOENT") reject(new Error(`Zip warning: ${warning.message}`));
    });
  });

  const failed = new Promise<never>((_, reject) => {
    flushed.catch((flushError: Error) => {
      source?.destroy(flushError);
      reject(flushError);
    });
  });
  void failed.catch(() => {});

  zip.pipe(counter.transform).pipe(file);

  return {
    append: (input) => {
      source = input;
      zip.append(input, { name: options.entryName });
    },
    finish: async () => {
      await zip.finalize();
      await flushed;
      return { bytesZip: counter.bytes(), sha256: counter.digest() };
    },
    abort: async () => {
      zip.abort();
      counter.transform.destroy();
      file.destroy();
      await rm(target, { force: true });
    },
    failed,
  };
}

function createCounter(onBytes: ((total: number) => void) | undefined, maxBytes?: number) {
  const hash = createHash("sha256");
  let total = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      hash.update(chunk);
      onBytes?.(total);
      if (maxBytes !== undefined && total > maxBytes) {
        callback(new Error(`Backup zip exceeded the ${maxBytes} byte limit for this job`));
        return;
      }
      callback(null, chunk);
    },
  });
  return { transform, bytes: () => total, digest: () => hash.digest("hex") };
}

async function keepLocalCopy(spoolPath: string, destination?: string): Promise<string | null> {
  if (destination === undefined || destination.length === 0) return null;
  await mkdir(path.dirname(destination), { recursive: true });
  const partPath = `${destination}.part`;
  await copyFile(spoolPath, partPath);
  await rename(partPath, destination);
  return destination;
}

/** S3/R2 presigned single PUT rejects chunked bodies, so the length must be known up front. */
function putFile(
  url: string,
  filePath: string,
  size: number,
  headers: Record<string, string>,
): Promise<void> {
  const target = new URL(url);
  const send = target.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/zip",
          "Content-Length": String(size),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (chunks.length < 32) chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 300);
          reject(new Error(`Upload failed with HTTP ${status}${body ? `: ${body}` : ""}`));
        });
      },
    );
    req.on("error", reject);
    const body = createReadStream(filePath);
    body.on("error", reject);
    body.pipe(req);
  });
}
