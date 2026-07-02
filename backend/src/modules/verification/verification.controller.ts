import { Controller, Post, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { VerificationService } from './verification.service';

@Controller('verification')
@UseGuards(FirebaseAuthGuard)
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  async sendCode(
    @Request() req: any,
    @Body() body: { email: string },
  ) {
    const userId = req.user.id;
    await this.verificationService.sendVerificationCode(userId, body.email);
    return { success: true, message: 'Verification code sent successfully' };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyCode(
    @Request() req: any,
    @Body() body: { email: string; code: string },
  ) {
    const userId = req.user.id;
    const user = await this.verificationService.verifyCode(userId, body.email, body.code);
    return { success: true, user, message: 'Corporate email verified successfully' };
  }
}
