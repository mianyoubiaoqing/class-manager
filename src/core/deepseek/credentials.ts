import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../errors';
import { atomicWrite } from '../files';
import type { DeepSeekCredentialStatus } from './types';

export interface CryptoProvider {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) {
    return '***';
  }
  const prefix = trimmed.slice(0, 3);
  const suffix = trimmed.slice(-4);
  return `${prefix}...${suffix}`;
}

export class DeepSeekCredentialStore {
  private readonly credentialPath: string;
  private readonly metaPath: string;
  private readonly crypto: CryptoProvider;

  constructor(dataDirectory: string, cryptoProvider: CryptoProvider) {
    this.credentialPath = join(dataDirectory, 'credentials', 'deepseek.enc');
    this.metaPath = join(dataDirectory, 'credentials', 'deepseek.meta.json');
    this.crypto = cryptoProvider;
  }

  getStatus(): DeepSeekCredentialStatus {
    if (!existsSync(this.credentialPath) || !existsSync(this.metaPath)) {
      return { configured: false, maskedKey: null, updatedAt: null };
    }
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as {
        maskedKey?: string;
        updatedAt?: string;
      };
      return {
        configured: true,
        maskedKey: meta.maskedKey ?? null,
        updatedAt: meta.updatedAt ?? null,
      };
    } catch {
      return { configured: false, maskedKey: null, updatedAt: null };
    }
  }

  saveKey(apiKey: string): DeepSeekCredentialStatus {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new DomainError('VALIDATION', 'API Key 不能为空。');
    }
    if (trimmed.length < 5 || trimmed.length > 200) {
      throw new DomainError('VALIDATION', 'API Key 长度超出正常范围。');
    }
    if (!this.crypto.isAvailable()) {
      throw new DomainError(
        'ENCRYPTION_UNAVAILABLE',
        '系统安全存储不可用，无法安全保存密钥，已拒绝明文保存。',
      );
    }

    const encrypted = this.crypto.encrypt(trimmed);
    const masked = maskApiKey(trimmed);
    const updatedAt = new Date().toISOString();

    const dir = dirname(this.credentialPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    atomicWrite(this.credentialPath, encrypted);
    atomicWrite(this.metaPath, JSON.stringify({ maskedKey: masked, updatedAt }, null, 2));

    return { configured: true, maskedKey: masked, updatedAt };
  }

  loadKey(): string {
    if (!existsSync(this.credentialPath)) {
      throw new DomainError('CREDENTIAL_MISSING', '未配置 DeepSeek API Key，请先在设置中填写。');
    }
    if (!this.crypto.isAvailable()) {
      throw new DomainError('ENCRYPTION_UNAVAILABLE', '系统安全存储不可用，无法解密已保存的密钥。');
    }
    try {
      const buffer = readFileSync(this.credentialPath);
      return this.crypto.decrypt(buffer);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'DECRYPTION_FAILED',
        '无法解密 DeepSeek 密钥，可能由于系统凭据环境已更改。',
      );
    }
  }

  deleteKey(): void {
    if (existsSync(this.credentialPath)) {
      rmSync(this.credentialPath, { force: true });
    }
    if (existsSync(this.metaPath)) {
      rmSync(this.metaPath, { force: true });
    }
  }
}
