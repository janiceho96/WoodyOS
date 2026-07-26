import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SUPPORTED_FILE_EXTENSIONS } from './types.js';

export interface PrivateFileStorage {
  provider: string;
  put(key: string, content: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  open(key: string): Promise<{ stream: NodeJS.ReadableStream; size: number }>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string) {
  const extensions = SUPPORTED_FILE_EXTENSIONS.join('|');
  if (!new RegExp(`^[a-f0-9-]+/[a-f0-9-]+\\.(${extensions})$`).test(key)) throw new Error('INVALID_FILE_STORAGE_KEY');
  return key;
}

export class LocalPrivateFileStorage implements PrivateFileStorage {
  readonly provider = 'local';
  readonly root: string;

  constructor(root = process.env.FILE_STORAGE_DIR ?? './data/files') {
    this.root = resolve(root);
  }

  private path(key: string) {
    const candidate = resolve(this.root, safeKey(key));
    if (!candidate.startsWith(`${this.root}${sep}`)) throw new Error('INVALID_FILE_STORAGE_PATH');
    return candidate;
  }

  async put(key: string, content: Buffer) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  }

  read(key: string) {
    return readFile(this.path(key));
  }

  async open(key: string) {
    const target = this.path(key);
    const details = await stat(target);
    if (!details.isFile()) throw new Error('FILE_STORAGE_OBJECT_INVALID');
    return { stream: createReadStream(target), size: details.size };
  }

  async delete(key: string) {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

let storage: PrivateFileStorage | undefined;
export function privateFileStorage() {
  storage ??= new LocalPrivateFileStorage();
  return storage;
}

export function setPrivateFileStorageForTests(value: PrivateFileStorage | undefined) {
  storage = value;
}
