import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import fs from 'fs';
import path from 'path';

const CACHE_PREFIX = 'wwebjs:session:';
const WWEBJS_DATA_MARKER = 'WWEBJS_ZIP:';

/**
 * Prisma-based store for whatsapp-web.js RemoteAuth strategy.
 *
 * RemoteAuth calls these methods with specific path semantics:
 *   save({ session })          — session is the FULL path without .zip
 *   extract({ session, path }) — path is the FULL path WITH .zip where we must write the zip
 *   sessionExists({ session }) — session is the name (e.g. "RemoteAuth-xxx")
 *   delete({ session })        — session is the name
 *
 * Data stored in DB is prefixed with WWEBJS_ZIP: to distinguish from Baileys JSON data.
 * Legacy data (without prefix) is also supported if it's valid base64 zip.
 */
export class PrismaRemoteStore {
  private readonly logger = new Logger('PrismaRemoteStore');

  constructor(
    private readonly instanceId: string,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache?: CacheService,
  ) {}

  private isWWebJSData(data: string): boolean {
    return data.startsWith(WWEBJS_DATA_MARKER);
  }

  /**
   * Check if raw base64 data is a valid zip (PK header = 0x50 0x4B → base64 starts with "UEs")
   */
  private isLegacyZipData(data: string): boolean {
    return data.startsWith('UEs') || data.startsWith('UEsD');
  }

  private packData(base64Zip: string): string {
    return `${WWEBJS_DATA_MARKER}${base64Zip}`;
  }

  private unpackData(data: string): string | null {
    if (this.isWWebJSData(data)) {
      return data.substring(WWEBJS_DATA_MARKER.length);
    }
    if (this.isLegacyZipData(data)) {
      return data;
    }
    return null;
  }

  private isValidZipBuffer(buf: Buffer): boolean {
    return buf.length >= 22 && buf[0] === 0x50 && buf[1] === 0x4b;
  }

  async sessionExists(options: { session: string }): Promise<boolean> {
    try {
      const sessionKey = options.session || `RemoteAuth-${this.instanceId}`;
      const session = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
        select: { id: true, creds: true },
      });

      if (!session?.creds) {
        this.logger.info(`[sessionExists] No session data in DB for ${sessionKey}`);
        return false;
      }

      const credsStr = typeof session.creds === 'string' ? session.creds : JSON.stringify(session.creds);

      if (this.isWWebJSData(credsStr)) {
        this.logger.info(`[sessionExists] Found prefixed wwebjs session in DB for ${sessionKey}`);
        return true;
      }

      if (this.isLegacyZipData(credsStr)) {
        this.logger.info(
          `[sessionExists] Found legacy (unprefixed) zip session in DB for ${sessionKey} (${(credsStr.length / 1024).toFixed(0)} KB)`,
        );
        return true;
      }

      if (this.cache) {
        const cached = await this.cache.get(`${CACHE_PREFIX}${this.instanceId}`);
        if (cached && typeof cached === 'string') {
          if (this.isWWebJSData(cached) || this.isLegacyZipData(cached)) {
            this.logger.warn(
              `[sessionExists] DB data is not wwebjs format, but cache has session for ${sessionKey}; using cache as fallback`,
            );
            return true;
          }
        }
      }

      this.logger.warn(
        `[sessionExists] Found non-wwebjs data in DB for ${this.instanceId} ` +
          `(starts with: "${credsStr.substring(0, 20)}..."), treating as non-existent`,
      );
      return false;
    } catch (error) {
      this.logger.error(`[sessionExists] Failed for ${options.session || this.instanceId}: ${error}`);
      return false;
    }
  }

  async save(options: { session: string }): Promise<void> {
    try {
      const zipPath = `${options.session}.zip`;

      this.logger.info(`[save] Looking for zip at: ${zipPath}`);

      if (!fs.existsSync(zipPath)) {
        this.logger.warn(`[save] Zip file not found at ${zipPath}, skipping save`);
        return;
      }

      const zipBuffer = fs.readFileSync(zipPath);

      if (!this.isValidZipBuffer(zipBuffer)) {
        this.logger.warn(
          `[save] Invalid zip file at ${zipPath} (${zipBuffer.length} bytes, header: ${zipBuffer.slice(0, 4).toString('hex')}), skipping`,
        );
        return;
      }

      const existing = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
        select: { creds: true },
      });

      if (existing?.creds) {
        const existingStr = typeof existing.creds === 'string' ? existing.creds : '';
        const existingRaw = this.unpackData(existingStr);
        if (existingRaw) {
          const existingSize = Buffer.from(existingRaw, 'base64').length;
          const MIN_SIZE_FOR_PROTECTION = 100 * 1024;
          const SIZE_REGRESSION_RATIO = 0.5;

          if (existingSize > MIN_SIZE_FOR_PROTECTION && zipBuffer.length < existingSize * SIZE_REGRESSION_RATIO) {
            this.logger.warn(
              `[save] New zip (${(zipBuffer.length / 1024).toFixed(1)} KB) is less than 50% of existing ` +
                `(${(existingSize / 1024).toFixed(1)} KB) — skipping save to protect valid session data`,
            );
            return;
          }
        }
      }

      const base64Data = zipBuffer.toString('base64');
      const packedData = this.packData(base64Data);

      if (existing) {
        await this.prismaRepository.session.update({
          where: { sessionId: this.instanceId },
          data: { creds: packedData },
        });
      } else {
        await this.prismaRepository.session.create({
          data: {
            sessionId: this.instanceId,
            creds: packedData,
          },
        });
      }

      if (this.cache) {
        await this.cache.set(`${CACHE_PREFIX}${this.instanceId}`, packedData);
      }

      this.logger.info(
        `[save] Session saved to DB for ${this.instanceId} (${(zipBuffer.length / 1024).toFixed(1)} KB)`,
      );
    } catch (error) {
      this.logger.error(`[save] Failed for ${this.instanceId}: ${error}`);
    }
  }

  async extract(options: { session: string; path: string }): Promise<void> {
    try {
      let rawData: string | null = null;
      const session = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
      });

      if (session?.creds) {
        rawData = typeof session.creds === 'string' ? session.creds : JSON.stringify(session.creds);
        this.logger.info(
          `[extract] Session data loaded from DB for ${this.instanceId} (${(rawData.length / 1024).toFixed(0)} KB)`,
        );
      } else if (this.cache) {
        const cached = await this.cache.get(`${CACHE_PREFIX}${this.instanceId}`);
        if (cached && typeof cached === 'string') {
          rawData = cached;
          this.logger.warn(`[extract] DB session missing, loaded fallback data from cache for ${this.instanceId}`);
        }
      }

      if (!rawData) {
        this.logger.warn(`[extract] No session data in DB/cache for ${this.instanceId}`);
        return;
      }

      const base64Data = this.unpackData(rawData);
      if (!base64Data) {
        this.logger.error(
          `[extract] Data is not valid wwebjs format for ${this.instanceId} (starts with: "${rawData.substring(0, 20)}...")`,
        );
        return;
      }

      const zipBuffer = Buffer.from(base64Data, 'base64');

      if (!this.isValidZipBuffer(zipBuffer)) {
        this.logger.error(
          `[extract] Decoded data is not a valid zip for ${this.instanceId} ` +
            `(${zipBuffer.length} bytes, header: ${zipBuffer.slice(0, 4).toString('hex')})`,
        );
        return;
      }

      const targetPath = options.path;
      const targetDir = path.dirname(targetPath);
      if (targetDir && !fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.writeFileSync(targetPath, zipBuffer);

      this.logger.info(
        `[extract] Session zip written to ${targetPath} for ${this.instanceId} (${(zipBuffer.length / 1024).toFixed(1)} KB)`,
      );
    } catch (error) {
      this.logger.error(`[extract] Failed for ${this.instanceId}: ${error}`);
    }
  }

  async delete(options: { session: string }): Promise<void> {
    try {
      const sessionKey = options.session || `RemoteAuth-${this.instanceId}`;
      const existing = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
      });

      if (existing) {
        await this.prismaRepository.session.delete({
          where: { sessionId: this.instanceId },
        });
      }

      if (this.cache) {
        await this.cache.delete(`${CACHE_PREFIX}${this.instanceId}`);
      }

      this.logger.info(`[delete] Session deleted from DB for ${sessionKey}`);
    } catch (error) {
      this.logger.error(`[delete] Failed for ${options.session || this.instanceId}: ${error}`);
    }
  }
}
