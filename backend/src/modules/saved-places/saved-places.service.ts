import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavedPlacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.savedPlace.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, data: { label: string; address: string; latitude?: number; longitude?: number }) {
    if (!data.label || !data.address) {
      throw new BadRequestException('Label and address are required');
    }

    return this.prisma.savedPlace.create({
      data: {
        userId,
        label: data.label,
        address: data.address,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
  }

  async delete(userId: string, id: string) {
    const place = await this.prisma.savedPlace.findUnique({
      where: { id },
    });

    if (!place) {
      throw new NotFoundException('Saved place not found');
    }

    if (place.userId !== userId) {
      throw new BadRequestException('Not authorized to delete this saved place');
    }

    return this.prisma.savedPlace.delete({
      where: { id },
    });
  }
}
