export type S3Config = {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
  keepCount: number;
  maxAgeDays: number;
};

export type S3ClientOptions = {
  endpoint?: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  timeoutMs?: number;
};

export type S3SignedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type S3ObjectInfo = {
  key: string;
  lastModified: Date;
  sizeBytes: number;
  etag: string;
};

export type S3ListResult = {
  objects: S3ObjectInfo[];
  isTruncated: boolean;
  nextContinuationToken?: string;
};

export type S3PutOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
};

export type S3PutResult = {
  etag: string;
};

export type S3DeleteResult = {
  deletedKeys: string[];
  errors: { key: string; code: string; message: string }[];
};
