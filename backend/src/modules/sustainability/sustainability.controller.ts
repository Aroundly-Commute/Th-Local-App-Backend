import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { SustainabilityService } from './sustainability.service';

@Controller('sustainability')
@UseGuards(FirebaseAuthGuard)
export class SustainabilityController {
  constructor(private readonly sustainabilityService: SustainabilityService) {}

  @Get('me')
  async getSustainability(@Request() req: any) {
    return this.sustainabilityService.getMetrics(req.user.id);
  }
}
