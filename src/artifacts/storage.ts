import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ArtifactStorage {
  provider: string;
  put(key: string, content: Buffer): Promise<void>;
  open(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number }>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string) {
  if (!/^[a-f0-9-]+\/[a-f0-9-]+\.(pdf|docx|pptx|xlsx)$/.test(key)) throw new Error('INVALID_ARTIFACT_STORAGE_KEY');
  return key;
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly provider = 'local';
  readonly root: string;

  constructor(root = process.env.ARTIFACT_STORAGE_DIR ?? './data/artifacts') {
    this.root = resolve(root);
  }

  private path(key: string) {
    const candidate = resolve(this.root, safeKey(key));
    if (!candidate.startsWith(`${this.root}${sep}`)) throw new Error('INVALID_ARTIFACT_STORAGE_PATH');
    return candidate;
  }

  async put(key: string, content: Buffer) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  }

  async open(key: string) {
    const target = this.path(key);
    const details = await stat(target);
    if (!details.isFile()) throw new Error('ARTIFACT_NOT_A_FILE');
    return { stream: createReadStream(target), size: details.size };
  }

  async delete(key: string) {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

let storage: ArtifactStorage | undefined;
export function artifactStorage() {
  storage ??= new LocalArtifactStorage();
  return storage;
}

export function setArtifactStorageForTests(value: ArtifactStorage | undefined) {
  storage = value;
}
