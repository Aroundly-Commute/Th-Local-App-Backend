import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';
const USE_FIREBASE_AUTH = process.env.USE_FIREBASE_AUTH !== 'false';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.split('Bearer ')[1];
    
    try {
      let decodedLocalToken: any = null;
      let user: any = null;

      // Check if it's a local JWT
      try {
        decodedLocalToken = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        // Not a local token, might be a firebase token
      }

      if (decodedLocalToken && decodedLocalToken.sub) {
        user = await prisma.user.findUnique({ where: { id: decodedLocalToken.sub } });
      } else if (USE_FIREBASE_AUTH) {
        // Fallback to Firebase
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        user = await prisma.user.findUnique({
          where: { firebaseUid: decodedToken.uid }
        });
        
        if (!user) {
          // Extract custom headers sent during first-time signup sync
          const requestedRole = request.headers['x-user-role'] || 'passenger';
          const requestedName = request.headers['x-user-name'] || decodedToken.name || decodedToken.phone_number || 'Carpool User';

          user = await prisma.user.create({
            data: {
              firebaseUid: decodedToken.uid,
              email: decodedToken.email || null,
              phoneNumber: decodedToken.phone_number || null,
              name: requestedName,
              profilePic: decodedToken.picture || null,
              role: requestedRole,
            }
          });
        }
      }

      if (!user) throw new UnauthorizedException('User not found');

      // 3. Attach user object to the request so controllers can use req.user
      request.user = user;
      return true;
    } catch (error: any) {
      console.error("Auth error details:", error?.message || error);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
