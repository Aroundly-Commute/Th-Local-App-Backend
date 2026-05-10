import * as dotenv from 'dotenv';
dotenv.config();

import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { setupChatWs } from './chat.ws';

import * as admin from 'firebase-admin';

// Initialize Firebase Admin (Using Default credentials or Env Variables)
// In production, you'll need the service account credentials in env.
if (process.env.FIREBASE_PROJECT_ID) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
} else {
  // Try to initialize using application default credentials (if GOOGLE_APPLICATION_CREDENTIALS is set)
  try {
    admin.initializeApp();
  } catch (e) {
    console.warn("Firebase Admin failed to initialize. Make sure FIREBASE_PROJECT_ID is set.");
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalInterceptors(new LoggingInterceptor());
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

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const server = await app.listen(port);
  setupChatWs(app.getHttpServer());
}

bootstrap();
