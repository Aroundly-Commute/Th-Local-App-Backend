import { Controller, Post, Get, Body, Query, Logger, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketplaceService } from './marketplace.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Controller('marketplace')
export class MarketplaceController {
  private readonly logger = new Logger(MarketplaceController.name);

  constructor(
    private marketplaceService: MarketplaceService,
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  private isValidUuid(id: string): boolean {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  @Post('shops')
  async createShop(@Body() body: { ownerId: string; name: string; description?: string }) {
    this.logger.log(`[POST /shops] ownerId=${body.ownerId} name="${body.name}"`);
    let ownerId = body.ownerId;
    if (!this.isValidUuid(ownerId)) {
      const user = await this.prisma.user.findFirst() || await this.prisma.user.create({
        data: { name: 'Merchant Admin', firebaseUid: 'merchant-' + Date.now(), role: 'merchant' }
      });
      ownerId = user.id;
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: ownerId } });
      if (!userExists) {
        const newUser = await this.prisma.user.create({
          data: { name: 'Merchant Admin', firebaseUid: 'merchant-' + Date.now(), role: 'merchant' }
        });
        ownerId = newUser.id;
      }
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
    this.logger.log(`[POST /products] shopId=${body.shopId} name="${body.name}" price=${body.price} stock=${body.stock}`);
    let shopId = body.shopId;
    if (!this.isValidUuid(shopId)) {
      const shop = await this.prisma.shop.findFirst() || await this.marketplaceService.createShop(
        (await this.prisma.user.findFirst())?.id || (await this.prisma.user.create({ data: { name: 'Merchant Admin', firebaseUid: 'merchant-' + Date.now(), role: 'merchant' } })).id,
        'Default Shop',
        'Auto created default shop'
      );
      shopId = shop.id;
    }
    const result = await this.marketplaceService.addProduct(shopId, {
      name: body.name,
      price: body.price,
      stock: body.stock,
      description: body.description,
      imageUrl: body.imageUrl,
    });
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

  // --- Orders ---

  @Get('orders/shop')
  async getShopOrders(@Query('shopId') shopId: string) {
    this.logger.log(`[GET /orders/shop] shopId=${shopId}`);
    return this.marketplaceService.getOrdersForShop(shopId);
  }

  @Get('orders/customer')
  async getCustomerOrders(@Query('userId') userId: string) {
    this.logger.log(`[GET /orders/customer] userId=${userId}`);
    return this.marketplaceService.getOrdersForCustomer(userId);
  }

  // --- Uploads ---
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Body('directory') directory?: string
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    
    this.logger.log(`[POST /upload] Uploading file: ${file.originalname} to directory: ${directory || 'root'}`);
    const fileUrl = await this.storageService.uploadFile(file, directory || 'products');
    
    return { url: fileUrl };
  }

  // --- Service Providers & Services ---

  @Post('providers')
  async createServiceProvider(@Body() body: { ownerId: string; name: string; services?: string }) {
    this.logger.log(`[POST /providers] ownerId=${body.ownerId} name="${body.name}"`);
    let ownerId = body.ownerId;
    if (!this.isValidUuid(ownerId)) {
      const user = await this.prisma.user.findFirst() || await this.prisma.user.create({
        data: { name: 'Service Provider Admin', firebaseUid: 'provider-' + Date.now(), role: 'provider' }
      });
      ownerId = user.id;
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: ownerId } });
      if (!userExists) {
        const newUser = await this.prisma.user.create({
          data: { name: 'Service Provider Admin', firebaseUid: 'provider-' + Date.now(), role: 'provider' }
        });
        ownerId = newUser.id;
      }
    }
    return this.marketplaceService.createServiceProvider(ownerId, body.name, body.services);
  }

  @Get('providers/search')
  async searchServiceProviders(@Query('q') query: string) {
    this.logger.log(`[GET /providers/search] q="${query || ''}"`);
    return this.marketplaceService.getServiceProviders(query);
  }

  @Post('services')
  async addService(@Body() body: { providerId: string; name: string; price: number; description?: string; category: string }) {
    this.logger.log(`[POST /services] providerId=${body.providerId} name="${body.name}" price=${body.price}`);
    let providerId = body.providerId;
    if (!this.isValidUuid(providerId)) {
      const provider = await this.prisma.serviceProvider.findFirst() || await this.marketplaceService.createServiceProvider(
        (await this.prisma.user.findFirst())?.id || (await this.prisma.user.create({ data: { name: 'Service Provider Admin', firebaseUid: 'provider-' + Date.now(), role: 'provider' } })).id,
        'Default Provider',
        'Auto created default provider'
      );
      providerId = provider.id;
    }
    return this.marketplaceService.addService(providerId, {
      name: body.name,
      price: body.price,
      description: body.description,
      category: body.category,
    });
  }

  @Get('services/search')
  async searchServices(@Query('q') query: string) {
    this.logger.log(`[GET /services/search] q="${query || ''}"`);
    return this.marketplaceService.searchServices(query);
  }

  // --- Bookings ---

  @Post('bookings')
  async createBooking(@Body() body: { userId: string; serviceId: string; timeSlot: string; date: string }) {
    this.logger.log(`[POST /bookings] userId=${body.userId} serviceId=${body.serviceId} timeSlot="${body.timeSlot}"`);
    let userId = body.userId;
    if (!this.isValidUuid(userId)) {
      const user = await this.prisma.user.findFirst() || await this.prisma.user.create({
        data: { name: 'Customer User', firebaseUid: 'cust-' + Date.now(), role: 'passenger' }
      });
      userId = user.id;
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!userExists) {
        const newUser = await this.prisma.user.create({
          data: { name: 'Customer User', firebaseUid: 'cust-' + Date.now(), role: 'passenger' }
        });
        userId = newUser.id;
      }
    }
    return this.marketplaceService.createBooking(userId, body.serviceId, body.timeSlot, body.date);
  }

  @Get('bookings')
  async getUserBookings(@Query('userId') userId: string) {
    this.logger.log(`[GET /bookings] userId=${userId}`);
    return this.marketplaceService.getBookingsForUser(userId);
  }

  // --- Order Creation ---

  @Post('orders')
  async createOrder(@Body() body: { userId: string; items: Array<{ shopProductId: string; quantity: number; priceAtTime: number }> }) {
    this.logger.log(`[POST /orders] userId=${body.userId} items=${body.items?.length || 0}`);
    let userId = body.userId;
    if (!this.isValidUuid(userId)) {
      const user = await this.prisma.user.findFirst() || await this.prisma.user.create({
        data: { name: 'Customer User', firebaseUid: 'cust-' + Date.now(), role: 'passenger' }
      });
      userId = user.id;
    } else {
      const userExists = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!userExists) {
        const newUser = await this.prisma.user.create({
          data: { name: 'Customer User', firebaseUid: 'cust-' + Date.now(), role: 'passenger' }
        });
        userId = newUser.id;
      }
    }
    return this.marketplaceService.createOrder(userId, body.items);
  }
}
