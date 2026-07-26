import type { FileScope } from '../types.js';

export type CloudImportRequest = {
  url: string;
  filename?: string;
  scope: FileScope;
};

export type DownloadedCloudFile = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  provider: 'secure_link';
};

export interface CloudImportAdapter {
  provider: DownloadedCloudFile['provider'];
  download(input: CloudImportRequest): Promise<DownloadedCloudFile>;
}
