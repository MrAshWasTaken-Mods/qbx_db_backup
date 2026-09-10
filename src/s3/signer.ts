import { createHash, createHmac } from "node:crypto";
import type { S3SignedRequest } from "./types";

export type SignOptions = {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  payloadHash?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
};

export function uriEncode(input: string, encodeSlash = false): string {
  let result = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      char === "_" ||
      char === "-" ||
      char === "~" ||
      char === "."
    ) {
      result += char;
    } else if (char === "/" && !encodeSlash) {
      result += "/";
    } else {
      const hex = char.charCodeAt(0).toString(16).toUpperCase();
      result += hex.length < 2 ? `%0${hex}` : `%${hex}`;
    }
  }
  return result;
}

export function formatBasicDate(date: Date): { isoDate: string; dateScope: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  const dateScope = `${year}${month}${day}`;
  const isoDate = `${dateScope}T${hours}${minutes}${seconds}Z`;
  return { isoDate, dateScope };
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function getSigningKey(
  secretKey: string,
  dateScope: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac("sha256", `AWS4${secretKey}`).update(dateScope).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

export function signS3Request(options: SignOptions): S3SignedRequest {
  const targetUrl = typeof options.url === "string" ? new URL(options.url) : options.url;
  const now = options.now ?? new Date();
  const { isoDate, dateScope } = formatBasicDate(now);
  const service = options.service ?? "s3";
  const payloadHash = options.payloadHash ?? sha256Hex("");

  const method = options.method.toUpperCase();

  const headers: Record<string, string> = {
    ...options.headers,
    host: targetUrl.host,
    "x-amz-date": isoDate,
    "x-amz-content-sha256": payloadHash,
  };

  // Build canonical headers & signed headers
  const headerKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();

  const canonicalHeadersList: string[] = [];
  for (const key of headerKeys) {
    const rawVal = headers[key] ?? "";
    const cleanVal = rawVal.trim().replace(/\s+/g, " ");
    canonicalHeadersList.push(`${key}:${cleanVal}\n`);
  }
  const canonicalHeaders = canonicalHeadersList.join("");
  const signedHeaders = headerKeys.join(";");

  // Build canonical URI
  const rawPath = targetUrl.pathname || "/";
  const canonicalUri = uriEncode(rawPath, false);

  // Build canonical query string
  const queryEntries: [string, string][] = [];
  targetUrl.searchParams.forEach((value, key) => {
    queryEntries.push([uriEncode(key, true), uriEncode(value, true)]);
  });
  queryEntries.sort(([aKey, aVal], [bKey, bVal]) => {
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return aVal < bVal ? -1 : 1;
  });
  const canonicalQueryString = queryEntries.map(([k, v]) => `${k}=${v}`).join("&");

  // Build canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalRequestHash = sha256Hex(canonicalRequest);

  // Build string to sign
  const credentialScope = `${dateScope}/${options.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", isoDate, credentialScope, canonicalRequestHash].join(
    "\n",
  );

  // Calculate signature
  const signingKey = getSigningKey(options.secretAccessKey, dateScope, options.region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    method,
    url: targetUrl.toString(),
    headers: {
      ...headers,
      authorization,
    },
  };
}
