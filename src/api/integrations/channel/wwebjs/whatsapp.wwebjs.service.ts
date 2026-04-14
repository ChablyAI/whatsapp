import { getCollectionsDto } from '@api/dto/business.dto';
import { OfferCallDto } from '@api/dto/call.dto';
import {
  ArchiveChatDto,
  BlockUserDto,
  DeleteMessage,
  getBase64FromMediaMessageDto,
  MarkChatUnreadDto,
  NumberBusiness,
  PrivacySettingDto,
  ReadMessageDto,
  SendPresenceDto,
  UpdateMessageDto,
  WhatsAppNumberDto,
} from '@api/dto/chat.dto';
import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  GroupDescriptionDto,
  GroupInvite,
  GroupJid,
  GroupPictureDto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdateSettingDto,
} from '@api/dto/group.dto';
import { SetPresenceDto } from '@api/dto/instance.dto';
import { HandleLabelDto, LabelDto } from '@api/dto/label.dto';
import {
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTextDto,
} from '@api/dto/sendMessage.dto';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository, Query } from '@api/repository/repository.service';
import { chatbotController } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { Events, TypeMediaMessage, wa } from '@api/types/wa.types';
import { Chatwoot, ConfigService, Database, QrCode, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, InternalServerErrorException } from '@exceptions';
import { Message } from '@prisma/client';
import { createJid } from '@utils/createJid';
import { sendTelemetry } from '@utils/sendTelemetry';
import { delay, isJidGroup } from 'baileys';
import EventEmitter2 from 'eventemitter2';
import * as fs from 'fs';
import mimeTypes from 'mime-types';
import * as path from 'path';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';
import { v4 } from 'uuid';

import { PrismaRemoteStore } from './wwebjs.prisma-store';

let wwebjsModule: any;

async function loadWWebJS() {
  if (!wwebjsModule) {
    const mod: any = await import('whatsapp-web.js');
    wwebjsModule = mod.default || mod;
  }
  return wwebjsModule;
}

export class WWebJSStartupService extends ChannelStartupService {
  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
    public readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
    this.instance.qrcode = { count: 0 };
  }

  public readonly logger = new Logger('WWebJSStartupService');
  private wwebClient: any = null;
  private remoteStore: PrismaRemoteStore;
  private dbBackupIntervalTimer: NodeJS.Timeout | null = null;
  private readonly dbBackupIntervalMs = 5 * 60 * 1000;
  private readonly initialDbBackupDelayMs = 30 * 1000;
  /** false = LocalAuth (disk-only under `.wwebjs_auth/`); true = RemoteAuth + PrismaRemoteStore */
  private readonly useRemoteAuth = false;
  private lastRestoreSource: 'local' | 'db' | 'none' = 'none';
  private endSession = false;

  public stateConnection: wa.StateConnection = { state: 'close' };
  public phoneNumber: string;

  public get connectionStatus() {
    return this.stateConnection;
  }

  public get profilePictureUrl() {
    return this.instance.profilePictureUrl;
  }

  public get qrCode(): wa.QrCode {
    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  // =====================================================
  // PHASE 1: Connection, QR, Session Management
  // =====================================================

  public async connectToWhatsapp(number?: string): Promise<any> {
    this.logger.info(`[connectToWhatsapp] === Connecting instance: ${this.instanceName} (id: ${this.instanceId}) ===`);
    try {
      this.loadChatwoot();
      this.loadSettings();
      this.loadWebhook();
      this.loadProxy();

      this.stateConnection = {
        instance: this.instance.name,
        state: 'connecting',
        statusReason: 200,
      };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: 'connecting' },
      });

      this.logger.info(`[connectToWhatsapp] Status set to "connecting", calling createClient...`);
      return await this.createClient(number);
    } catch (error) {
      this.logger.error(`[connectToWhatsapp] Failed: ${error}`);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async reloadConnection(): Promise<any> {
    this.logger.info(`[reloadConnection] Reloading connection for instance: ${this.instanceName}`);
    try {
      await this.destroyClient();
      return await this.createClient(this.phoneNumber);
    } catch (error) {
      this.logger.error(`[reloadConnection] Failed: ${error}`);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async logoutInstance() {
    this.logger.info(`[logout] Starting logout for instance: ${this.instanceName}`);
    try {
      if (this.wwebClient) {
        this.logger.info(`[logout] Calling wwebClient.logout()...`);
        await this.wwebClient.logout();
        this.logger.info(`[logout] Calling wwebClient.destroy()...`);
        await this.wwebClient.destroy();
      }
    } catch (error) {
      this.logger.error(`[logout] Error during logout: ${error}`);
    }

    this.wwebClient = null;

    const fsModule = await import('fs');
    const localDir = this.getLocalAuthDir();
    if (fsModule.existsSync(localDir)) {
      this.logger.info(`[logout] Removing local session dir: ${localDir}`);
      fsModule.rmSync(localDir, { recursive: true, force: true });
    }

    this.stopPeriodicDbBackup('logout');

    if (this.remoteStore) {
      this.logger.info(`[logout] Removing session from DB...`);
      await this.remoteStore.delete({ session: this.getRemoteSessionKey() });
    }
    this.logger.info(`[logout] Logout completed for instance: ${this.instanceName}`);
  }

  public async saveSessionNow(): Promise<void> {
    this.logger.info(`[saveSessionNow] Starting for instance: ${this.instanceName}`);

    // Close browser FIRST to flush IndexedDB/LocalStorage data to disk
    // Chrome keeps data in memory (WAL); destroying the client forces a complete flush
    if (this.wwebClient) {
      try {
        this.logger.info(`[saveSessionNow] Closing browser to flush IndexedDB data to disk...`);
        await this.wwebClient.destroy();
        this.logger.info(`[saveSessionNow] Browser closed — all data flushed to disk`);
      } catch (error) {
        this.logger.error(`[saveSessionNow] Error closing browser: ${error}`);
      }
      this.wwebClient = null;
    }

    if (this.useRemoteAuth) {
      this.logger.info('[saveSessionNow] RemoteAuth mode enabled — skipping manual backup (managed by strategy)');
      return;
    }

    // Small delay to ensure filesystem catches up
    await new Promise((r) => setTimeout(r, 500));

    const fsModule = await import('fs');
    const localDir = this.getLocalAuthDir();

    if (!fsModule.existsSync(localDir)) {
      this.logger.warn(`[saveSessionNow] Local session dir not found after browser close: ${localDir}`);
      return;
    }

    try {
      const entries = fsModule.readdirSync(localDir);
      this.logger.info(
        `[saveSessionNow] Session dir ready (${entries.length} entries): ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? '...' : ''}`,
      );
    } catch (e) {
      this.logger.warn(`[saveSessionNow] Could not read local dir: ${e}`);
    }

    try {
      await this.backupSessionToDB();
      this.logger.info(`[saveSessionNow] DB backup completed for instance: ${this.instanceName}`);
    } catch (error) {
      this.logger.error(`[saveSessionNow] DB backup failed: ${error}`);
    }
  }

  private async destroyClient() {
    this.logger.info(`[destroyClient] Destroying client for instance: ${this.instanceName}`);
    this.stopPeriodicDbBackup('destroyClient');
    if (this.wwebClient) {
      try {
        await this.wwebClient.destroy();
        this.logger.info(`[destroyClient] Client destroyed successfully`);
      } catch (error) {
        this.logger.error(`[destroyClient] Error destroying client: ${error}`);
      }
      this.wwebClient = null;
    } else {
      this.logger.info(`[destroyClient] No wwebClient to destroy`);
    }
  }

  private getLocalAuthDir(): string {
    return path.resolve(`.wwebjs_auth/session-${this.instanceId}`);
  }

  private getRemoteSessionKey(): string {
    return `RemoteAuth-${this.instanceId}`;
  }

  private sanitizeRestoredLocalProfile(localDir: string): void {
    const transientPaths = [
      'DevToolsActivePort',
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      'BrowserMetrics-spare.pma',
      path.join('Default', 'SingletonLock'),
      path.join('Default', 'SingletonCookie'),
      path.join('Default', 'SingletonSocket'),
      path.join('Default', 'Preferences.bad'),
      path.join('Default', 'chrome_debug.log'),
    ];

    let removed = 0;
    for (const relPath of transientPaths) {
      const absPath = path.join(localDir, relPath);
      try {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // non-fatal
      }
    }

    if (removed > 0) {
      this.logger.info(`[restoreSessionFromDB] Sanitized restored profile: removed ${removed} transient files`);
    }
  }

  private validateLocalSessionProfile(localDir: string): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const requiredPaths = [path.join(localDir, 'Default'), path.join(localDir, 'Local State')];
    for (const p of requiredPaths) {
      if (!fs.existsSync(p)) {
        reasons.push(`missing: ${p}`);
      }
    }

    const waIndexedDbPath = path.join(localDir, 'Default', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');
    const waLocalStoragePath = path.join(localDir, 'Default', 'Local Storage', 'leveldb');
    const hasAuthStorage = fs.existsSync(waIndexedDbPath) || fs.existsSync(waLocalStoragePath);
    if (!hasAuthStorage) {
      reasons.push('missing WhatsApp auth storage (IndexedDB/Local Storage leveldb)');
    }

    // Stronger integrity signal: at least one LevelDB data file should exist.
    const hasLevelDbFiles = (dir: string): boolean => {
      try {
        if (!fs.existsSync(dir)) return false;
        const entries = fs.readdirSync(dir);
        return entries.some((name) => name.endsWith('.ldb') || name.endsWith('.log') || name.startsWith('MANIFEST-'));
      } catch {
        return false;
      }
    };

    const hasIndexedDbFiles = hasLevelDbFiles(waIndexedDbPath);
    const hasLocalStorageFiles = hasLevelDbFiles(waLocalStoragePath);
    if (!hasIndexedDbFiles && !hasLocalStorageFiles) {
      reasons.push('missing LevelDB files in WhatsApp storage (no .ldb/.log/MANIFEST)');
    }

    return { ok: reasons.length === 0, reasons };
  }

  private stopPeriodicDbBackup(reason: string): void {
    if (this.dbBackupIntervalTimer) {
      clearInterval(this.dbBackupIntervalTimer);
      this.dbBackupIntervalTimer = null;
      this.logger.info(`[db-backup] Periodic backup stopped: ${reason}`);
    }
  }

  private startPeriodicDbBackup(): void {
    this.stopPeriodicDbBackup('restart');
    this.logger.info(`[db-backup] Starting periodic backup every ${this.dbBackupIntervalMs / 1000}s`);
    this.dbBackupIntervalTimer = setInterval(() => {
      this.backupSessionToDB()
        .then(() => this.logger.info('[db-backup] Periodic backup completed'))
        .catch((err) => this.logger.error(`[db-backup] Periodic backup failed: ${err}`));
    }, this.dbBackupIntervalMs);
  }

  private async restoreSessionFromDB(): Promise<boolean> {
    const fsModule = await import('fs');
    const localDir = this.getLocalAuthDir();
    const startedAt = Date.now();
    this.lastRestoreSource = 'none';

    this.logger.info(`[restoreSessionFromDB] Checking local dir: ${localDir}`);

    if (fsModule.existsSync(localDir)) {
      this.lastRestoreSource = 'local';
      try {
        const entries = fsModule.readdirSync(localDir);
        this.logger.info(
          `[restoreSessionFromDB] Local session dir EXISTS (${entries.length} entries: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? '...' : ''}) — skipping DB restore`,
        );
        const validation = this.validateLocalSessionProfile(localDir);
        if (!validation.ok) {
          this.logger.warn(
            `[restoreSessionFromDB] Existing local profile failed validation: ${validation.reasons.join(' | ')}`,
          );
        } else {
          this.logger.info('[restoreSessionFromDB] Existing local profile validation: OK');
        }
      } catch {
        this.logger.info(`[restoreSessionFromDB] Local session dir EXISTS — skipping DB restore`);
      }
      this.logger.info(`[restoreSessionFromDB] Completed in ${Date.now() - startedAt} ms`);
      return true;
    }

    this.logger.info(`[restoreSessionFromDB] Local dir NOT found — checking DB for backup...`);

    this.remoteStore = new PrismaRemoteStore(this.instanceId, this.prismaRepository, this.cache);
    const hasDbSession = await this.remoteStore.sessionExists({ session: this.getRemoteSessionKey() });

    if (!hasDbSession) {
      this.logger.info(`[restoreSessionFromDB] No session in DB either — QR code will be required`);
      return false;
    }

    this.logger.info(`[restoreSessionFromDB] Session FOUND in DB — starting restore...`);

    try {
      const pathModule = await import('path');
      const dataPath = pathModule.default.resolve('./.wwebjs_auth');
      const zipPath = pathModule.default.join(dataPath, `session-${this.instanceId}.zip`);

      this.logger.info(`[restoreSessionFromDB] Extracting session zip to: ${zipPath}`);
      await this.remoteStore.extract({ session: this.getRemoteSessionKey(), path: zipPath });

      if (!fsModule.existsSync(zipPath)) {
        this.logger.warn(`[restoreSessionFromDB] Zip extraction failed — no file at ${zipPath}`);
        return false;
      }

      const zipStats = fsModule.statSync(zipPath);
      this.logger.info(`[restoreSessionFromDB] Zip file size: ${(zipStats.size / 1024).toFixed(1)} KB`);

      const unzipper = await import('unzipper');
      fsModule.mkdirSync(localDir, { recursive: true });

      this.logger.info(`[restoreSessionFromDB] Unzipping to: ${localDir}`);
      await new Promise<void>((resolve, reject) => {
        fsModule
          .createReadStream(zipPath)
          .pipe(unzipper.default.Extract({ path: localDir }))
          .on('close', resolve)
          .on('error', reject);
      });

      fsModule.unlinkSync(zipPath);

      this.sanitizeRestoredLocalProfile(localDir);
      this.lastRestoreSource = 'db';
      const restoredEntries = fsModule.readdirSync(localDir);
      this.logger.info(
        `[restoreSessionFromDB] Session restored successfully to ${localDir} (${restoredEntries.length} entries: ${restoredEntries.slice(0, 8).join(', ')}${restoredEntries.length > 8 ? '...' : ''})`,
      );

      const validation = this.validateLocalSessionProfile(localDir);
      if (!validation.ok) {
        this.logger.warn(
          `[restoreSessionFromDB] Restored profile failed validation: ${validation.reasons.join(' | ')} — removing and forcing QR`,
        );
        fsModule.rmSync(localDir, { recursive: true, force: true });
        this.lastRestoreSource = 'none';
        this.logger.info(`[restoreSessionFromDB] Completed in ${Date.now() - startedAt} ms (invalid restore)`);
        return false;
      }

      this.logger.info('[restoreSessionFromDB] Restored profile validation: OK');
      this.logger.info(`[restoreSessionFromDB] Completed in ${Date.now() - startedAt} ms`);
      return true;
    } catch (error) {
      this.logger.error(`[restoreSessionFromDB] Failed: ${error}`);
      this.logger.info(`[restoreSessionFromDB] Completed in ${Date.now() - startedAt} ms (error)`);
      return false;
    }
  }

  public async backupSessionToDB(): Promise<void> {
    const fsModule = await import('fs');
    const pathModule = await import('path');
    const archiver = await import('archiver');

    const localDir = this.getLocalAuthDir();
    this.logger.info(`[backupSessionToDB] Starting backup for ${this.instanceName}, localDir: ${localDir}`);

    if (!fsModule.existsSync(localDir)) {
      this.logger.warn(`[backupSessionToDB] Local session dir not found: ${localDir} — nothing to backup`);
      return;
    }

    let sourceEntryCount = 0;
    try {
      const entries = fsModule.readdirSync(localDir);
      sourceEntryCount = entries.length;
      this.logger.info(
        `[backupSessionToDB] Local dir has ${entries.length} entries: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? '...' : ''}`,
      );
    } catch (e) {
      this.logger.warn(`[backupSessionToDB] Could not list local dir: ${e}`);
    }

    const dataPath = pathModule.default.resolve('./.wwebjs_auth');
    const zipPath = pathModule.default.join(dataPath, `session-${this.instanceId}.zip`);

    try {
      this.logger.info(`[backupSessionToDB] Creating zip at: ${zipPath}`);
      let archivedFileCount = 0;
      const archiveWarnings: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const archive = archiver.default('zip', { zlib: { level: 5 } });
        const stream = fsModule.createWriteStream(zipPath);
        stream.on('close', () => resolve());
        archive.on('error', reject);
        archive.on('warning', (warn: any) => {
          archiveWarnings.push(String(warn?.message || warn));
        });
        archive.on('entry', () => {
          archivedFileCount++;
        });
        archive.pipe(stream);
        archive.directory(localDir, false);
        archive.finalize();
      });

      const zipStats = fsModule.statSync(zipPath);
      this.logger.info(
        `[backupSessionToDB] Zip created: ${(zipStats.size / 1024).toFixed(1)} KB, ${archivedFileCount} files archived`,
      );

      if (archiveWarnings.length > 0) {
        this.logger.warn(
          `[backupSessionToDB] Archiver warnings (${archiveWarnings.length}): ${archiveWarnings.slice(0, 5).join('; ')}`,
        );
      }

      if (sourceEntryCount > 0 && archivedFileCount < sourceEntryCount) {
        this.logger.warn(
          `[backupSessionToDB] Archived ${archivedFileCount} files but source has ${sourceEntryCount} top-level entries — ` +
            `some files may have been skipped (this is normal for locked Chrome files while browser is running)`,
        );
      }

      if (!this.remoteStore) {
        this.remoteStore = new PrismaRemoteStore(this.instanceId, this.prismaRepository, this.cache);
      }

      this.logger.info(`[backupSessionToDB] Saving zip to DB...`);
      await this.remoteStore.save({ session: pathModule.default.join(dataPath, `session-${this.instanceId}`) });
      this.logger.info(
        `[remote_session_saved] Session persisted to DB: key=${this.getRemoteSessionKey()}, size=${(zipStats.size / 1024).toFixed(1)} KB`,
      );

      fsModule.unlinkSync(zipPath);
      this.logger.info(`[backupSessionToDB] Backup completed successfully for ${this.instanceName}`);
    } catch (error) {
      this.logger.error(`[backupSessionToDB] Failed: ${error}`);
      try {
        if (fsModule.existsSync(zipPath)) fsModule.unlinkSync(zipPath);
      } catch {
        /* ignore */
      }
    }
  }

  private async createClient(number?: string, isRetry = false): Promise<any> {
    this.logger.info(`[createClient] === START === instance: ${this.instanceName}, isRetry: ${isRetry}`);

    if (!this.useRemoteAuth) {
      if (!isRetry) {
        const restored = await this.restoreSessionFromDB();
        this.logger.info(
          `[createClient] restoreSessionFromDB finished. restored=${restored}, source=${this.lastRestoreSource}`,
        );
      } else {
        this.logger.warn('[createClient] Retry mode: skipping DB restore, forcing clean LocalAuth startup');
      }
    } else {
      this.logger.info('[createClient] RemoteAuth mode enabled — restore handled by strategy');
    }

    const fsModule = await import('fs');
    const localDir = this.getLocalAuthDir();
    const hasLocalSession = fsModule.existsSync(localDir);

    if (!this.useRemoteAuth && hasLocalSession) {
      try {
        const entries = fsModule.readdirSync(localDir);
        this.logger.info(
          `[createClient] LOCAL SESSION FOUND at ${localDir} (${entries.length} entries: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? '...' : ''}) — will auto-connect`,
        );
        const validation = this.validateLocalSessionProfile(localDir);
        this.logger.info(
          `[createClient] Local profile integrity check: ${validation.ok ? 'OK' : `FAILED (${validation.reasons.join(' | ')})`}`,
        );
      } catch {
        this.logger.info(`[createClient] LOCAL SESSION FOUND at ${localDir} — will auto-connect`);
      }
    } else if (!this.useRemoteAuth) {
      this.logger.info(`[createClient] NO SESSION at ${localDir} — QR code will be required`);
    }

    if (number || this.phoneNumber) {
      this.phoneNumber = number || this.phoneNumber;
    }

    const puppeteerOptions: any = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    };

    if (this.localProxy?.enabled) {
      puppeteerOptions.args.push(
        `--proxy-server=${this.localProxy.protocol}://${this.localProxy.host}:${this.localProxy.port}`,
      );
    }

    const wwebjs = await loadWWebJS();

    let authStrategy: any;
    if (this.useRemoteAuth) {
      this.remoteStore = new PrismaRemoteStore(this.instanceId, this.prismaRepository, this.cache);
      this.logger.info(
        `[createClient] Creating RemoteAuth strategy with clientId: ${this.instanceId}, backupSyncIntervalMs: ${this.dbBackupIntervalMs}`,
      );
      authStrategy = new wwebjs.RemoteAuth({
        clientId: this.instanceId,
        store: this.remoteStore,
        backupSyncIntervalMs: this.dbBackupIntervalMs,
        dataPath: './.wwebjs_auth',
      });
    } else {
      this.logger.info(
        `[createClient] Creating LocalAuth strategy with clientId: ${this.instanceId}, dataPath: ./.wwebjs_auth`,
      );
      authStrategy = new wwebjs.LocalAuth({
        clientId: this.instanceId,
        dataPath: './.wwebjs_auth',
      });
    }

    this.wwebClient = new wwebjs.Client({
      authStrategy,
      puppeteer: puppeteerOptions,
      qrMaxRetries: this.configService.get<QrCode>('QRCODE').LIMIT || 6,
    });

    this.setupEventHandlers();
    this.stopPeriodicDbBackup('before initialize');

    this.logger.info(
      `[createClient] Calling wwebClient.initialize() (${this.useRemoteAuth ? 'RemoteAuth' : 'LocalAuth'})...`,
    );

    try {
      await this.wwebClient.initialize();
      this.logger.info(`[createClient] wwebClient.initialize() completed successfully`);
    } catch (initError: any) {
      this.logger.error(`[createClient] wwebClient.initialize() threw error: ${initError?.message || initError}`);

      const isProtocolError =
        initError?.message?.includes('Execution context was destroyed') ||
        initError?.message?.includes('ProtocolError') ||
        initError?.message?.includes('Session closed') ||
        initError?.message?.includes('Target closed') ||
        initError?.message?.includes('Navigating frame was detached');

      if (isProtocolError && !isRetry) {
        this.logger.warn(`[createClient] ProtocolError detected — clearing stale session and retrying with QR code`);

        try {
          if (this.wwebClient) {
            await this.wwebClient.destroy().catch(() => {});
          }
        } catch {
          /* ignore */
        }
        this.wwebClient = null;

        if (fsModule.existsSync(localDir)) {
          this.logger.info(`[createClient] Removing stale local session dir: ${localDir}`);
          fsModule.rmSync(localDir, { recursive: true, force: true });
        }

        // If failure happened right after DB restore, invalidate DB snapshot to avoid restart loops.
        if ((this.useRemoteAuth || this.lastRestoreSource === 'db') && this.remoteStore) {
          this.logger.warn(`[createClient] Last restore source was DB; deleting potentially corrupted DB snapshot`);
          await this.remoteStore.delete({ session: this.getRemoteSessionKey() });
        }

        return this.createClient(number, true);
      }

      throw initError;
    }

    this.phoneNumber = number;

    this.logger.info(`[createClient] === DONE === instance: ${this.instanceName}`);
    return this.wwebClient;
  }

  private setupEventHandlers() {
    this.wwebClient.on('qr', async (qr: string) => {
      this.instance.qrcode.count++;
      this.logger.info(`QR code received (attempt ${this.instance.qrcode.count})`);

      if (this.instance.qrcode.count > (this.configService.get<QrCode>('QRCODE').LIMIT || 6)) {
        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          message: 'QR code limit reached, please login again',
          statusCode: 428,
        });

        this.sendDataWebhook(Events.CONNECTION_UPDATE, {
          instance: this.instance.name,
          state: 'refused',
          statusReason: 428,
        });

        this.endSession = true;
        this.eventEmitter.emit('no.connection', this.instance.name);
        return;
      }

      this.stateConnection = {
        instance: this.instance.name,
        state: 'connecting',
        statusReason: 200,
      };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: 'connecting' },
      });

      this.instance.qrcode.code = qr;

      const color = this.configService.get<QrCode>('QRCODE').COLOR;
      const optsQrcode: QRCodeToDataURLOptions = {
        margin: 3,
        scale: 4,
        errorCorrectionLevel: 'H',
        color: { light: '#ffffff', dark: color },
      };

      const qrBase64 = await qrcode.toDataURL(qr, optsQrcode);
      this.instance.qrcode.base64 = qrBase64;

      this.sendDataWebhook(Events.QRCODE_UPDATED, {
        qrcode: {
          instance: this.instance.name,
          pairingCode: this.instance.qrcode?.pairingCode,
          code: qr,
          base64: qrBase64,
        },
      });

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
        this.chatwootService.eventWhatsapp(
          Events.QRCODE_UPDATED,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          {
            qrcode: {
              instance: this.instance.name,
              pairingCode: this.instance.qrcode?.pairingCode,
              code: qr,
              base64: qrBase64,
            },
          },
        );
      }
    });

    this.wwebClient.on('authenticated', () => {
      this.logger.info(
        `[event:authenticated] ✓ Client authenticated for instance: ${this.instanceName} — session is valid, waiting for "ready" event...`,
      );
    });

    this.wwebClient.on('auth_failure', async (message: string) => {
      this.logger.error(`[event:auth_failure] ✗ Authentication FAILED for ${this.instanceName}: ${message}`);
      this.stateConnection = { state: 'close' };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: 'close' },
      });

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        state: 'close',
        statusReason: 401,
      });
    });

    this.wwebClient.on('ready', async () => {
      this.logger.info(
        `[event:ready] ✓ Client READY for instance: ${this.instanceName} — WhatsApp connected successfully!`,
      );
      this.endSession = false;

      const info = this.wwebClient.info;
      const rawWuid = info?.wid?._serialized || info?.wid?.user;
      this.instance.wuid = rawWuid ? this.normalizeJid(rawWuid) : rawWuid;
      this.instance.profileName = info?.pushname;

      this.stateConnection = {
        instance: this.instance.name,
        state: 'open',
        statusReason: 200,
      };

      try {
        const profilePicUrl = await this.wwebClient.getProfilePicUrl(info?.wid?._serialized);
        this.instance.profilePictureUrl = profilePicUrl;
      } catch {
        this.instance.profilePictureUrl = null;
      }

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: {
          ownerJid: this.instance.wuid,
          profileName: this.instance.profileName,
          profilePicUrl: this.instance.profilePictureUrl,
          connectionStatus: 'open',
        },
      });

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        state: 'open',
        statusReason: 200,
        wuid: this.instance.wuid,
        profileName: this.instance.profileName,
        profilePictureUrl: this.instance.profilePictureUrl,
      });

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
        this.chatwootService.eventWhatsapp(
          Events.CONNECTION_UPDATE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          {
            instance: this.instance.name,
            status: 'open',
          },
        );
      }

      if (this.localSettings.alwaysOnline) {
        await this.wwebClient.sendPresenceAvailable();
      }

      if (this.useRemoteAuth) {
        this.logger.info(
          `[event:ready] RemoteAuth mode enabled — session sync managed by strategy (interval ${this.dbBackupIntervalMs / 1000}s)`,
        );
      } else {
        this.logger.info(
          `[event:ready] Scheduling initial DB backup in ${this.initialDbBackupDelayMs / 1000}s (with IndexedDB flush)...`,
        );
        setTimeout(async () => {
          try {
            // Attempt to flush IndexedDB data to disk by closing/reopening databases
            if (this.wwebClient?.pupPage) {
              this.logger.info(`[event:ready] Flushing IndexedDB to disk before backup...`);
              try {
                await this.wwebClient.pupPage.evaluate(() => {
                  return new Promise<void>((resolve) => {
                    if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
                      resolve();
                      return;
                    }
                    indexedDB
                      .databases()
                      .then((dbs) => {
                        let remaining = dbs.length;
                        if (remaining === 0) {
                          resolve();
                          return;
                        }
                        dbs.forEach((dbInfo) => {
                          const req = indexedDB.open(dbInfo.name!, dbInfo.version!);
                          req.onsuccess = () => {
                            req.result.close();
                            if (--remaining <= 0) resolve();
                          };
                          req.onerror = () => {
                            if (--remaining <= 0) resolve();
                          };
                        });
                      })
                      .catch(() => resolve());
                  });
                });
                this.logger.info(`[event:ready] IndexedDB flush completed`);
              } catch (flushErr) {
                this.logger.warn(`[event:ready] IndexedDB flush failed (non-fatal): ${flushErr}`);
              }
              await new Promise((r) => setTimeout(r, 2000));
            }

            this.logger.info(`[event:ready] Starting scheduled DB backup (best-effort while browser running)...`);
            await this.backupSessionToDB();
          } catch (err) {
            this.logger.error(`[event:ready] Scheduled DB backup failed: ${err}`);
          }
        }, this.initialDbBackupDelayMs);
        this.startPeriodicDbBackup();
      }
    });

    this.wwebClient.on('disconnected', async (reason: string) => {
      this.logger.warn(`[event:disconnected] ✗ Client DISCONNECTED for ${this.instanceName}: ${reason}`);
      this.stopPeriodicDbBackup(`disconnected:${reason}`);
      this.stateConnection = { state: 'close' };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: 'close' },
      });

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        state: 'close',
        statusReason: 408,
      });

      if (reason === 'NAVIGATION' || reason === 'CONFLICT') {
        this.logger.info('Attempting reconnection...');
        setTimeout(() => this.connectToWhatsapp(this.phoneNumber), 5000);
      } else {
        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner');
      }
    });

    this.wwebClient.on('change_state', async (state: string) => {
      this.logger.info(`[event:change_state] State changed to "${state}" for ${this.instanceName}`);

      const stateMap: Record<string, string> = {
        CONNECTED: 'open',
        OPENING: 'connecting',
        PAIRING: 'connecting',
        TIMEOUT: 'close',
        CONFLICT: 'close',
        UNLAUNCHED: 'close',
        UNPAIRED: 'close',
        UNPAIRED_IDLE: 'close',
      };

      const mappedState = (stateMap[state] || 'connecting') as 'open' | 'connecting' | 'close';

      this.stateConnection = {
        instance: this.instance.name,
        state: mappedState,
        statusReason: mappedState === 'open' ? 200 : mappedState === 'close' ? 408 : 200,
      };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: mappedState },
      });

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        state: mappedState,
        statusReason: this.stateConnection.statusReason,
      });
    });

    this.wwebClient.on('remote_session_saved', () => {
      this.logger.info(
        `Remote session saved to database for instance: ${this.instanceName} — session will persist across restarts`,
      );
    });

    // =====================================================
    // MESSAGE RECEIVING HANDLERS
    // =====================================================

    this.wwebClient.on('message_create', async (msg: any) => {
      try {
        if (this.endSession) return;

        const isGroup = msg.from?.endsWith('@g.us') || msg.to?.endsWith('@g.us');
        if (this.localSettings.groupsIgnore && isGroup) return;

        this.logger.info(`Message ${msg.fromMe ? 'sent' : 'received'}: type=${msg.type}, id=${msg.id?._serialized}`);

        await this.handleIncomingMessage(msg);
      } catch (error) {
        this.logger.error(`Error handling message: ${error}`);
      }
    });

    this.wwebClient.on('message_ack', async (msg: any, ack: number) => {
      try {
        const ackStatus = this.mapAckToStatus(ack);
        const keyId = msg.id?._serialized || msg.id?.id;
        const normalizedJid = this.normalizeJid(msg.from || msg.to);

        if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
          const existingMsg = await this.prismaRepository.message.findFirst({
            where: {
              instanceId: this.instanceId,
              key: { path: ['id'], equals: keyId },
            },
          });

          if (existingMsg) {
            await this.prismaRepository.messageUpdate.create({
              data: {
                keyId,
                remoteJid: normalizedJid,
                fromMe: msg.fromMe ?? false,
                status: ackStatus,
                messageId: existingMsg.id,
                instanceId: this.instanceId,
              },
            });
          }
        }

        this.sendDataWebhook(Events.MESSAGES_UPDATE, {
          key: {
            remoteJid: normalizedJid,
            fromMe: msg.fromMe,
            id: keyId,
          },
          status: ackStatus,
          instanceId: this.instanceId,
        });
      } catch (error) {
        this.logger.error(`Error handling message ack: ${error}`);
      }
    });

    this.wwebClient.on('message_revoke_everyone', async (revokedMsg: any, oldMsg: any) => {
      try {
        const keyId = revokedMsg.id?._serialized || revokedMsg.id?.id;

        if (this.configService.get<Database>('DATABASE').DELETE_DATA?.LOGICAL_MESSAGE_DELETE) {
          await this.prismaRepository.message.updateMany({
            where: {
              instanceId: this.instanceId,
              key: { path: ['id'], equals: keyId },
            },
            data: { status: 'DELETED' },
          });
        }

        this.sendDataWebhook(Events.MESSAGES_DELETE, {
          key: {
            remoteJid: this.normalizeJid(revokedMsg.from || revokedMsg.to),
            fromMe: revokedMsg.fromMe,
            id: keyId,
          },
          message: oldMsg ? { conversation: oldMsg.body } : undefined,
          instanceId: this.instanceId,
        });
      } catch (error) {
        this.logger.error(`Error handling message revoke: ${error}`);
      }
    });

    this.wwebClient.on('message_edit', async (msg: any, newBody: string, prevBody: string) => {
      try {
        const keyId = msg.id?._serialized || msg.id?.id;

        const existingMsg = await this.prismaRepository.message.findFirst({
          where: {
            instanceId: this.instanceId,
            key: { path: ['id'], equals: keyId },
          },
        });

        if (existingMsg) {
          await this.prismaRepository.message.update({
            where: { id: existingMsg.id },
            data: {
              message: { conversation: newBody },
            },
          });

          const editJid = this.normalizeJid(msg.from || msg.to);
          await this.prismaRepository.messageUpdate.create({
            data: {
              keyId,
              remoteJid: editJid,
              fromMe: msg.fromMe ?? false,
              status: 'EDITED',
              messageId: existingMsg.id,
              instanceId: this.instanceId,
            },
          });
        }

        this.sendDataWebhook(Events.MESSAGES_EDITED, {
          key: {
            remoteJid: this.normalizeJid(msg.from || msg.to),
            fromMe: msg.fromMe,
            id: keyId,
          },
          message: { conversation: newBody },
          oldMessage: { conversation: prevBody },
          messageTimestamp: msg.timestamp,
          instanceId: this.instanceId,
        });
      } catch (error) {
        this.logger.error(`Error handling message edit: ${error}`);
      }
    });

    this.wwebClient.on('message_reaction', async (reaction: any) => {
      try {
        this.sendDataWebhook(Events.MESSAGES_UPDATE, {
          key: {
            remoteJid: this.normalizeJid(reaction.senderId),
            fromMe: false,
            id: reaction.msgId?._serialized || reaction.msgId?.id,
          },
          reaction: {
            text: reaction.reaction,
            senderId: this.normalizeJid(reaction.senderId),
            timestamp: reaction.timestamp,
          },
          instanceId: this.instanceId,
        });
      } catch (error) {
        this.logger.error(`Error handling message reaction: ${error}`);
      }
    });
  }

  // =====================================================
  // MESSAGE PROCESSING - incoming message pipeline
  // =====================================================

  private mapWWebJSTypeToMessageType(type: string, msg: any): string {
    const typeMap: Record<string, string> = {
      chat: 'conversation',
      image: 'imageMessage',
      video: 'videoMessage',
      audio: 'audioMessage',
      ptt: 'audioMessage',
      document: 'documentMessage',
      sticker: 'stickerMessage',
      location: 'locationMessage',
      vcard: 'contactMessage',
      multi_vcard: 'contactsArrayMessage',
      poll_creation: 'pollCreationMessage',
      revoked: 'protocolMessage',
      reaction: 'reactionMessage',
    };

    if (type === 'ptt' && msg) return 'audioMessage';
    return typeMap[type] || type || 'unknown';
  }

  private mapAckToStatus(ack: number): wa.StatusMessage {
    const ackMap: Record<number, wa.StatusMessage> = {
      [-1]: 'ERROR',
      0: 'PENDING',
      1: 'SERVER_ACK',
      2: 'DELIVERY_ACK',
      3: 'READ',
      4: 'PLAYED',
    };
    return ackMap[ack] || 'PENDING';
  }

  private buildMessageContent(msg: any): Record<string, any> {
    const type = msg.type;

    switch (type) {
      case 'chat':
        return { conversation: msg.body || '' };

      case 'image':
      case 'video':
      case 'document':
      case 'audio':
      case 'ptt': {
        const mediaKey = type === 'ptt' ? 'audioMessage' : `${type}Message`;
        return {
          [mediaKey]: {
            caption: msg.body || undefined,
            mimetype: msg._data?.mimetype || undefined,
            fileName: msg._data?.filename || undefined,
            ptt: type === 'ptt' ? true : undefined,
            seconds: msg.duration ? parseInt(msg.duration) : undefined,
          },
        };
      }

      case 'sticker':
        return {
          stickerMessage: {
            mimetype: msg._data?.mimetype || 'image/webp',
            isAnimated: msg.isGif || false,
          },
        };

      case 'location':
        return {
          locationMessage: {
            degreesLatitude: msg.location?.latitude,
            degreesLongitude: msg.location?.longitude,
            name: msg.location?.description || msg.body || undefined,
          },
        };

      case 'vcard':
        return {
          contactMessage: {
            vcard: msg.vCards?.[0] || msg.body || '',
          },
        };

      case 'multi_vcard':
        return {
          contactsArrayMessage: {
            contacts: (msg.vCards || []).map((vcard: string) => ({
              vcard,
            })),
          },
        };

      case 'poll_creation':
        return {
          pollCreationMessage: {
            name: msg.pollName || msg.body || '',
            options: (msg.pollOptions || []).map((opt: any) => ({
              optionName: typeof opt === 'string' ? opt : opt.name,
            })),
          },
        };

      default:
        return { conversation: msg.body || '' };
    }
  }

  private normalizeJid(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@lid')) {
      return jid;
    }
    return jid.replace(/@c\.us$/, '@s.whatsapp.net').replace(/^(\d+)$/, '$1@s.whatsapp.net');
  }

  /** whatsapp-web.js private chats use `@c.us`; Baileys-style JIDs use `@s.whatsapp.net`. */
  private toWWebJsChatId(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@lid')) {
      return jid;
    }
    if (jid.endsWith('@s.whatsapp.net')) {
      return jid.replace('@s.whatsapp.net', '@c.us');
    }
    if (jid.endsWith('@c.us')) {
      return jid;
    }
    return jid.includes('@') ? jid : `${jid}@c.us`;
  }

  private async wwebjsTypingDelay(chatId: string, delayMs?: number): Promise<void> {
    if (!delayMs || delayMs <= 0 || !this.wwebClient) {
      return;
    }
    let chat: { sendStateTyping: () => Promise<void>; clearState: () => Promise<void> };
    try {
      chat = await this.wwebClient.getChatById(chatId);
    } catch {
      return;
    }
    const runChunk = async (ms: number) => {
      await chat.sendStateTyping();
      await delay(ms);
      await chat.clearState();
    };
    if (delayMs > 20000) {
      let remaining = delayMs;
      while (remaining > 20000) {
        await runChunk(20000);
        remaining -= 20000;
      }
      if (remaining > 0) {
        await runChunk(remaining);
      }
    } else {
      await runChunk(delayMs);
    }
  }

  private quotedMessageIdFromDto(quoted?: { key?: { id?: string | null } }): string | undefined {
    const id = quoted?.key?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }

  private async finalizeOutboundSend(messageRaw: any, isIntegration: boolean): Promise<void> {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration) {
      this.chatwootService.eventWhatsapp(
        Events.SEND_MESSAGE,
        { instanceName: this.instance.name, instanceId: this.instanceId },
        messageRaw,
      );
    }

    const db = this.configService.get<Database>('DATABASE');
    if (db.SAVE_DATA.NEW_MESSAGE) {
      try {
        await this.prismaRepository.message.create({
          data: {
            key: messageRaw.key,
            pushName: messageRaw.pushName,
            participant: messageRaw.key.participant,
            messageType: messageRaw.messageType,
            message: messageRaw.message,
            contextInfo: messageRaw.contextInfo,
            source: messageRaw.source,
            messageTimestamp: messageRaw.messageTimestamp,
            instanceId: this.instanceId,
            status: messageRaw.status,
          },
        });
      } catch (error) {
        this.logger.error(`Error saving outbound message: ${error}`);
      }
    }

    this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && isIntegration) {
      await chatbotController.emit({
        instance: { instanceName: this.instance.name, instanceId: this.instanceId },
        remoteJid: messageRaw.key.remoteJid,
        msg: messageRaw,
        pushName: messageRaw.pushName,
        isIntegration,
      });
    }
  }

  private prepareMessage(msg: any): any {
    const messageType = this.mapWWebJSTypeToMessageType(msg.type, msg);
    const messageContent = this.buildMessageContent(msg);

    const rawJid = msg.fromMe ? msg.to || '' : msg.from || '';
    const remoteJid = this.normalizeJid(rawJid);

    const messageRaw: any = {
      key: {
        remoteJid,
        fromMe: msg.fromMe || false,
        id: msg.id?._serialized || msg.id?.id || v4(),
        participant: msg.author ? this.normalizeJid(msg.author) : undefined,
      },
      pushName: msg._data?.notifyName || msg._data?.pushname || (msg.fromMe ? 'Você' : undefined),
      status: this.mapAckToStatus(msg.ack ?? 0),
      message: messageContent,
      contextInfo: undefined as any,
      messageType,
      messageTimestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      instanceId: this.instanceId,
      source: 'web',
    };

    if (msg.hasQuotedMsg && msg._data?.quotedMsg) {
      messageRaw.contextInfo = {
        quotedMessage: {
          conversation: msg._data.quotedMsg.body || '',
        },
        stanzaId: msg._data.quotedStanzaID,
        participant: msg._data.quotedParticipant ? this.normalizeJid(msg._data.quotedParticipant) : undefined,
      };
    }

    if (msg.mentionedIds?.length > 0) {
      messageRaw.contextInfo = messageRaw.contextInfo || {};
      messageRaw.contextInfo.mentionedJid = msg.mentionedIds.map((id: string) => this.normalizeJid(id));
    }

    if (msg.isForwarded) {
      messageRaw.contextInfo = messageRaw.contextInfo || {};
      messageRaw.contextInfo.isForwarded = true;
      messageRaw.contextInfo.forwardingScore = msg.forwardingScore || 1;
    }

    return messageRaw;
  }

  private async handleIncomingMessage(msg: any) {
    const messageRaw = this.prepareMessage(msg);
    const isMedia = TypeMediaMessage.includes(messageRaw.messageType);
    const isFromMe = msg.fromMe === true;

    if (!isFromMe && this.localSettings.readMessages) {
      try {
        const chat = await msg.getChat();
        await chat.sendSeen();
      } catch {
        // ignore read receipt errors
      }
    }

    // Chatwoot integration
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
      const chatwootResult = await this.chatwootService.eventWhatsapp(
        Events.MESSAGES_UPSERT,
        { instanceName: this.instance.name, instanceId: this.instanceId },
        messageRaw,
      );

      if (chatwootResult?.id) {
        messageRaw.chatwootMessageId = chatwootResult.id;
        messageRaw.chatwootInboxId = chatwootResult.inboxId;
        messageRaw.chatwootConversationId = chatwootResult.conversationId;
      }
    }

    // Save to database
    const db = this.configService.get<Database>('DATABASE');
    let savedMessage: Message | null = null;
    if (db.SAVE_DATA.NEW_MESSAGE) {
      try {
        savedMessage = await this.prismaRepository.message.create({
          data: {
            key: messageRaw.key,
            pushName: messageRaw.pushName,
            participant: messageRaw.key.participant,
            messageType: messageRaw.messageType,
            message: messageRaw.message,
            contextInfo: messageRaw.contextInfo,
            source: messageRaw.source,
            messageTimestamp: messageRaw.messageTimestamp,
            instanceId: this.instanceId,
            status: messageRaw.status,
            chatwootMessageId: messageRaw.chatwootMessageId ? parseInt(messageRaw.chatwootMessageId) : null,
            chatwootInboxId: messageRaw.chatwootInboxId ? parseInt(messageRaw.chatwootInboxId) : null,
            chatwootConversationId: messageRaw.chatwootConversationId
              ? parseInt(messageRaw.chatwootConversationId)
              : null,
          },
        });
      } catch (error) {
        this.logger.error(`Error saving message to database: ${error}`);
      }
    }

    // Media download + S3 upload (same layout as Baileys incoming media: instanceId/remoteJid/messageType/timestamp_fileName)
    if (isMedia && msg.hasMedia && db.SAVE_DATA.NEW_MESSAGE && savedMessage) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const s3Config = this.configService.get<S3>('S3');
          if (s3Config?.ENABLE) {
            const buffer = Buffer.from(media.data, 'base64');
            const ext = media.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'bin';
            const fileName = media.filename || `${messageRaw.key.id}.${ext}`;
            const mimetype = String(mimeTypes.lookup(fileName) || media.mimetype || 'application/octet-stream');
            const fullName = path.posix.join(
              `${this.instance.id}`,
              messageRaw.key.remoteJid,
              messageRaw.messageType,
              `${Date.now()}_${fileName}`,
            );

            await s3Service.uploadFile(fullName, buffer, buffer.length, {
              'Content-Type': mimetype,
            });

            const mediaUrl = await s3Service.getObjectUrl(fullName);
            messageRaw.message.mediaUrl = mediaUrl;

            await this.prismaRepository.media.create({
              data: {
                messageId: savedMessage.id,
                instanceId: this.instanceId,
                type: messageRaw.messageType,
                fileName: fullName,
                mimetype,
              },
            });

            await this.prismaRepository.message.update({
              where: { id: savedMessage.id },
              data: messageRaw,
            });
          }

          // Webhook base64
          if (this.localWebhook.enabled && this.localWebhook.webhookBase64) {
            messageRaw.message.base64 = media.data;
          }
        }
      } catch (error) {
        this.logger.error(`Error processing media: ${error}`);
      }
    }

    // Save chat
    if (db.SAVE_DATA.CHATS) {
      try {
        const chat = await msg.getChat();
        const remoteJid = messageRaw.key.remoteJid;

        await this.prismaRepository.chat.upsert({
          where: {
            instanceId_remoteJid: {
              instanceId: this.instanceId,
              remoteJid,
            },
          },
          create: {
            remoteJid,
            name: chat.name || remoteJid.split('@')[0],
            instanceId: this.instanceId,
          },
          update: {
            name: chat.name || undefined,
          },
        });
      } catch (error) {
        this.logger.error(`Error saving chat: ${error}`);
      }
    }

    // Telemetry
    const telemetryAction = isFromMe ? 'sent' : 'received';
    sendTelemetry(`${telemetryAction}.message.${messageRaw.messageType ?? 'unknown'}`);

    // Webhook
    this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

    // Chatbot emit — only for incoming messages
    if (!isFromMe) {
      await chatbotController.emit({
        instance: { instanceName: this.instance.name, instanceId: this.instanceId },
        remoteJid: messageRaw.key.remoteJid,
        msg: messageRaw,
        pushName: messageRaw.pushName,
      });
    }

    // Contact save
    if (db.SAVE_DATA.CONTACTS && !isFromMe) {
      try {
        const contact = await msg.getContact();
        const contactJid = messageRaw.key.remoteJid;

        await this.prismaRepository.contact.upsert({
          where: {
            remoteJid_instanceId: {
              remoteJid: contactJid,
              instanceId: this.instanceId,
            },
          },
          create: {
            remoteJid: contactJid,
            pushName: contact?.pushname || messageRaw.pushName,
            profilePicUrl: null,
            instanceId: this.instanceId,
          },
          update: {
            pushName: contact?.pushname || messageRaw.pushName || undefined,
          },
        });

        this.sendDataWebhook(Events.CONTACTS_UPSERT, {
          id: contactJid,
          pushName: contact?.pushname || messageRaw.pushName,
        });
      } catch (error) {
        this.logger.error(`Error saving contact: ${error}`);
      }
    }
  }

  // =====================================================
  // PHASE 1: Profile basics
  // =====================================================

  public async getProfileName() {
    return this.wwebClient?.info?.pushname || this.instance.profileName || null;
  }

  public async getProfileStatus() {
    try {
      const status = await this.wwebClient?.getState();
      return status || null;
    } catch {
      return null;
    }
  }

  // =====================================================
  // PHASE 2+: Outbound messages (parity with Baileys contract)
  // =====================================================

  public async textMessage(data: SendTextDto, isIntegration = false) {
    const text = data.text;
    if (!text || text.trim().length === 0) {
      throw new BadRequestException('Text is required');
    }
    if (!this.wwebClient) {
      throw new BadRequestException('WhatsApp client is not connected');
    }

    const jid = createJid(data.number);
    const chatId = this.toWWebJsChatId(jid);

    await this.wwebjsTypingDelay(chatId, data.delay);

    const sendOptions: Record<string, unknown> = {
      linkPreview: data.linkPreview !== false,
    };

    const qId = this.quotedMessageIdFromDto(data.quoted);
    if (qId) {
      sendOptions.quotedMessageId = qId;
    }

    if (data.mentioned?.length) {
      sendOptions.mentions = data.mentioned.map((n) => this.toWWebJsChatId(createJid(n)));
    } else if (data.mentionsEveryOne && isJidGroup(jid)) {
      try {
        const chat = await this.wwebClient.getChatById(chatId);
        const participants = (chat as { participants?: { id: { _serialized: string } }[] }).participants;
        if (participants?.length) {
          sendOptions.mentions = participants.map((p) => p.id._serialized);
        }
      } catch {
        // ignore @all failure; send without mentions
      }
    }

    let sent: any;
    try {
      sent = await this.wwebClient.sendMessage(chatId, data.text, sendOptions);
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error?.toString?.() ?? 'Failed to send message');
    }

    if (!sent) {
      throw new BadRequestException('Failed to send message');
    }

    const messageRaw = this.prepareMessage(sent);
    await this.finalizeOutboundSend(messageRaw, isIntegration);
    sendTelemetry('/message/sendText');
    return messageRaw;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async pollMessage(_data: SendPollDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async statusMessage(_data: SendStatusDto, _file?: any) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async mediaSticker(_data: SendStickerDto, _file?: any) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async mediaMessage(_data: SendMediaDto, _file?: any, _isIntegration = false) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async ptvMessage(_data: SendPtvDto, _file?: any, _isIntegration = false) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async processAudioMp4(_audio: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async processAudio(_audio: string): Promise<Buffer> {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async audioWhatsapp(_data: SendAudioDto, _file?: any, _isIntegration = false) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async buttonMessage(_data: SendButtonsDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async locationMessage(_data: SendLocationDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async listMessage(_data: SendListDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async contactMessage(_data: SendContactDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async reactionMessage(_data: SendReactionDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async whatsappNumber(_data: WhatsAppNumberDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async markMessageAsRead(_data: ReadMessageDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getLastMessage(_number: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async archiveChat(_data: ArchiveChatDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async markChatUnread(_data: MarkChatUnreadDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async deleteMessage(_del: DeleteMessage) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getBase64FromMediaMessage(_data: getBase64FromMediaMessageDto, _getBuffer = false) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 3');
  }

  public async fetchPrivacySettings() {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updatePrivacySettings(_settings: PrivacySettingDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async fetchBusinessProfile(_number: string): Promise<NumberBusiness> {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateProfileName(_name: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateProfileStatus(_status: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateProfilePicture(_picture: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  public async removeProfilePicture() {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async blockUser(_data: BlockUserDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateMessage(_data: UpdateMessageDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
  }

  public async fetchLabels(): Promise<LabelDto[]> {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handleLabel(_data: HandleLabelDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async createGroup(_create: CreateGroupDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateGroupPicture(_picture: GroupPictureDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateGroupSubject(_data: GroupSubjectDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateGroupDescription(_data: GroupDescriptionDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async findGroup(_id: GroupJid, _reply: 'inner' | 'out' = 'out') {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async fetchAllGroups(_getParticipants: GetParticipant) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async inviteCode(_id: GroupJid) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async inviteInfo(_id: GroupInvite) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async sendInvite(_id: GroupSendInvite) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async acceptInviteCode(_id: AcceptGroupInvite) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async revokeInviteCode(_id: GroupJid) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async findParticipants(_id: GroupJid) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateGParticipant(_update: GroupUpdateParticipantDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async updateGSetting(_update: GroupUpdateSettingDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async toggleEphemeral(_update: GroupToggleEphemeralDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async leaveGroup(_id: GroupJid) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 4');
  }

  public async templateMessage() {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async sendPresence(_data: SendPresenceDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async setPresence(_data: SetPresenceDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async profilePicture(_number: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async fetchProfile(_instanceName: string, _number?: string) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 5');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async offerCall({ number: _number, isVideo: _isVideo, callDuration: _callDuration }: OfferCallDto) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 6');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async fetchCatalog(_instanceName: string, _data: getCollectionsDto) {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getCatalog(_data: any) {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async fetchCollections(_instanceName: string, _data: getCollectionsDto) {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getCollections(_jid?: string, _limit?: number) {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  public async fetchMessages(query: Query<Message>) {
    return super.fetchMessages(query);
  }

  public async receiveMobileCode() {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }

  public async fakeCall() {
    throw new BadRequestException('Method not available on WWebJS Channel');
  }
}
