import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RidesModule } from './modules/rides/rides.module';
import { MatchmakingModule } from './modules/matchmaking/matchmaking.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthController } from './modules/auth/auth.controller';
import { AliasController } from './alias.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RidesModule,
    MatchmakingModule,
  ],
  controllers: [AuthController, AliasController],
})
export class AppModule {}

