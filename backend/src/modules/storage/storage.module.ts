import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { LocalStorageService } from './local-storage.service';

@Module({
  providers: [
    {
      provide: StorageService,
      // If you want to switch to S3 later, you can conditionally use a different class based on an environment variable.
      // e.g., useClass: process.env.USE_S3 === 'true' ? S3StorageService : LocalStorageService,
      useClass: LocalStorageService,
    }
  ],
  exports: [StorageService],
})
export class StorageModule {}
