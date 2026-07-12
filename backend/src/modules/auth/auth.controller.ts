import { Controller, Post, Body, UnauthorizedException, Get, Request, UseGuards, Patch, BadRequestException, Param, NotFoundException, Query } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from './sms.service';
import * as admin from 'firebase-admin';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
  ) {}
  
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
      rating: user.rating ?? 5.0,
      rides_count: ridesCount,
      co2_saved_kg: co2Saved,
      money_saved: moneySaved,
      is_verified: user.isVerified || false,
      corporate_email: user.corporateEmail || null,
      avatar_url: user.profilePic || null,
      vehicle: vehicle || null,
    };
  }

  @Post('register')
  async register(@Body() body: any) {
    console.log(`[AUTH] Registration attempt for email: ${body.email}`);
    const { email, password, name, role } = body;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new UnauthorizedException('Email already in use');

    const passwordHash = await bcrypt.hash(password, 10);
    // Since firebaseUid is unique, we can generate a mock one for local users
    const mockFirebaseUid = `local_${randomUUID()}`;

    console.log(`[AUTH] Creating user in database for ${email}...`);
    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        role: role || 'passenger',
        passwordHash,
        firebaseUid: mockFirebaseUid,
      }
    });
    console.log(`[AUTH] User created successfully. ID: ${user.id}`);

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return { access_token: token, user: await this.formatUser(user) };
  }

  @Post('login')
  async login(@Body() body: any) {
    console.log(`[AUTH] Login attempt for email: ${body.email}`);
    const { email, password } = body;
    const user = await this.prisma.user.findUnique({ where: { email } });
    
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid email or password');

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return { access_token: token, user: await this.formatUser(user) };
  }

  @Get('me')
  @UseGuards(FirebaseAuthGuard)
  async getMe(@Request() req: any) {
    return await this.formatUser(req.user);
  }

  @Get('users/:id')
  @UseGuards(FirebaseAuthGuard)
  async getUserProfile(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id }
    });
    if (!user) {
      throw new NotFoundException('User profile not found');
    }
    return await this.formatUser(user);
  }

  @Get('check-phone')
  @UseGuards(FirebaseAuthGuard)
  async checkPhone(@Request() req: any, @Query('phoneNumber') phoneNumber: string) {
    if (!phoneNumber) {
      throw new BadRequestException('Phone number is required');
    }
    const cleanPhone = phoneNumber.trim();
    const formatted = cleanPhone.startsWith('+') ? cleanPhone : `+91${cleanPhone}`;
    
    const existing = await this.prisma.user.findFirst({
      where: {
        phoneNumber: formatted,
        id: { not: req.user.id }
      }
    });
    
    return { exists: !!existing };
  }

  @Post('vehicle')
  @UseGuards(FirebaseAuthGuard)
  async saveVehicle(@Request() req: any, @Body() body: any) {
    const { vehicleNumber, type, capacity, fuelType } = body;
    const vehicle = await this.prisma.vehicle.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        vehicleNumber,
        type: type?.toUpperCase() || 'CAR',
        capacity: Number(capacity) || 5,
        fuelType: fuelType || 'Petrol',
      },
      update: {
        vehicleNumber,
        type: type?.toUpperCase() || 'CAR',
        capacity: Number(capacity) || 5,
        fuelType: fuelType || 'Petrol',
      }
    });
    return vehicle;
  }

  @Get('vehicle')
  @UseGuards(FirebaseAuthGuard)
  async getVehicle(@Request() req: any) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { userId: req.user.id }
    });
    return vehicle;
  }

  @Post('otp/send')
  async sendOtp(@Body() body: { phoneNumber: string }) {
    const { phoneNumber } = body;
    if (!phoneNumber) {
      throw new UnauthorizedException('Phone number is required');
    }

    const cleanPhone = phoneNumber.trim();

    // Generate random 6-digit verification code
    const code = this.smsService.generateOtpCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiration

    console.log(`[OTP] Generating verification code ${code} for phone: ${cleanPhone}...`);

    // Save OTP transaction in VerificationCode table
    await this.prisma.verificationCode.create({
      data: {
        phoneNumber: cleanPhone,
        code,
        expiresAt,
      },
    });

    // Send the SMS (either Twilio or dev log)
    const success = await this.smsService.sendOtp(cleanPhone, code);
    if (!success) {
      throw new UnauthorizedException('Failed to dispatch SMS verification code');
    }

    return { success: true, message: 'OTP verification code successfully dispatched' };
  }

  @Post('otp/verify')
  async verifyOtp(@Body() body: { phoneNumber: string; code: string }) {
    const { phoneNumber, code } = body;
    if (!phoneNumber || !code) {
      throw new UnauthorizedException('Phone number and verification code are required');
    }

    const cleanPhone = phoneNumber.trim();
    const cleanCode = code.trim();

    console.log(`[OTP] Verifying code ${cleanCode} for phone: ${cleanPhone}...`);

    // Verify code exists, matches, and has not expired
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        phoneNumber: cleanPhone,
        code: cleanCode,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' }, // Get latest request first
    });

    if (!record) {
      throw new UnauthorizedException('Invalid or expired OTP verification code');
    }

    // Clean up code to prevent replay attacks
    await this.prisma.verificationCode.deleteMany({
      where: { phoneNumber: cleanPhone },
    });

    // Get or Create user
    let user = await this.prisma.user.findUnique({
      where: { phoneNumber: cleanPhone },
    });

    if (!user) {
      console.log(`[OTP] User not found for ${cleanPhone}. Automatically registering passenger profile...`);
      const mockFirebaseUid = `phone_${randomUUID()}`;
      
      user = await this.prisma.user.create({
        data: {
          phoneNumber: cleanPhone,
          name: `Aroundler ${cleanPhone.slice(-4)}`,
          role: 'passenger',
          firebaseUid: mockFirebaseUid,
        },
      });
    }

    // Generate local access JWT
    const token = jwt.sign(
      { sub: user.id, phoneNumber: user.phoneNumber },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    return {
      access_token: token,
      user: await this.formatUser(user),
    };
  }

  @Post('google')
  async loginWithGoogleBody(@Body() body: { idToken: string; email?: string; name?: string; profilePic?: string }) {
    const { idToken, email, name, profilePic } = body;
    if (!idToken) {
      throw new UnauthorizedException('Google ID token is required');
    }

    console.log(`[AUTH] Google Sign-In request received...`);

    let user: any = null;

    // Local sandbox dev testing
    if (idToken === 'local_google_mock_id_token_123456') {
      console.log(`[AUTH] Local Mock Google login matched. Syncing profile: ${email || 'sarah.google@gmail.com'}`);
      
      const mockEmail = email || 'sarah.google@gmail.com';
      const mockName = name || 'Sarah Google';
      const mockPic = profilePic || 'https://images.unsplash.com/photo-1494790108377-be9c29b29330';

      user = await this.prisma.user.findUnique({ where: { email: mockEmail } });
      if (!user) {
        const mockFirebaseUid = `google_${randomUUID()}`;
        user = await this.prisma.user.create({
          data: {
            email: mockEmail,
            name: mockName,
            profilePic: mockPic,
            firebaseUid: mockFirebaseUid,
            role: 'passenger',
          },
        });
      }
    } else {
      // Live Firebase validation
      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        user = await this.prisma.user.findUnique({
          where: { firebaseUid: decodedToken.uid },
        });

        if (!user && decodedToken.email) {
          user = await this.prisma.user.findUnique({
            where: { email: decodedToken.email },
          });
          if (user) {
            user = await this.prisma.user.update({
              where: { id: user.id },
              data: { firebaseUid: decodedToken.uid }
            });
            console.log(`[AUTH] Linked existing user ${decodedToken.email} with firebaseUid ${decodedToken.uid} in google-route`);
          }
        }

        if (!user && decodedToken.phone_number) {
          user = await this.prisma.user.findUnique({
            where: { phoneNumber: decodedToken.phone_number },
          });
          if (user) {
            user = await this.prisma.user.update({
              where: { id: user.id },
              data: { firebaseUid: decodedToken.uid }
            });
            console.log(`[AUTH] Linked existing user ${decodedToken.phone_number} with firebaseUid ${decodedToken.uid} in google-route`);
          }
        }

        if (!user) {
          user = await this.prisma.user.create({
            data: {
              firebaseUid: decodedToken.uid,
              email: decodedToken.email || null,
              phoneNumber: decodedToken.phone_number || null,
              name: decodedToken.name || decodedToken.phone_number || 'Carpool User',
              profilePic: decodedToken.picture || null,
            },
          });
        }
      } catch (err: any) {
        console.error('[AUTH] Firebase Google Token verify exception:', err?.message || err);
        throw new UnauthorizedException('Invalid Google authentication credentials');
      }
    }

    // Issue local session token
    const token = jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' },
    );

    return {
      access_token: token,
      user: await this.formatUser(user),
    };
  }

  @Patch('profile/phone')
  @UseGuards(FirebaseAuthGuard)
  async verifyAndLinkPhone(@Request() req: any, @Body() body: { phoneNumber: string; code: string }) {
    const { phoneNumber, code } = body;
    if (!phoneNumber || !code) {
      throw new BadRequestException('Phone number and OTP code are required');
    }
    const cleanPhone = phoneNumber.trim();
    const cleanCode = code.trim();

    // Verify OTP code in DB
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        phoneNumber: cleanPhone,
        code: cleanCode,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired OTP verification code');
    }

    // Clean up
    await this.prisma.verificationCode.deleteMany({
      where: { phoneNumber: cleanPhone },
    });

    // Check if phone number is already taken by another account
    const existing = await this.prisma.user.findFirst({
      where: {
        phoneNumber: cleanPhone,
        id: { not: req.user.id }
      }
    });
    if (existing) {
      throw new BadRequestException('This phone number is already registered with another account');
    }

    // Update phone number of current user
    const updatedUser = await this.prisma.user.update({
      where: { id: req.user.id },
      data: { phoneNumber: cleanPhone }
    });

    return await this.formatUser(updatedUser);
  }

  @Patch('profile')
  @UseGuards(FirebaseAuthGuard)
  async updateProfile(@Request() req: any, @Body() body: any) {
    const { name, phoneNumber, avatarUrl, profilePic, gender, society, workplace, bio } = body;
    console.log(`[AUTH] Updating profile for user ${req.user.id}:`, body);

    if (phoneNumber !== undefined && phoneNumber !== null && phoneNumber !== '') {
      const trimmed = phoneNumber.trim();
      const cleanPhone = trimmed.startsWith('+') ? trimmed : `+91${trimmed}`;
      if (cleanPhone !== req.user.phoneNumber) {
        throw new BadRequestException('Phone number must be verified through the OTP verification flow');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name !== undefined ? name : undefined,
        profilePic: (avatarUrl || profilePic) !== undefined ? (avatarUrl || profilePic) : undefined,
        gender: gender !== undefined ? gender : undefined,
        society: society !== undefined ? society : undefined,
        workplace: workplace !== undefined ? workplace : undefined,
        bio: bio !== undefined ? bio : undefined,
      }
    });

    return await this.formatUser(updatedUser);
  }
  @Get('check-email')
  @UseGuards(FirebaseAuthGuard)
  async checkEmail(@Request() req: any, @Query('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    const cleanEmail = email.trim().toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: {
        email: cleanEmail,
        id: { not: req.user.id }
      }
    });

    return { exists: !!existing };
  }

  @Post('email/send-otp')
  @UseGuards(FirebaseAuthGuard)
  async sendEmailOtp(@Request() req: any, @Body() body: { email: string }) {
    const { email } = body;
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if the email is already taken by another account
    const existing = await this.prisma.user.findFirst({
      where: {
        email: cleanEmail,
        id: { not: req.user.id }
      }
    });
    if (existing) {
      throw new BadRequestException('This email is already registered with another account');
    }

    // Generate random 6-digit verification code
    const code = this.smsService.generateOtpCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiration

    console.log(`[EMAIL OTP] Generating verification code ${code} for email: ${cleanEmail}...`);

    // Store OTP using the email as identifier (reusing VerificationCode table with email: prefix)
    await this.prisma.verificationCode.create({
      data: {
        phoneNumber: `email:${cleanEmail}`,
        code,
        expiresAt,
      },
    });

    // Send email via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    const sender = process.env.RESEND_FROM_EMAIL || 'Aroundly Verification <support@aroundly.in>';
    const subject = 'Aroundly Email Verification Code';

    const htmlBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #F8FBFB; padding: 40px 20px; text-align: center;">
        <div style="max-width: 500px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2F0EF; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(10, 22, 40, 0.03);">
          <h2 style="color: #0A1628; margin-top: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Verify Your Email</h2>
          <p style="color: #1A4060; font-size: 15px; line-height: 24px; margin-bottom: 24px;">
            Use the 6-digit verification code below to verify your email address on Aroundly:
          </p>
          <div style="background-color: #E8FBF9; border-radius: 12px; padding: 16px; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #00B5A0;">${code}</span>
          </div>
          <p style="color: #6AA8C0; font-size: 13px; line-height: 20px;">
            This code is valid for <strong>5 minutes</strong>. If you did not request this, you can safely ignore this email.
          </p>
          <hr style="border: 0; border-top: 1px solid #CCF7F3; margin: 32px 0 20px 0;" />
          <p style="color: #1A4060; font-size: 12px;">Aroundly Carpooling · Keep Commuting Green</p>
        </div>
      </div>
    `;

    if (!resendApiKey) {
      console.warn(`
┌──────────────────────────────────────────────────────────┐
│             [RESEND EMAIL DEV SANDBOX]                   │
├──────────────────────────────────────────────────────────┤
│ Email:    ${cleanEmail}
│ OTP Code: ${code}
│ Expiry:   5 Minutes                                      │
├──────────────────────────────────────────────────────────┤
│ To send real emails, configure RESEND_API_KEY in .env    │
└──────────────────────────────────────────────────────────┘
      `);
    } else {
      try {
        console.log(`[RESEND] Sending email OTP to ${cleanEmail}...`);

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
          console.log(`[RESEND] Email OTP successfully dispatched. Message ID: ${data.id}`);
        } else {
          console.error(`[RESEND] API error (Status ${response.status}):`, data);
          throw new Error('Failed to dispatch verification email');
        }
      } catch (err: any) {
        console.error(`[RESEND] Failed to send email to ${cleanEmail}:`, err?.message || err);
        throw new BadRequestException('Failed to send verification email. Please try again.');
      }
    }

    return { success: true, message: 'Email verification code sent successfully' };
  }

  @Post('email/verify-otp')
  @UseGuards(FirebaseAuthGuard)
  async verifyEmailOtp(@Request() req: any, @Body() body: { email: string; code: string }) {
    const { email, code } = body;
    if (!email || !code) {
      throw new BadRequestException('Email and verification code are required');
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.trim();
    const identifier = `email:${cleanEmail}`;

    console.log(`[EMAIL OTP] Verifying code ${cleanCode} for email: ${cleanEmail}...`);

    // Verify code exists, matches, and has not expired
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        phoneNumber: identifier,
        code: cleanCode,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    // Clean up code to prevent replay attacks
    await this.prisma.verificationCode.deleteMany({
      where: { phoneNumber: identifier },
    });

    // Check if email is already taken by another account (double-check)
    const existing = await this.prisma.user.findFirst({
      where: {
        email: cleanEmail,
        id: { not: req.user.id }
      }
    });
    if (existing) {
      throw new BadRequestException('This email is already registered with another account');
    }

    // Update the user's email
    const updatedUser = await this.prisma.user.update({
      where: { id: req.user.id },
      data: { email: cleanEmail }
    });

    console.log(`[EMAIL OTP] Email successfully verified and updated to ${cleanEmail} for user ${req.user.id}`);

    return await this.formatUser(updatedUser);
  }

  @Patch('fcm-token')
  @UseGuards(FirebaseAuthGuard)
  async updateFcmToken(@Request() req: any, @Body() body: { fcmToken: string }) {
    const { fcmToken } = body;
    console.log(`[AUTH] Updating FCM token for user ${req.user.id}:`, fcmToken);

    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { fcmToken: fcmToken || null },
    });

    return { success: true };
  }

  @Post('delete-account')
  @UseGuards(FirebaseAuthGuard)
  async deleteAccount(@Request() req: any) {
    const userId = req.user.id;
    console.log(`[AUTH] Deleting/Anonymizing user account for user: ${userId}`);

    // Delete associated cleanable tables first to prevent constraint violations
    await this.prisma.vehicle.deleteMany({ where: { userId } }).catch(() => {});
    await this.prisma.parkingBooking.deleteMany({ where: { userId } }).catch(() => {});
    await this.prisma.parkingSpot.deleteMany({ where: { ownerId: userId } }).catch(() => {});

    // Try to delete the user fully
    try {
      await this.prisma.user.delete({ where: { id: userId } });
      console.log(`[AUTH] User record ${userId} deleted fully from DB.`);
    } catch (err) {
      console.log(`[AUTH] Constraints found. Anonymizing user profile for ${userId} instead...`);
      // Fallback: Anonymize to satisfy constraint rules safely
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted User',
          email: null,
          phoneNumber: null,
          profilePic: null,
          passwordHash: null,
          gender: null,
          firebaseUid: `deleted_${userId}_${Date.now()}`,
        },
      });
    }

    return { success: true, message: 'Account and associated data deleted successfully' };
  }
}
