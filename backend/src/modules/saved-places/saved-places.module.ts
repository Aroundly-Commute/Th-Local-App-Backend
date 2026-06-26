import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SavedPlacesController } from './saved-places.controller';
import { SavedPlacesService } from './saved-places.service';

@Module({
  imports: [PrismaModule],
  controllers: [SavedPlacesController],
  providers: [SavedPlacesService],
  exports: [SavedPlacesService],
})
export class SavedPlacesModule {}
