import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createReview(fromUserId: string, dto: CreateReviewDto) {
    const { rideId, toUserId, rating, comment } = dto;

    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot rate yourself');
    }

    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // Verify the ride exists
    const ride = await this.prisma.ride.findUnique({
      where: { id: rideId },
      include: { requests: true }
    });

    if (!ride) {
      throw new NotFoundException('Ride not found');
    }

    // Verify both users are participants in this ride:
    // Case 1: reviewer is driver, target is rider
    // Case 2: reviewer is rider, target is driver
    const isReviewerDriver = ride.driverId === fromUserId;
    const isReviewerRider = ride.requests.some(req => req.riderId === fromUserId && req.status === 'ACCEPTED');

    const isTargetDriver = ride.driverId === toUserId;
    const isTargetRider = ride.requests.some(req => req.riderId === toUserId && req.status === 'ACCEPTED');

    if (!((isReviewerDriver && isTargetRider) || (isReviewerRider && isTargetDriver))) {
      throw new BadRequestException('Both users must be participants of the same accepted ride to rate each other');
    }

    // Check if review already exists
    const existing = await this.prisma.review.findUnique({
      where: {
        fromUserId_toUserId_rideId: {
          fromUserId,
          toUserId,
          rideId
        }
      }
    });

    if (existing) {
      throw new BadRequestException('You have already rated this peer for this ride');
    }

    // Create the review
    const review = await this.prisma.review.create({
      data: {
        fromUserId,
        toUserId,
        rideId,
        rating,
        comment
      }
    });

    // Recalculate target user's average rating
    const aggregate = await this.prisma.review.aggregate({
      where: { toUserId },
      _avg: { rating: true },
      _count: { rating: true }
    });

    await this.prisma.user.update({
      where: { id: toUserId },
      data: {
        rating: aggregate._avg.rating ?? 5.0,
        ratingCount: aggregate._count.rating ?? 0
      }
    });

    this.logger.log(`Created review from User ${fromUserId} to User ${toUserId}. New average: ${aggregate._avg.rating ?? 5.0}`);

    return review;
  }
}
