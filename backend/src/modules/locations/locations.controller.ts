import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { LocationsService } from './locations.service';

@Controller('locations')
@UseGuards(FirebaseAuthGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('suggest')
  async suggestLocations(@Query('q') q: string) {
    return this.locationsService.suggestLocations(q);
  }

  @Get('details')
  async getLocationDetails(@Query('place_id') placeId: string) {
    return this.locationsService.getLocationDetails(placeId);
  }

  @Get('directions')
  async getDirections(
    @Query('origin') origin: string,
    @Query('destination') destination: string,
  ) {
    return this.locationsService.getDirections(origin, destination);
  }
}
