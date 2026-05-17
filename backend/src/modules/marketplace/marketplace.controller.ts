import { Controller, Post, Get, Body, Query, Logger } from '@nestjs/common';
import { MarketplaceService } from './marketplace.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('marketplace')
export class MarketplaceController {
  private readonly logger = new Logger(MarketplaceController.name);

  constructor(
    private marketplaceService: MarketplaceService,
    private prisma: PrismaService
  ) {}

  @Post('shops')
  async createShop(@Body() body: { ownerId: string; name: string; description?: string }) {
    this.logger.log(`[POST /shops] ownerId=${body.ownerId} name="${body.name}"`);
    let ownerId = body.ownerId;
    const userExists = await this.prisma.user.findUnique({ where: { id: ownerId } });
    if (!userExists) {
      const newUser = await this.prisma.user.create({
        data: { name: 'Merchant Admin', firebaseUid: 'merchant-' + Date.now(), role: 'merchant' }
      });
      ownerId = newUser.id;
      this.logger.log(`[POST /shops] Created new user for shop: ${ownerId}`);
    }
    const result = await this.marketplaceService.createShop(ownerId, body.name, body.description);
    this.logger.log(`[POST /shops] Created shop id=${result.id}`);
    return result;
  }

  @Get('shops/search')
  async searchShops(@Query('q') query: string) {
    this.logger.log(`[GET /shops/search] q="${query || '(empty)'}"`);
    const results = await this.marketplaceService.getShops(query);
    this.logger.log(`[GET /shops/search] Returned ${Array.isArray(results) ? results.length : 0} shops`);
    return results;
  }

  @Post('products')
  async addProduct(@Body() body: { shopId: string; name: string; price: number; stock: number; description?: string; imageUrl?: string }) {
    this.logger.log(`[POST /products] shopId=${body.shopId} name="${body.name}" price=${body.price} stock=${body.stock} imageUrl=${body.imageUrl || 'none'}`);
    const result = await this.marketplaceService.addProduct(body.shopId, body);
    this.logger.log(`[POST /products] Created shopProduct id=${result.id}`);
    return result;
  }

  @Get('products/search')
  async searchProducts(@Query('q') query: string) {
    this.logger.log(`[GET /products/search] q="${query || '(empty)'}"`);
    const results = await this.marketplaceService.searchProducts(query);
    this.logger.log(`[GET /products/search] Returned ${Array.isArray(results) ? results.length : 0} products`);
    return results;
  }

  @Get('debug/init')
  async initDebugShop() {
    this.logger.log(`[GET /debug/init] Initializing shop...`);
    let user = await this.prisma.user.findFirst();
    if (!user) {
      this.logger.warn(`[GET /debug/init] No user found, creating mock merchant`);
      user = await this.prisma.user.create({
        data: { name: 'Mock Merchant', firebaseUid: 'mock-' + Date.now(), role: 'merchant' }
      });
    }
    let shop = await this.prisma.shop.findFirst({ where: { ownerId: user.id } });
    if (!shop) {
      this.logger.warn(`[GET /debug/init] No shop for user ${user.id}, creating one`);
      shop = await this.marketplaceService.createShop(user.id, 'My Awesome Shop', 'A mock shop');
    }
    this.logger.log(`[GET /debug/init] shopId=${shop.id} ownerId=${user.id}`);
    return { shopId: shop.id, ownerId: user.id };
  }
}
