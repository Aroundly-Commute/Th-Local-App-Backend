import { Injectable } from '@nestjs/common';
import * as WebSocket from 'ws';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  public readonly chatClients = new Map<string, WebSocket[]>();
  public readonly notificationClients = new Map<string, WebSocket>();

  registerNotificationClient(userId: string, ws: WebSocket) {
    console.log(`[WS] Registering notification client for user: ${userId}`);
    this.notificationClients.set(userId, ws);
  }

  removeNotificationClient(userId: string, ws: WebSocket) {
    if (this.notificationClients.get(userId) === ws) {
      console.log(`[WS] Removing notification client for user: ${userId}`);
      this.notificationClients.delete(userId);
    }
  }

  registerChatClient(chatId: string, ws: WebSocket) {
    console.log(`[WS] Registering chat client for chat: ${chatId}`);
    if (!this.chatClients.has(chatId)) {
      this.chatClients.set(chatId, []);
    }
    this.chatClients.get(chatId)?.push(ws);
  }

  removeChatClient(chatId: string, ws: WebSocket) {
    console.log(`[WS] Removing chat client for chat: ${chatId}`);
    const clients = this.chatClients.get(chatId);
    if (clients) {
      this.chatClients.set(chatId, clients.filter(c => c !== ws));
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
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
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
      created_at: m.createdAt.toISOString()
    }));
  }

  async postMessage(chatId: string, text: string, senderId: string) {
    const msg = await this.prisma.message.create({
      data: {
        chatId,
        senderId,
        text
      },
      include: { sender: true }
    });
    
    const responseData = {
      id: msg.id,
      chat_id: msg.chatId,
      sender_id: msg.senderId,
      sender_name: msg.sender.name,
      text: msg.text,
      created_at: msg.createdAt.toISOString()
    };
    
    this.broadcastToChat(chatId, responseData);
    
    return responseData;
  }
}
