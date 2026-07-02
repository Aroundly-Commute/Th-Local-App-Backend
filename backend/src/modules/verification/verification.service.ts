import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  // Common public/generic email domains to block for corporate verification
  private readonly publicDomains = new Set([
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'icloud.com',
    'aol.com',
    'zoho.com',
    'yandex.com',
    'mail.com',
    'gmx.com',
    'protonmail.com',
    'proton.me',
    'live.com',
  ]);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Helper to format user payload matching AuthController schema
   */
  private async formatUser(user: any) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { userId: user.id }
    });

    const ridesAsDriver = await this.prisma.ride.findMany({ where: { driverId: user.id } });
    const requestsAsRider = await this.prisma.rideRequest.findMany({ 
      where: { riderId: user.id, status: 'ACCEPTED' as any }
    });

    const ridesCount = ridesAsDriver.length + requestsAsRider.length;
    const co2Saved = ridesCount * 2.5;
    const moneySaved = ridesCount * 15.0;

    return {
      ...user,
      rating: 5.0,
      rides_count: ridesCount,
      co2_saved_kg: co2Saved,
      money_saved: moneySaved,
      is_verified: user.isVerified || false,
      corporate_email: user.corporateEmail || null,
      avatar_url: user.profilePic || null,
      vehicle: vehicle || null,
    };
  }

  /**
   * Validates if the email domain is corporate/business.
   */
  public isCorporateEmail(email: string): boolean {
    const cleanEmail = email.trim().toLowerCase();
    const domain = cleanEmail.split('@')[1];
    
    if (!domain) return false;
    return !this.publicDomains.has(domain);
  }

  /**
   * Generates, stores, and emails a 6-digit OTP code to the corporate email.
   */
  async sendVerificationCode(userId: string, email: string): Promise<boolean> {
    const cleanEmail = email.trim().toLowerCase();

    // 1. Domain Check
    if (!this.isCorporateEmail(cleanEmail)) {
      throw new BadRequestException('Please use a corporate or workplace email address. Public domains like Gmail, Yahoo, etc. are not supported.');
    }

    // 2. Generate 6-digit OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // 3. Save to EmailVerificationCode database table
    await this.prisma.emailVerificationCode.create({
      data: {
        email: cleanEmail,
        code,
        expiresAt,
      },
    });

    // 4. Send Email via Resend REST API
    const resendApiKey = process.env.RESEND_API_KEY;
    const sender = process.env.RESEND_FROM_EMAIL || 'Aroundly Verification <support@aroundly.in>';
    const subject = 'Aroundly Corporate Email Verification Code';
    
    const htmlBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F8FBFB; padding: 40px 20px; text-align: center;">
        <div style="max-width: 500px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2F0EF; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(10, 22, 40, 0.03);">
          <h2 style="color: #0A1628; margin-top: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Verify Your Identity</h2>
          <p style="color: #1A4060; font-size: 15px; line-height: 24px; margin-bottom: 24px;">
            Thank you for helping us keep Aroundly secure. Use the 6-digit verification code below to verify your corporate email:
          </p>
          <div style="background-color: #E8FBF9; border-radius: 12px; padding: 16px; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #00B5A0;">${code}</span>
          </div>
          <p style="color: #6AA8C0; font-size: 13px; line-height: 20px;">
            This OTP is valid for <strong>10 minutes</strong>. If you did not request this code, you can safely ignore this email.
          </p>
          <hr style="border: 0; border-top: 1px solid #CCF7F3; margin: 32px 0 20px 0;" />
          <p style="color: #1A4060; font-size: 12px;">Aroundly Carpooling · Keep Commuting Green</p>
        </div>
      </div>
    `;

    if (!resendApiKey) {
      this.logger.warn(`
┌──────────────────────────────────────────────────────────┐
│             [RESEND EMAIL DEV SANDBOX]                   │
├──────────────────────────────────────────────────────────┤
│ Corporate Email: ${cleanEmail}                           │
│ OTP Code:        ${code}                                 │
│ Expiry:          10 Minutes                              │
├──────────────────────────────────────────────────────────┤
│ To send real emails, configure this in your backend .env:│
│ - RESEND_API_KEY                                         │
└──────────────────────────────────────────────────────────┘
      `);
      return true;
    }

    try {
      this.logger.log(`[RESEND] Sending OTP code to ${cleanEmail}...`);
      
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: sender,
          to: [cleanEmail],
          subject: subject,
          html: htmlBody,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        this.logger.log(`[RESEND] Email successfully dispatched. Message ID: ${data.id}`);
        return true;
      } else {
        this.logger.error(`[RESEND] API error (Status ${response.status}):`, data);
        throw new InternalServerErrorException('Failed to dispatch verification email');
      }
    } catch (err: any) {
      this.logger.error(`[RESEND] Failed to send email to ${cleanEmail}:`, err?.message || err);
      throw new InternalServerErrorException(err?.message || 'Failed to dispatch verification email');
    }
  }

  /**
   * Verifies the OTP code server-side and marks user as verified.
   */
  async verifyCode(userId: string, email: string, code: string): Promise<any> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.trim();

    this.logger.log(`[VERIFY] Validating corporate verification code ${cleanCode} for ${cleanEmail}...`);

    // 1. Check code matching, not expired
    const record = await this.prisma.emailVerificationCode.findFirst({
      where: {
        email: cleanEmail,
        code: cleanCode,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' }, // Latest code first
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    // 2. Prevent duplicate reuse (replay attack prevention)
    await this.prisma.emailVerificationCode.deleteMany({
      where: { email: cleanEmail },
    });

    // 3. Check if email is already verified by another user
    const existing = await this.prisma.user.findFirst({
      where: {
        corporateEmail: cleanEmail,
        id: { not: userId }
      }
    });

    if (existing) {
      throw new BadRequestException('This corporate email is already verified on another account.');
    }

    // 4. Mark user as verified
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        corporateEmail: cleanEmail,
        isVerified: true,
      },
    });

    this.logger.log(`[VERIFY] User ${userId} successfully verified with corporate email ${cleanEmail}`);

    return this.formatUser(updatedUser);
  }
}
