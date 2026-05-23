import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { FirebaseAuthGuard } from './firebase-auth.guard';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [FirebaseAuthGuard],
  exports: [FirebaseAuthGuard],
})
export class AuthModule {}
