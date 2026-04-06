import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';

interface SessionData {
  [key: string]: string;
}

export class PrismaAuthStrategy {
  private readonly logger = new Logger('PrismaAuthStrategy');

  constructor(
    private readonly instanceId: string,
    private readonly prismaRepository: PrismaRepository,
    private readonly cache?: CacheService,
  ) {}

  public async saveSession(sessionData: SessionData): Promise<void> {
    try {
      const existing = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
      });

      const serialized = JSON.stringify(sessionData);

      if (existing) {
        await this.prismaRepository.session.update({
          where: { sessionId: this.instanceId },
          data: { creds: serialized },
        });
      } else {
        await this.prismaRepository.session.create({
          data: {
            sessionId: this.instanceId,
            creds: serialized,
          },
        });
      }

      if (this.cache) {
        await this.cache.set(`wwebjs:session:${this.instanceId}`, serialized);
      }
    } catch (error) {
      this.logger.error(`Failed to save session for ${this.instanceId}: ${error}`);
    }
  }

  public async loadSession(): Promise<SessionData | null> {
    try {
      if (this.cache) {
        const cached = await this.cache.get(`wwebjs:session:${this.instanceId}`);
        if (cached) {
          return JSON.parse(cached as string);
        }
      }

      const session = await this.prismaRepository.session.findFirst({
        where: { sessionId: this.instanceId },
      });

      if (session?.creds) {
        const data = typeof session.creds === 'string' ? JSON.parse(session.creds) : session.creds;
        return data as SessionData;
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to load session for ${this.instanceId}: ${error}`);
      return null;
    }
  }

  public async removeSession(): Promise<void> {
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
        await this.cache.delete(`wwebjs:session:${this.instanceId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to remove session for ${this.instanceId}: ${error}`);
    }
  }
}
