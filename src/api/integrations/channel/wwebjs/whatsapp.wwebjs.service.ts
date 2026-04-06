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
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository, Query } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { Events, wa } from '@api/types/wa.types';
import { Chatwoot, ConfigService, QrCode } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, InternalServerErrorException } from '@exceptions';
import { Message } from '@prisma/client';
import EventEmitter2 from 'eventemitter2';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';

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
    try {
      this.loadChatwoot();
      this.loadSettings();
      this.loadWebhook();
      this.loadProxy();

      return await this.createClient(number);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async reloadConnection(): Promise<any> {
    try {
      await this.destroyClient();
      return await this.createClient(this.phoneNumber);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async logoutInstance() {
    try {
      if (this.wwebClient) {
        await this.wwebClient.logout();
        await this.wwebClient.destroy();
      }
    } catch (error) {
      this.logger.error(`Error during logout: ${error}`);
    }

    this.wwebClient = null;

    if (this.remoteStore) {
      await this.remoteStore.delete({ session: this.instanceId });
    }
  }

  private async destroyClient() {
    if (this.wwebClient) {
      try {
        await this.wwebClient.destroy();
      } catch (error) {
        this.logger.error(`Error destroying client: ${error}`);
      }
      this.wwebClient = null;
    }
  }

  private async createClient(number?: string): Promise<any> {
    this.remoteStore = new PrismaRemoteStore(this.instanceId, this.prismaRepository, this.cache);

    if (number || this.phoneNumber) {
      this.phoneNumber = number || this.phoneNumber;
    }

    const puppeteerOptions: any = {
      headless: true,
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

    this.wwebClient = new wwebjs.Client({
      authStrategy: new wwebjs.RemoteAuth({
        clientId: this.instanceId,
        store: this.remoteStore,
        backupSyncIntervalMs: 300000,
      }),
      puppeteer: puppeteerOptions,
      qrMaxRetries: this.configService.get<QrCode>('QRCODE').LIMIT || 6,
    });

    this.setupEventHandlers();

    this.logger.info(`Initializing wwebjs client for instance: ${this.instanceName}`);
    await this.wwebClient.initialize();

    this.phoneNumber = number;

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
      this.logger.info(`Client authenticated for instance: ${this.instanceName}`);
    });

    this.wwebClient.on('auth_failure', (message: string) => {
      this.logger.error(`Authentication failure: ${message}`);
      this.stateConnection = { state: 'close' };

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        state: 'close',
        statusReason: 401,
      });
    });

    this.wwebClient.on('ready', async () => {
      this.logger.info(`Client ready for instance: ${this.instanceName}`);
      this.endSession = false;

      const info = this.wwebClient.info;
      this.instance.wuid = info?.wid?._serialized || info?.wid?.user;
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
    });

    this.wwebClient.on('disconnected', async (reason: string) => {
      this.logger.warn(`Client disconnected: ${reason}`);
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

    this.wwebClient.on('change_state', (state: string) => {
      this.logger.info(`Connection state changed: ${state}`);
    });

    this.wwebClient.on('remote_session_saved', () => {
      this.logger.info(`Remote session saved to database for instance: ${this.instanceName}`);
    });
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
  // PHASE 2+ STUBS: To be implemented in future phases
  // All methods below follow the same contract as Baileys
  // =====================================================

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async textMessage(_data: SendTextDto, _isIntegration = false) {
    throw new BadRequestException('Method not yet implemented on WWebJS Channel - Phase 2');
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
