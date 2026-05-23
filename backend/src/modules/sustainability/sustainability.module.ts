import { Module } from '@nestjs/common';
import { SustainabilityController } from './sustainability.controller';
import { SustainabilityService } from './sustainability.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SustainabilityController],
  providers: [SustainabilityService],
})
export class SustainabilityModule {}
