import * as dotenv from 'dotenv';
dotenv.config();

import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import * as express from 'express';
import * as path from 'path';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ChatGateway } from './modules/chat/chat.gateway';

import * as admin from 'firebase-admin';

// Initialize Firebase Admin (Using Default credentials or Env Variables)
// In production, you'll need the service account credentials in env.
if (process.env.FIREBASE_PROJECT_ID) {
  try {
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;
    const privateKey = rawKey
      ? rawKey.replace(/\\n/g, '\n').replace(/^"|"$/g, '').trim()
      : undefined;

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
    });
    console.log("[FIREBASE] Admin SDK successfully initialized!");
  } catch (err: any) {
    console.error("[FIREBASE] Error initializing Admin SDK certificate:", err?.message || err);
  }
} else {
  // Try to initialize using application default credentials (if GOOGLE_APPLICATION_CREDENTIALS is set)
  try {
    admin.initializeApp();
  } catch (e) {
    console.warn("Firebase Admin failed to initialize. Make sure FIREBASE_PROJECT_ID is set.");
  }
}

async function bootstrap() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  
  console.log("=========================================");
  console.log("       BACKEND ENVIRONMENT CONFIG        ");
  console.log("=========================================");
  console.log("PORT:", port);
  console.log("NODE_ENV:", process.env.NODE_ENV);
  const dbUrl = process.env.DATABASE_URL || "";
  console.log("DATABASE_URL:", dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : "NOT SET");
  console.log("USE_FIREBASE_AUTH:", process.env.USE_FIREBASE_AUTH);
  console.log("FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID);
  console.log("FIREBASE_CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
  console.log("FIREBASE_PRIVATE_KEY SET?:", privateKey ? "YES (Length: " + privateKey.length + ")" : "NO");
  if (privateKey) {
    console.log("FIREBASE_PRIVATE_KEY STARTS WITH:", JSON.stringify(privateKey.substring(0, 30)));
    console.log("FIREBASE_PRIVATE_KEY ENDS WITH:", JSON.stringify(privateKey.substring(privateKey.length - 20)));
  }
  console.log("JWT_SECRET SET?:", process.env.JWT_SECRET ? "YES" : "NO");
  console.log("=========================================");

  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  
  // Serve static files from the uploads directory
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  app.setGlobalPrefix('api');

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const server = await app.listen(port);
  
  // Retrieve the modular WebSocket gateway and bind it to the HTTP server
  const chatGateway = app.get(ChatGateway);
  chatGateway.setupChatWs(app.getHttpServer());
}

bootstrap();
