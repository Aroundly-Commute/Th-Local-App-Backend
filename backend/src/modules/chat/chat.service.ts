import { Injectable } from '@nestjs/common';
import * as WebSocket from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  public readonly chatClients = new Map<string, { userId: string | null; ws: WebSocket }[]>();
  public readonly notificationClients = new Map<string, WebSocket>();

  registerNotificationClient(userId: string, ws: WebSocket) {
    console.log(`[WS] Registering notification client for user: ${userId}`);
    this.notificationClients.set(userId, ws);

    // Process pending notifications and mark SENT messages as DELIVERED
    this.processPendingNotificationsAndDeliveries(userId).catch(err => {
      console.error(`[WS] Error processing pending notifications/deliveries for ${userId}:`, err);
    });
  }

  removeNotificationClient(userId: string, ws: WebSocket) {
    if (this.notificationClients.get(userId) === ws) {
      console.log(`[WS] Removing notification client for user: ${userId}`);
      this.notificationClients.delete(userId);
    }
  }

  async registerChatClient(chatId: string, userId: string | null, ws: WebSocket) {
    console.log(`[WS] Registering chat client for chat: ${chatId}, user: ${userId}`);
    if (!this.chatClients.has(chatId)) {
      this.chatClients.set(chatId, []);
    }
    this.chatClients.get(chatId)?.push({ userId, ws });

    if (userId) {
      await this.markChatAsRead(chatId, userId);
    }
  }

  removeChatClient(chatId: string, userId: string | null, ws: WebSocket) {
    console.log(`[WS] Removing chat client for chat: ${chatId}, user: ${userId}`);
    const clients = this.chatClients.get(chatId);
    if (clients) {
      this.chatClients.set(chatId, clients.filter(c => c.ws !== ws));
    }
  }

  notifyUserWs(userId: string, type: string, payload: any) {
    const ws = this.notificationClients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  }

  broadcastToChat(chatId: string, message: any) {
    const clients = this.chatClients.get(chatId);
    if (clients) {
      const data = JSON.stringify(message);
      clients.forEach(c => {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(data);
        }
      });
    }
  }

  async getChats(userId: string) {
    const messages = await this.prisma.message.findMany({
      where: {
        OR: [
          { chatId: { startsWith: `chat_${userId}_` } },
          { chatId: { endsWith: `_${userId}` } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      distinct: ['chatId'],
      include: { sender: true }
    });

    const chats: any[] = [];
    for (const m of messages) {
      let otherUserId: string | null = null;
      let otherUserName = "Someone";

      if (m.senderId === userId) {
        const recipientId = await this.getRecipientId(m.chatId, userId);
        otherUserId = recipientId;
        if (otherUserId) {
          const otherUser = await this.prisma.user.findUnique({
            where: { id: otherUserId },
            select: { name: true }
          });
          if (otherUser) {
            otherUserName = otherUser.name;
          }
        }
      } else {
        otherUserId = m.senderId;
        otherUserName = m.sender.name;
      }

      chats.push({
        chat_id: m.chatId,
        last_message: m.text,
        last_time: m.createdAt.toISOString(),
        other_user: {
          id: otherUserId || "other",
          name: otherUserName,
        },
        ride_route: "Ride Chat"
      });
    }

    return chats;
  }

  async getMessages(chatId: string) {
    const msgs = await this.prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      include: { sender: true }
    });
    return msgs.map(m => ({
      id: m.id,
      chat_id: m.chatId,
      sender_id: m.senderId,
      sender_name: m.sender.name,
      text: m.text,
      status: m.status,
      created_at: m.createdAt.toISOString()
    }));
  }

  async sendFcmPush(token: string, title: string, body: string, data?: Record<string, string>, imageUrl?: string) {
    try {
      if (!token) return;
      console.log(`[FCM] Sending push notification to token: ${token}`);
      
      const payloadData: Record<string, string> = {};
      if (data) {
        for (const [k, v] of Object.entries(data)) {
          payloadData[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }

      const notifType = payloadData.type || 'general';
      const isChat = notifType === 'chat_message' || notifType === 'new_chat_message';
      const isRequest = notifType.includes('request') || notifType.includes('invite');

      await admin.messaging().send({
        token,
        notification: {
          title,
          body,
          ...(imageUrl ? { imageUrl } : {}),
        },
        data: payloadData,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'default_channel_id',
            ...(imageUrl ? { imageUrl } : {}),
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              category: isChat ? 'CHAT_MESSAGE' : isRequest ? 'RIDE_REQUEST' : 'GENERAL',
            }
          },
          fcmOptions: {
            ...(imageUrl ? { imageUrl } : {}),
          }
        }
      });
    } catch (err: any) {
      console.error(`[FCM] Error sending push notification:`, err?.message || err);
    }
  }

  async getRecipientId(chatId: string, senderId: string): Promise<string | null> {
    try {
      if (chatId.startsWith('chat_')) {
        const parts = chatId.replace(/^chat_/, '').split('_');
        if (parts.length === 2) {
          const user1 = parts[0];
          const user2 = parts[1];
          return senderId === user1 ? user2 : user1;
        }
      }
    } catch (err) {
      console.error(`[CHAT] Error resolving recipient for chatId: ${chatId}`, err);
    }
    return null;
  }

  async postMessage(chatId: string, text: string, senderId: string) {
    const recipientId = await this.getRecipientId(chatId, senderId);

    let resolvedStatus = 'SENT';
    const isRecipientInChat = recipientId ? this.chatClients.get(chatId)?.some(c => c.userId === recipientId) : false;
    if (recipientId) {
      if (isRecipientInChat) {
        resolvedStatus = 'READ';
      } else {
        const isRecipientOnline = this.notificationClients.has(recipientId);
        if (isRecipientOnline) {
          resolvedStatus = 'DELIVERED';
        }
      }
    }

    const msg = await this.prisma.message.create({
      data: {
        chatId,
        senderId,
        text,
        status: resolvedStatus
      },
      include: { sender: true }
    });

    const responseData = {
      id: msg.id,
      chat_id: msg.chatId,
      sender_id: msg.senderId,
      sender_name: msg.sender.name,
      sender_avatar: msg.sender.profilePic || null,
      text: msg.text,
      status: msg.status,
      created_at: msg.createdAt.toISOString()
    };

    // Broadcast the message to the chat room
    this.broadcastToChat(chatId, responseData);

    if (recipientId) {
      if (resolvedStatus === 'DELIVERED') {
        // In-app real-time notification
        this.notifyUserWs(recipientId, 'new_chat_message', responseData);
      } else if (resolvedStatus === 'SENT') {
        // Offline notification queueing
        await this.prisma.pendingNotification.create({
          data: {
            userId: recipientId,
            type: 'new_chat_message',
            payload: JSON.stringify(responseData)
          }
        });
      }

      // Always dispatch FCM Push Notification to recipient if not actively looking at this chat room
      // (ensures background notification panel gets notified)
      if (!isRecipientInChat) {
        const recipient = await this.prisma.user.findUnique({
          where: { id: recipientId },
          select: { fcmToken: true }
        });
        if (recipient?.fcmToken) {
          await this.sendFcmPush(
            recipient.fcmToken,
            `Message from ${msg.sender.name}`,
            text,
            {
              chatId,
              senderId,
              senderName: msg.sender.name,
              senderAvatar: msg.sender.profilePic || '',
              type: 'chat_message'
            },
            msg.sender.profilePic || undefined
          );
        }
      }
    }

    return responseData;
  }

  async markChatAsRead(chatId: string, userId: string) {
    console.log(`[CHAT] Marking chat ${chatId} as read for user ${userId}`);
    const unreadMessages = await this.prisma.message.findMany({
      where: {
        chatId,
        senderId: { not: userId },
        status: { not: 'READ' }
      }
    });

    if (unreadMessages.length > 0) {
      const messageIds = unreadMessages.map(m => m.id);
      await this.prisma.message.updateMany({
        where: { id: { in: messageIds } },
        data: { status: 'READ' }
      });

      this.broadcastToChat(chatId, {
        type: 'status_update',
        chatId,
        status: 'READ',
        messageIds
      });
    }
  }

  async processPendingNotificationsAndDeliveries(userId: string) {
    // 1. Deliver all SENT messages from other users, updating status to DELIVERED
    const sentMessages = await this.prisma.message.findMany({
      where: {
        senderId: { not: userId },
        status: 'SENT'
      }
    });

    for (const msg of sentMessages) {
      const recipient = await this.getRecipientId(msg.chatId, msg.senderId);
      if (recipient === userId) {
        await this.prisma.message.update({
          where: { id: msg.id },
          data: { status: 'DELIVERED' }
        });

        // Broadcast update to the chat room
        this.broadcastToChat(msg.chatId, {
          type: 'status_update',
          chatId: msg.chatId,
          status: 'DELIVERED',
          messageIds: [msg.id]
        });
      }
    }

    // 2. Deliver all pending notifications
    const pending = await this.prisma.pendingNotification.findMany({
      where: { userId }
    });
    for (const p of pending) {
      this.notifyUserWs(userId, p.type, JSON.parse(p.payload));
    }
    await this.prisma.pendingNotification.deleteMany({
      where: { userId }
    });
  }

  async sendNotificationToUser(userId: string, title: string, body: string, type: string, payloadData: any) {
    const ws = this.notificationClients.get(userId);
    const isOnline = ws && ws.readyState === WebSocket.OPEN;

    if (isOnline) {
      // In-app real-time notification
      console.log(`[NOTIFICATION] Sending in-app WS notification to ${userId} for type: ${type}`);
      ws.send(JSON.stringify({ type, payload: payloadData }));
    } else {
      // Offline notification queueing for when user reopens app
      console.log(`[NOTIFICATION] User ${userId} is offline/background. Queueing pending notification for type: ${type}`);
      await this.prisma.pendingNotification.create({
        data: {
          userId,
          type,
          payload: typeof payloadData === 'string' ? payloadData : JSON.stringify(payloadData)
        }
      });
    }

    // Always attempt FCM push notification if user has fcmToken (critical for system tray notifications when app is in background or closed)
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fcmToken: true }
      });
      if (user?.fcmToken) {
        const payloadObj = typeof payloadData === 'string' ? JSON.parse(payloadData) : payloadData;
        const senderName = payloadObj?.peerUser?.name || payloadObj?.requesterName || payloadObj?.userName || payloadObj?.rider_name || payloadObj?.driver_name || '';
        const senderAvatar = payloadObj?.peerUser?.avatarUrl || payloadObj?.peerUser?.profilePic || payloadObj?.avatarUrl || payloadObj?.profilePic || payloadObj?.requesterAvatar || '';
        const rideId = payloadObj?.rideId || payloadObj?.ride_id || '';
        const requestId = payloadObj?.id || payloadObj?.requestId || '';
        const chatId = payloadObj?.chatId || payloadObj?.chat_id || '';

        const dataParams: Record<string, string> = {
          type,
          senderName: String(senderName),
          senderAvatar: String(senderAvatar),
          rideId: String(rideId),
          requestId: String(requestId),
          chatId: String(chatId),
          payload: typeof payloadData === 'string' ? payloadData : JSON.stringify(payloadData)
        };

        await this.sendFcmPush(user.fcmToken, title, body, dataParams, senderAvatar || undefined);
      }
    } catch (e: any) {
      console.error(`[NOTIFICATION] Error sending FCM push to user ${userId}:`, e?.message || e);
    }
  }
}

