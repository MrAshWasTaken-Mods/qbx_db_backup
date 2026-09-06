import type { DumpBinary } from "./dump";

export type BackupJob = {
  jobId: string;
  fileName: string;
  entryName: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
};

export type HeartbeatPayload = {
  version: string;
  platform: string;
  dumpBinary: DumpBinary | null;
  database: string;
};

export type ProgressPayload = {
  phase: "dump" | "upload";
  bytesSql: number;
  bytesZip: number;
};

export type CompletePayload =
  | {
      ok: true;
      sizeBytes: number;
      rawBytes: number;
      sha256: string;
      durationMs: number;
      warnings: string[];
    }
  | { ok: false; error: string };

const REQUEST_TIMEOUT_MS = 30_000;

export class AgentApi {
  constructor(private readonly options: { baseUrl: string; token: string; version: string }) {}

  async heartbeat(payload: HeartbeatPayload): Promise<void> {
    await this.send("POST", "/api/agent/backups/heartbeat", payload);
  }

  async next(): Promise<BackupJob | null> {
    const response = await this.send("GET", "/api/agent/backups/next");
    if (response.status === 204) return null;
    return (await response.json()) as BackupJob;
  }

  async createJob(): Promise<BackupJob> {
    const response = await this.send("POST", "/api/agent/backups/jobs", { trigger: "manual" });
    return (await response.json()) as BackupJob;
  }

  async progress(jobId: string, payload: ProgressPayload): Promise<void> {
    await this.send("POST", `/api/agent/backups/${encodeURIComponent(jobId)}/progress`, payload);
  }

  async complete(jobId: string, payload: CompletePayload): Promise<void> {
    await this.send("POST", `/api/agent/backups/${encodeURIComponent(jobId)}/complete`, payload);
  }

  private async send(method: string, route: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.options.baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "X-Qbox-Agent": `qbx_db_backup/${this.options.version}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) throw new Error("Agent token rejected by the QBox API");
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `QBox API ${method} ${route} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`,
      );
    }
    return response;
  }
}
