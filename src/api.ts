import type { DumpBinary } from "./dump";

export type BackupJob = {
  jobId: string;
  fileName: string;
  entryName: string;
  timeoutMs: number;
};

export type JobTrigger = "scheduled" | "manual";

export type HeartbeatPayload = {
  version: string;
  platform: string;
  dumpBinary: DumpBinary | null;
  database: string;
  intervalHours: number;
};

export type HeartbeatResult = {
  plan: string;
  poolBytes: number;
  usedBytes: number;
  nextAllowedAt: string | null;
};

export type CreateJobResult =
  | { status: "created"; job: BackupJob }
  | { status: "throttled"; nextAllowedAt: string | null }
  | { status: "busy"; jobId: string };

export type UploadTicket = {
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
};

export type UploadRequest = {
  sizeBytes: number;
  sha256: string;
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

export type CompleteResult = {
  status: "ready" | "failed";
  error?: string;
};

const REQUEST_TIMEOUT_MS = 30_000;
const POOL_EXCEEDED_FALLBACK = "Backup is larger than the storage pool for this plan";

export class AgentApi {
  constructor(private readonly options: { baseUrl: string; token: string; version: string }) {}

  async heartbeat(payload: HeartbeatPayload): Promise<HeartbeatResult> {
    const response = await this.send("POST", "/api/agent/backups/heartbeat", payload);
    return (await response.json()) as HeartbeatResult;
  }

  async createJob(trigger: JobTrigger): Promise<CreateJobResult> {
    const response = await this.send("POST", "/api/agent/backups/jobs", { trigger }, [409, 429]);
    if (response.status === 429) {
      const body = await readBody<{ nextAllowedAt?: string | null }>(response);
      return { status: "throttled", nextAllowedAt: body.nextAllowedAt ?? null };
    }
    if (response.status === 409) {
      const body = await readBody<{ jobId?: string }>(response);
      return { status: "busy", jobId: body.jobId ?? "unknown" };
    }
    return { status: "created", job: (await response.json()) as BackupJob };
  }

  async requestUpload(jobId: string, payload: UploadRequest): Promise<UploadTicket> {
    const response = await this.send(
      "POST",
      `/api/agent/backups/${encodeURIComponent(jobId)}/upload`,
      payload,
      [413],
    );
    if (response.status === 413) {
      const body = await readBody<{ error?: string }>(response);
      throw new Error(body.error ?? POOL_EXCEEDED_FALLBACK);
    }
    return (await response.json()) as UploadTicket;
  }

  async progress(jobId: string, payload: ProgressPayload): Promise<void> {
    await this.send("POST", `/api/agent/backups/${encodeURIComponent(jobId)}/progress`, payload);
  }

  async complete(jobId: string, payload: CompletePayload): Promise<CompleteResult> {
    const response = await this.send(
      "POST",
      `/api/agent/backups/${encodeURIComponent(jobId)}/complete`,
      payload,
    );
    return (await response.json()) as CompleteResult;
  }

  private async send(
    method: string,
    route: string,
    body?: unknown,
    expected: readonly number[] = [],
  ): Promise<Response> {
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
    if (response.status === 401) throw new Error("Agent token rejected by the Qbox API");
    if (!response.ok && !expected.includes(response.status)) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `Qbox API ${method} ${route} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`,
      );
    }
    return response;
  }
}

async function readBody<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}
