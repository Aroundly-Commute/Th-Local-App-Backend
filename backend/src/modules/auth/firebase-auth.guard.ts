import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
      // 1. Verify token with Firebase Admin
      const decodedToken = await admin.auth().verifyIdToken(token);
      
      // 2. Find or create the user in our PostgreSQL Database
      let user = await prisma.user.findUnique({
        where: { firebaseUid: decodedToken.uid }
      });
      
      if (!user) {
        user = await prisma.user.create({
          data: {
            firebaseUid: decodedToken.uid,
            email: decodedToken.email || null,
            phoneNumber: decodedToken.phone_number || null,
            name: decodedToken.name || decodedToken.phone_number || 'Carpool User',
            profilePic: decodedToken.picture || null,
          }
        });
      }

      // 3. Attach user object to the request so controllers can use req.user
      request.user = user;
      return true;
    } catch (error: any) {
      console.error("Firebase auth error details:", error?.message || error);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
