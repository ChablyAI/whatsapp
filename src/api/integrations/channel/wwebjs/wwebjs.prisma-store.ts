import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import fs from 'fs';

const CACHE_PREFIX = 'wwebjs:session:';

/**
 * Prisma-based store for whatsapp-web.js RemoteAuth strategy.
 * Implements the Store interface: sessionExists, save, extract, delete.
 * Session zip data is stored as base64 in the database Session.creds field.
 */
export class PrismaRemoteStore {
  private readonly logger = new Logger('PrismaRemoteStore');

  constructor(
    private readonly instanceId: string,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache?: CacheService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sessionExists(_options: { session: string }): Promise<boolean> {
    try {
      if (this.cache) {
        const cached = await this.cache.get(`${CACHE_PREFIX}${this.instanceId}`);
        if (cached) return true;
      }

      const session = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
        select: { id: true },
      });

      return !!session;
    } catch (error) {
      this.logger.error(`sessionExists failed for ${this.instanceId}: ${error}`);
      return false;
    }
  }

  async save(options: { session: string }): Promise<void> {
    try {
      const zipPath = `${options.session}.zip`;

      if (!fs.existsSync(zipPath)) {
        this.logger.warn(`Zip file not found at ${zipPath}, skipping save`);
        return;
      }

      const zipBuffer = fs.readFileSync(zipPath);
      const base64Data = zipBuffer.toString('base64');

      const existing = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
      });

      if (existing) {
        await this.prismaRepository.session.update({
          where: { sessionId: this.instanceId },
          data: { creds: base64Data },
        });
      } else {
        await this.prismaRepository.session.create({
          data: {
            sessionId: this.instanceId,
            creds: base64Data,
          },
        });
      }

      if (this.cache) {
        await this.cache.set(`${CACHE_PREFIX}${this.instanceId}`, base64Data);
      }

      this.logger.info(`Session saved to database for ${this.instanceId} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (error) {
      this.logger.error(`save failed for ${this.instanceId}: ${error}`);
    }
  }

  async extract(options: { session: string; path: string }): Promise<void> {
    try {
      let base64Data: string | null = null;

      if (this.cache) {
        const cached = await this.cache.get(`${CACHE_PREFIX}${this.instanceId}`);
        if (cached) base64Data = cached as string;
      }

      if (!base64Data) {
        const session = await this.prismaRepository.session.findFirst({
          where: { sessionId: this.instanceId },
        });

        if (!session?.creds) {
          this.logger.warn(`No session data found in database for ${this.instanceId}`);
          return;
        }

        base64Data = typeof session.creds === 'string' ? session.creds : JSON.stringify(session.creds);
      }

      const zipBuffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(options.path, zipBuffer);

      this.logger.info(
        `Session extracted from database for ${this.instanceId} (${(zipBuffer.length / 1024).toFixed(1)} KB)`,
      );
    } catch (error) {
      this.logger.error(`extract failed for ${this.instanceId}: ${error}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async delete(_options: { session: string }): Promise<void> {
    try {
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

      this.logger.info(`Session deleted from database for ${this.instanceId}`);
    } catch (error) {
      this.logger.error(`delete failed for ${this.instanceId}: ${error}`);
    }
  }
}
