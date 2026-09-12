import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { ZipArchive } from "archiver";
import type { BackupSink, OpenSink, SinkOpenOptions, SinkResult } from "../zip-sink";
import type { GDriveClient } from "./client";

export type GDriveSinkOptions = {
  client: GDriveClient;
  fileName: string;
  folderId?: string;
  tmpDir: string;
  keepLocalPath?: string;
  maxBytes?: number;
};

export class GDriveSink implements BackupSink {
  constructor(private readonly options: GDriveSinkOptions) {}

  async open(options: SinkOpenOptions): Promise<OpenSink> {
    const root = this.options.tmpDir;
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(path.join(root, "qbx-gdrive-sink-"));
    const spoolPath = path.join(dir, "backup.zip");
    const spool = createSpool(spoolPath, options, this.options.maxBytes);
    const opts = this.options;

    return {
      append: spool.append,
      failed: spool.failed,
      finish: async () => {
        try {
          const result = await spool.finish();
          if (opts.maxBytes !== undefined && result.bytesZip > opts.maxBytes) {
            throw new Error(
              `Backup zip is ${result.bytesZip} bytes, exceeding the ${opts.maxBytes} byte limit`,
            );
          }

          const uploadedFile = await opts.client.uploadFileResumable({
            name: opts.fileName,
            filePath: spoolPath,
            folderId: opts.folderId,
            mimeType: "application/zip",
            description: `Automated Qbox Database Backup (SHA256: ${result.sha256})`,
          });

          const localCopy = await keepLocalCopy(spoolPath, opts.keepLocalPath);
          const gdriveLocation = `gdrive://${opts.folderId || "root"}/${uploadedFile.id} (${uploadedFile.name})`;
          return localCopy === null
            ? { ...result, location: gdriveLocation }
            : { ...result, location: `${gdriveLocation} (+ local: ${localCopy})` };
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
