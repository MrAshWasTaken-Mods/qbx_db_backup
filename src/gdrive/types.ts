export interface GDriveOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
}

export interface GDriveServiceAccountConfig {
  clientEmail: string;
  privateKey: string;
  folderId?: string;
}

export type GDriveAuthConfig = GDriveOAuthConfig | GDriveServiceAccountConfig;

export function isOAuthConfig(config: GDriveAuthConfig): config is GDriveOAuthConfig {
  return "refreshToken" in config && Boolean(config.refreshToken);
}

export interface GDriveTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface GDriveFile {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

export interface GDriveStorageQuota {
  limit?: number;
  usage?: number;
  usageInDrive?: number;
  usageInDriveTrash?: number;
}

export interface GDriveListResponse {
  files?: Array<{
    id: string;
    name: string;
    size?: string;
    mimeType?: string;
    createdTime?: string;
    modifiedTime?: string;
    md5Checksum?: string;
  }>;
  nextPageToken?: string;
}

export interface GDriveErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      message?: string;
      domain?: string;
      reason?: string;
      location?: string;
      locationType?: string;
    }>;
  };
}

export class GDriveError extends Error {
  public readonly code?: number;
  public readonly status?: string;
  public readonly reason?: string;

  constructor(message: string, code?: number, status?: string, reason?: string) {
    super(`[GDrive] ${message}`);
    this.name = "GDriveError";
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}
