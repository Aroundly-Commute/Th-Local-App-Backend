import { Controller, Post, Body, UnauthorizedException, Get, Request, UseGuards, Patch } from '@nestjs/common';
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
    return {
      ...user,
      rating: 5.0,
      rides_count: 0,
      co2_saved_kg: 0,
      money_saved: 0,
      is_verified: true,
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

  @Patch('profile')
  @UseGuards(FirebaseAuthGuard)
  async updateProfile(@Request() req: any, @Body() body: any) {
    const { name, phoneNumber, avatarUrl, profilePic, gender } = body;
    console.log(`[AUTH] Updating profile for user ${req.user.id}:`, body);

    const updatedUser = await this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name !== undefined ? name : undefined,
        phoneNumber: phoneNumber !== undefined ? phoneNumber : undefined,
        profilePic: (avatarUrl || profilePic) !== undefined ? (avatarUrl || profilePic) : undefined,
        gender: gender !== undefined ? gender : undefined,
      }
    });

    return await this.formatUser(updatedUser);
  }
}
