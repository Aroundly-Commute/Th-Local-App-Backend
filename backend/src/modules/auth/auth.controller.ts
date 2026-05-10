import { Controller, Post, Body, UnauthorizedException, Get, Request, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { FirebaseAuthGuard } from './firebase-auth.guard';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

@Controller('auth')
export class AuthController {
  
  private formatUser(user: any) {
    return {
      ...user,
      rating: 5.0,
      rides_count: 0,
      co2_saved_kg: 0,
      money_saved: 0,
      is_verified: true,
      avatar_url: user.profilePic || null,
    };
  }

  @Post('register')
  async register(@Body() body: any) {
    console.log(`[AUTH] Registration attempt for email: ${body.email}`);
    const { email, password, name, role } = body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new UnauthorizedException('Email already in use');

    const passwordHash = await bcrypt.hash(password, 10);
    // Since firebaseUid is unique, we can generate a mock one for local users
    const mockFirebaseUid = `local_${randomUUID()}`;

    console.log(`[AUTH] Creating user in database for ${email}...`);
    const user = await prisma.user.create({
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
    return { access_token: token, user: this.formatUser(user) };
  }

  @Post('login')
  async login(@Body() body: any) {
    console.log(`[AUTH] Login attempt for email: ${body.email}`);
    const { email, password } = body;
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) throw new UnauthorizedException('Invalid email or password');

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    return { access_token: token, user: this.formatUser(user) };
  }

  @Get('me')
  @UseGuards(FirebaseAuthGuard)
  async getMe(@Request() req: any) {
    return this.formatUser(req.user);
  }
}
