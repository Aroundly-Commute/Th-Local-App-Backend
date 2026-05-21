import { Module } from '@nestjs/common';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceController } from './marketplace.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketplaceGateway } from './marketplace.gateway';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [MarketplaceService, MarketplaceGateway],
  controllers: [MarketplaceController],
})
export class MarketplaceModule {}
