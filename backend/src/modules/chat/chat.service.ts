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
          { senderId: userId },
          { chatId: { contains: userId } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      distinct: ['chatId'],
      include: { sender: true }
    });

    return messages.map(m => ({
      chat_id: m.chatId,
      last_message: m.text,
      last_time: m.createdAt.toISOString(),
      other_user: {
        id: m.senderId === userId ? "other" : m.senderId,
        name: m.senderId === userId ? "Someone" : m.sender.name,
      },
      ride_route: "Ride Chat"
    }));
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

  async sendFcmPush(token: string, title: string, body: string, data?: Record<string, string>) {
    try {
      if (!token) return;
      console.log(`[FCM] Sending push notification to token: ${token}`);
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'default_channel_id'
          }
        }
      });
    } catch (err: any) {
      console.error(`[FCM] Error sending push notification:`, err?.message || err);
    }
  }

  async getRecipientId(chatId: string, senderId: string): Promise<string | null> {
    try {
      if (chatId.startsWith('buddy_')) {
        const parts = chatId.split('_');
        const buddyId = parts[1];
        const driverId = parts[2];
        const buddyRequest = await this.prisma.buddyRequest.findUnique({
          where: { id: buddyId }
        });
        if (buddyRequest) {
          return senderId === buddyRequest.riderId ? driverId : buddyRequest.riderId;
        }
      }

      const id = chatId.replace(/^chat_/, '');

      // Try RideRequest
      const rideRequest = await this.prisma.rideRequest.findUnique({
        where: { id },
        include: { ride: true }
      });
      if (rideRequest) {
        return senderId === rideRequest.riderId ? rideRequest.ride.driverId : rideRequest.riderId;
      }

      // Try ParkingBooking
      const parkingBooking = await this.prisma.parkingBooking.findUnique({
        where: { id },
        include: { spot: true }
      });
      if (parkingBooking && parkingBooking.spot?.ownerId) {
        return senderId === parkingBooking.userId ? parkingBooking.spot.ownerId : parkingBooking.userId;
      }

    } catch (err) {
      console.error(`[CHAT] Error resolving recipient for chatId: ${chatId}`, err);
    }
    return null;
  }

  async postMessage(chatId: string, text: string, senderId: string) {
    const recipientId = await this.getRecipientId(chatId, senderId);

    let resolvedStatus = 'SENT';
    if (recipientId) {
      const isRecipientInChat = this.chatClients.get(chatId)?.some(c => c.userId === recipientId);
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
        // Offline notification queueing & Firebase push
        await this.prisma.pendingNotification.create({
          data: {
            userId: recipientId,
            type: 'new_chat_message',
            payload: JSON.stringify(responseData)
          }
        });

        const recipient = await this.prisma.user.findUnique({
          where: { id: recipientId }
        });
        if (recipient?.fcmToken) {
          await this.sendFcmPush(
            recipient.fcmToken,
            `Message from ${msg.sender.name}`,
            text,
            {
              chatId,
              senderId,
              type: 'chat_message'
            }
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      // In-app real-time notification
      console.log(`[NOTIFICATION] Sending in-app notification to ${userId} for type: ${type}`);
      ws.send(JSON.stringify({ type, payload: payloadData }));
    } else {
      // Offline notification queueing & Firebase push
      console.log(`[NOTIFICATION] User ${userId} is offline. Queueing pending notification for type: ${type}`);
      await this.prisma.pendingNotification.create({
        data: {
          userId,
          type,
          payload: JSON.stringify(payloadData)
        }
      });

      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });
      if (user?.fcmToken) {
        await this.sendFcmPush(user.fcmToken, title, body, {
          type,
          payload: JSON.stringify(payloadData)
        });
      }
    }
  }
}
