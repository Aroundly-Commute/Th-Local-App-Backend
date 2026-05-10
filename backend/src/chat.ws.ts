import * as WebSocket from 'ws';

export const chatClients = new Map<string, WebSocket[]>();
export const notificationClients = new Map<string, WebSocket>();

export function setupChatWs(server: any) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (ws, request) => {
    const url = request.url || ''; 
    const parts = url.split('/');
    
    if (url.startsWith('/api/ws/notifications/')) {
      const userId = parts[parts.length - 1];
      console.log(`[WS] Notification client connected for user: ${userId}`);
      notificationClients.set(userId, ws as any);
      ws.on('close', () => {
        console.log(`[WS] Notification client disconnected for user: ${userId}`);
        if (notificationClients.get(userId) === ws as any) {
          notificationClients.delete(userId);
        }
      });
      return;
    }

    const chatId = parts[parts.length - 1];
    console.log(`[WS] Chat client connected for chat: ${chatId}`);

    if (!chatClients.has(chatId)) {
      chatClients.set(chatId, []);
    }
    chatClients.get(chatId)?.push(ws as any);

    ws.on('close', () => {
      console.log(`[WS] Chat client disconnected for chat: ${chatId}`);
      const clients = chatClients.get(chatId);
      if (clients) {
        chatClients.set(chatId, clients.filter(c => c !== ws));
      }
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

export function notifyUserWs(userId: string, type: string, payload: any) {
  const ws = notificationClients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

export function broadcastToChat(chatId: string, message: any) {
  const clients = chatClients.get(chatId);
  if (clients) {
    const data = JSON.stringify(message);
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }
}
