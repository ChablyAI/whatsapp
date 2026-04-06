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
import { sendTelemetry } from '@utils/sendTelemetry';
import EventEmitter2 from 'eventemitter2';
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

      this.stateConnection = {
        instance: this.instance.name,
        state: 'connecting',
        statusReason: 200,
      };

      await this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: { connectionStatus: 'connecting' },
      });

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

    // @todo bu alanda headless true olarak ayarlanacak
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
      this.logger.info(`Client authenticated for instance: ${this.instanceName}`);
    });

    this.wwebClient.on('auth_failure', async (message: string) => {
      this.logger.error(`Authentication failure: ${message}`);
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

    this.wwebClient.on('change_state', async (state: string) => {
      this.logger.info(`Connection state changed: ${state}`);

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
      this.logger.info(`Remote session saved to database for instance: ${this.instanceName}`);
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
                remoteJid: msg.from || msg.to,
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
            remoteJid: msg.from || msg.to,
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
            remoteJid: revokedMsg.from || revokedMsg.to,
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

          await this.prismaRepository.messageUpdate.create({
            data: {
              keyId,
              remoteJid: msg.from || msg.to,
              fromMe: msg.fromMe ?? false,
              status: 'EDITED',
              messageId: existingMsg.id,
              instanceId: this.instanceId,
            },
          });
        }

        this.sendDataWebhook(Events.MESSAGES_EDITED, {
          key: {
            remoteJid: msg.from || msg.to,
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
            remoteJid: reaction.senderId,
            fromMe: false,
            id: reaction.msgId?._serialized || reaction.msgId?.id,
          },
          reaction: {
            text: reaction.reaction,
            senderId: reaction.senderId,
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

  private prepareMessage(msg: any): any {
    const messageType = this.mapWWebJSTypeToMessageType(msg.type, msg);
    const messageContent = this.buildMessageContent(msg);

    const remoteJid = msg.fromMe
      ? (msg.to || '').replace(/^(\d+)$/, '$1@s.whatsapp.net')
      : (msg.from || '').replace(/^(\d+)$/, '$1@s.whatsapp.net');

    const messageRaw: any = {
      key: {
        remoteJid,
        fromMe: msg.fromMe || false,
        id: msg.id?._serialized || msg.id?.id || v4(),
        participant: msg.author || undefined,
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
        participant: msg._data.quotedParticipant,
      };
    }

    if (msg.mentionedIds?.length > 0) {
      messageRaw.contextInfo = messageRaw.contextInfo || {};
      messageRaw.contextInfo.mentionedJid = msg.mentionedIds;
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

    // Media download + S3 upload
    if (isMedia && msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const s3Config = this.configService.get<S3>('S3');
          if (s3Config?.ENABLE) {
            const buffer = Buffer.from(media.data, 'base64');
            const ext = media.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'bin';
            const fullName = `${this.instanceId}/${messageRaw.messageType}/${messageRaw.key.id}.${ext}`;

            await s3Service.uploadFile(fullName, buffer, buffer.length, {
              'Content-Type': media.mimetype,
            });

            const mediaUrl = await s3Service.getObjectUrl(fullName);
            messageRaw.message.mediaUrl = mediaUrl;

            await this.prismaRepository.media.create({
              data: {
                messageId: messageRaw.key.id,
                instanceId: this.instanceId,
                type: messageRaw.messageType,
                fileName: media.filename || `${messageRaw.key.id}.${ext}`,
                mimetype: media.mimetype,
              },
            });

            if (db.SAVE_DATA.NEW_MESSAGE) {
              await this.prismaRepository.message.updateMany({
                where: {
                  instanceId: this.instanceId,
                  key: { path: ['id'], equals: messageRaw.key.id },
                },
                data: { message: { ...messageRaw.message, mediaUrl } },
              });
            }
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
