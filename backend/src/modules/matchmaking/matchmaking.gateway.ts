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
import * as jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

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
        return;
      }

      let user: any = null;

      // 1. Try local JWT
      try {
        const decodedLocal: any = jwt.verify(token, JWT_SECRET);
        if (decodedLocal && decodedLocal.sub) {
          user = await prisma.user.findUnique({ where: { id: decodedLocal.sub } });
        }
      } catch (e) {
        // Not a local token
      }

      // 2. Fallback to Firebase
      if (!user) {
        try {
          const decodedToken = await admin.auth().verifyIdToken(token);
          user = await prisma.user.findUnique({
            where: { firebaseUid: decodedToken.uid },
          });
        } catch (e) {
          // Not a valid firebase token either
        }
      }

      if (!user) {
        console.log(`Socket client ${client.id} failed authentication`);
        return;
      }

      // Join a personal room named user_POSTGRES_ID
      const roomName = `user_${user.id}`;
      client.join(roomName);
      console.log(`Socket client ${client.id} joined room ${roomName}`);
    } catch (error) {
      console.error('Socket authentication failed:', error);
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
