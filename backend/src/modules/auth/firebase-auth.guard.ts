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
    
    // Log the request method and URL safely without exposing sensitive authorization headers
    console.log(`[AUTH GUARD] canActivate triggered for request: ${request.method} ${request.url}`);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn("[AUTH GUARD] Access denied: No Bearer token provided in Authorization header");
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.split('Bearer ')[1];
    const tokenPreview = token ? `${token.substring(0, 15)}...${token.substring(token.length - 15)}` : 'null';
    console.log(`[AUTH GUARD] Received Token: ${tokenPreview}`);
    
    try {
      let decodedLocalToken: any = null;
      let user: any = null;

      // Check if it's a local JWT (by decoding the header first without validation)
      try {
        const decodedHeader: any = jwt.decode(token, { complete: true });
        if (decodedHeader && decodedHeader.header && decodedHeader.header.alg === 'HS256') {
          console.log("[AUTH GUARD] Local HS256 JWT detected. Verifying signature...");
          decodedLocalToken = jwt.verify(token, JWT_SECRET);
          console.log("[AUTH GUARD] Local JWT verified successfully. Decoded payload:", JSON.stringify(decodedLocalToken));
        }
      } catch (e: any) {
        console.log("[AUTH GUARD] Failed to check or verify local JWT:", e?.message || e);
      }

      if (decodedLocalToken && decodedLocalToken.sub) {
        console.log(`[AUTH GUARD] Looking up user by ID (local JWT sub): ${decodedLocalToken.sub}`);
        user = await prisma.user.findUnique({ where: { id: decodedLocalToken.sub } });
        console.log(`[AUTH GUARD] User lookup result: ${user ? 'FOUND (ID: ' + user.id + ')' : 'NOT FOUND'}`);
      } else {
        console.log(`[AUTH GUARD] Fallback to Firebase Auth. USE_FIREBASE_AUTH value is: ${USE_FIREBASE_AUTH}`);
        if (USE_FIREBASE_AUTH) {
          console.log("[AUTH GUARD] Calling admin.auth().verifyIdToken...");
          const decodedToken = await admin.auth().verifyIdToken(token);
          console.log(`[AUTH GUARD] Firebase ID Token successfully verified. Decoded token info: UID: ${decodedToken.uid}, Email: ${decodedToken.email}, Name: ${decodedToken.name}`);
          
          console.log(`[AUTH GUARD] Looking up database user by firebaseUid: ${decodedToken.uid}`);
          user = await prisma.user.findUnique({
            where: { firebaseUid: decodedToken.uid }
          });
          console.log(`[AUTH GUARD] User lookup by firebaseUid result: ${user ? 'FOUND (ID: ' + user.id + ', Role: ' + user.role + ')' : 'NOT FOUND'}`);
          
          if (!user && decodedToken.email) {
            console.log(`[AUTH GUARD] User not found by firebaseUid. Looking up by email instead: ${decodedToken.email}`);
            user = await prisma.user.findUnique({
              where: { email: decodedToken.email }
            });
            if (user) {
              console.log(`[AUTH GUARD] User found by email: ${user.email} (ID: ${user.id}). Linking firebaseUid: ${decodedToken.uid}...`);
              user = await prisma.user.update({
                where: { id: user.id },
                data: { firebaseUid: decodedToken.uid }
              });
              console.log(`[AUTH GUARD] Successfully linked firebaseUid to existing user: ID: ${user.id}`);
            } else {
              console.log("[AUTH GUARD] User not found by email in DB.");
            }
          }

          if (!user) {
            console.log("[AUTH GUARD] User does not exist. Creating new user record...");
            // Extract custom headers sent during first-time signup sync
            const requestedRole = request.headers['x-user-role'] || 'passenger';
            const requestedName = request.headers['x-user-name'] || decodedToken.name || decodedToken.phone_number || 'Carpool User';

            console.log(`[AUTH GUARD] Attempting user creation: name=${requestedName}, role=${requestedRole}, email=${decodedToken.email}`);
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
            console.log(`[AUTH GUARD] Successfully created new user: ID: ${user.id}, Email: ${user.email}`);
          }
        } else {
          console.warn("[AUTH GUARD] USE_FIREBASE_AUTH is false. Skipping Firebase token verification.");
        }
      }

      if (!user) {
        console.error("[AUTH GUARD] Guard check failed: No user found or created.");
        throw new UnauthorizedException('User not found');
      }

      // 3. Attach user object to the request so controllers can use req.user
      request.user = user;
      console.log(`[AUTH GUARD] Authentication SUCCESS. Request user attached: ID: ${user.id}, Email: ${user.email}`);
      return true;
    } catch (error: any) {
      console.error("[AUTH GUARD] EXCEPTION occurred inside guard check details:", error?.stack || error?.message || error);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
