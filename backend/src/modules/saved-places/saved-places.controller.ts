import { Controller, Get, Post, Delete, Body, Param, Request, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { SavedPlacesService } from './saved-places.service';

@Controller('saved-places')
@UseGuards(FirebaseAuthGuard)
export class SavedPlacesController {
  constructor(private readonly savedPlacesService: SavedPlacesService) {}

  @Get()
  async list(@Request() req: any) {
    return this.savedPlacesService.list(req.user.id);
  }

  @Post()
  async create(
    @Request() req: any,
    @Body() body: { label: string; address: string; latitude?: number; longitude?: number },
  ) {
    return this.savedPlacesService.create(req.user.id, body);
  }

  @Delete(':id')
  async delete(@Request() req: any, @Param('id') id: string) {
    return this.savedPlacesService.delete(req.user.id, id);
  }
}
