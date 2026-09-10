import { describe, expect, it } from "bun:test";
import { formatBasicDate, sha256Hex, signS3Request, uriEncode } from "./signer";

describe("AWS SigV4 Signer", () => {
  it("formats basic ISO date and dateScope", () => {
    const testDate = new Date(Date.UTC(2026, 8, 10, 6, 30, 15));
    const { isoDate, dateScope } = formatBasicDate(testDate);
    expect(isoDate).toBe("20260910T063015Z");
    expect(dateScope).toBe("20260910");
  });

  it("uriEncode properly encodes characters and preserves slashes when requested", () => {
    expect(uriEncode("test/path with space/file.sql", false)).toBe(
      "test/path%20with%20space/file.sql",
    );
    expect(uriEncode("test/path with space/file.sql", true)).toBe(
      "test%2Fpath%20with%20space%2Ffile.sql",
    );
    expect(uriEncode("a-b_c.d~e", false)).toBe("a-b_c.d~e");
  });

  it("calculates deterministic SHA256 hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("hello world")).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("generates correct signing keys and authorization headers", () => {
    const fixedNow = new Date(Date.UTC(2026, 8, 10, 12, 0, 0));
    const signed = signS3Request({
      method: "PUT",
      url: "https://mybucket.s3.us-east-1.amazonaws.com/backups/db-2026.zip",
      headers: {
        "content-type": "application/zip",
        "content-length": "1024",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      now: fixedNow,
    });

    expect(signed.method).toBe("PUT");
    expect(signed.headers.host).toBe("mybucket.s3.us-east-1.amazonaws.com");
    expect(signed.headers["x-amz-date"]).toBe("20260910T120000Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260910/us-east-1/s3/aws4_request",
    );
    expect(signed.headers.authorization).toContain(
      "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(signed.headers.authorization).toMatch(/Signature=[a-f0-9]{64}/);
  });

  it("handles query params in canonical order with URI encoding", () => {
    const fixedNow = new Date(Date.UTC(2026, 8, 10, 12, 0, 0));
    const signed = signS3Request({
      method: "GET",
      url: "https://s3.us-east-1.amazonaws.com/mybucket?list-type=2&prefix=backups%2F&max-keys=100",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      region: "us-east-1",
      now: fixedNow,
    });

    expect(signed.headers.authorization).toContain(
      "Credential=TESTKEY/20260910/us-east-1/s3/aws4_request",
    );
    expect(signed.headers.authorization).toMatch(/Signature=[a-f0-9]{64}/);
  });
});
