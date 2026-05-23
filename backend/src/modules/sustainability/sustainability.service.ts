import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RideStatus } from '@prisma/client';

@Injectable()
export class SustainabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(userId: string) {
    // Calculate dynamically from the user's rides as driver and rider
    const ridesAsDriver = await this.prisma.ride.findMany({ where: { driverId: userId } });
    const requestsAsRider = await this.prisma.rideRequest.findMany({ 
      where: { riderId: userId, status: RideStatus.ACCEPTED },
      include: { ride: true }
    });

    const rides_count = ridesAsDriver.length + requestsAsRider.length;
    // Assume 2.5kg CO2 and $15 saved per ride on average
    const co2_saved_kg = rides_count * 2.5;
    const money_saved = rides_count * 15.0;
    const trees_equivalent = co2_saved_kg / 21; // roughly 21kg per tree

    // Filter this month
    const now = new Date();
    const thisMonthDriver = ridesAsDriver.filter(r => r.createdAt.getMonth() === now.getMonth() && r.createdAt.getFullYear() === now.getFullYear());
    const thisMonthRider = requestsAsRider.filter(r => r.createdAt.getMonth() === now.getMonth() && r.createdAt.getFullYear() === now.getFullYear());
    
    const thisMonthCount = thisMonthDriver.length + thisMonthRider.length;

    return {
      money_saved,
      co2_saved_kg,
      rides_count,
      trees_equivalent,
      this_month: {
        money_saved: thisMonthCount * 15.0,
        co2_saved_kg: thisMonthCount * 2.5,
        rides_count: thisMonthCount
      }
    };
  }
}
