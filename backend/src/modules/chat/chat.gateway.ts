import { Injectable, OnModuleInit } from '@nestjs/common';
import * as WebSocket from 'ws';
import { ChatService } from './chat.service';

@Injectable()
export class ChatGateway {
  constructor(private readonly chatService: ChatService) {}

  setupChatWs(server: any) {
    const wss = new WebSocket.Server({ noServer: true });

    wss.on('connection', (ws, request) => {
      const url = request.url || '';
      const parts = url.split('/');

      if (url.startsWith('/api/ws/notifications/')) {
        const userId = parts[parts.length - 1];
        this.chatService.registerNotificationClient(userId, ws as any);
        
        ws.on('close', () => {
          this.chatService.removeNotificationClient(userId, ws as any);
        });
        return;
      }

      const chatId = parts[parts.length - 1];
      this.chatService.registerChatClient(chatId, ws as any);

      ws.on('close', () => {
        this.chatService.removeChatClient(chatId, ws as any);
      });
    });

    server.on('upgrade', (request: any, socket: any, head: any) => {
      if (request.url?.startsWith('/api/ws/chat/') || request.url?.startsWith('/api/ws/notifications/')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });
  }
}
