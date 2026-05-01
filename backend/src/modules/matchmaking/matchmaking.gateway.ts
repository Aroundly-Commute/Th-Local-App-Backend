import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as admin from 'firebase-admin';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@WebSocketGateway({ cors: true })
export class MatchmakingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  async handleConnection(client: Socket) {
    try {
      // Allow token in auth payload or headers
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split('Bearer ')[1];

      if (!token) {
        client.disconnect();
        return;
      }

      // Verify Firebase token
      const decodedToken = await admin.auth().verifyIdToken(token);

      // Find user in Prisma
      const user = await prisma.user.findUnique({
        where: { firebaseUid: decodedToken.uid },
      });

      if (!user) {
        client.disconnect();
        return;
      }

      // Join a personal room named user_POSTGRES_ID
      const roomName = `user_${user.id}`;
      client.join(roomName);
      console.log(`Socket client ${client.id} joined room ${roomName}`);
    } catch (error) {
      console.error('Socket authentication failed:', error);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    console.log(`Socket client ${client.id} disconnected`);
  }

  // Method to emit events to a specific user
  notifyUser(userId: string, eventName: string, payload: any) {
    this.server.to(`user_${userId}`).emit(eventName, payload);
  }
}
