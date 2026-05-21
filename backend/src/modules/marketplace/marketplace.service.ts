import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MeiliSearch } from 'meilisearch';

@Injectable()
export class MarketplaceService implements OnModuleInit {
  private meiliClient: MeiliSearch;

  constructor(private prisma: PrismaService) {
    this.meiliClient = new MeiliSearch({
      host: process.env.MEILI_HOST || 'http://localhost:7700',
      apiKey: process.env.MEILI_MASTER_KEY || 'masterKey',
    });
  }

  async onModuleInit() {
    // Ensure indexes exist
    await this.meiliClient.index('products').updateSettings({
      searchableAttributes: ['name', 'description', 'shopName'],
    });
    await this.meiliClient.index('shops').updateSettings({
      searchableAttributes: ['name', 'description', 'ownerName'],
    });
  }

  // --- Shop Methods ---

  async createShop(ownerId: string, name: string, description?: string) {
    const shop = await this.prisma.shop.create({
      data: {
        ownerId,
        name,
        description,
      },
      include: { owner: true }
    });

    // Index in Meilisearch
    await this.meiliClient.index('shops').addDocuments([{
      id: shop.id,
      name: shop.name,
      description: shop.description,
      ownerName: shop.owner.name,
    }]);

    return shop;
  }

  async getShops(query: string) {
    if (!query) return this.prisma.shop.findMany({ include: { owner: true } });
    
    const searchResults = await this.meiliClient.index('shops').search(query);
    const shopIds = searchResults.hits.map(h => h.id as string);

    return this.prisma.shop.findMany({
      where: { id: { in: shopIds } },
      include: { owner: true }
    });
  }

  // --- Product Methods ---

  async addProduct(shopId: string, data: { name: string; price: number; stock: number; description?: string; imageUrl?: string }) {
    // 1. Find or create global Product entry
    let product = await this.prisma.product.findFirst({ where: { name: data.name } });
    if (!product) {
      product = await this.prisma.product.create({
        data: { name: data.name, description: data.description, imageUrl: data.imageUrl }
      });
    } else {
      product = await this.prisma.product.update({
        where: { id: product.id },
        data: { imageUrl: data.imageUrl, description: data.description || product.description }
      });
    }

    // 2. Link to Shop
    const shopProduct = await this.prisma.shopProduct.create({
      data: {
        shopId,
        productId: product.id,
        price: data.price,
        stock: data.stock,
      },
      include: { shop: true, product: true }
    });

    // 3. Index in Meilisearch
    await this.meiliClient.index('products').addDocuments([{
      id: shopProduct.id,
      name: product.name,
      description: data.description || product.description,
      price: data.price,
      imageUrl: product.imageUrl,
      shopName: shopProduct.shop.name,
    }]);

    return shopProduct;
  }

  async searchProducts(query: string) {
    if (!query) return this.prisma.shopProduct.findMany({ include: { product: true, shop: true } });

    const searchResults = await this.meiliClient.index('products').search(query);
    const shopProductIds = searchResults.hits.map(h => h.id as string);

    return this.prisma.shopProduct.findMany({
      where: { id: { in: shopProductIds } },
      include: { product: true, shop: true }
    });
  }

  // --- Order Methods ---

  async getOrdersForShop(shopId: string) {
    return this.prisma.order.findMany({
      where: {
        items: {
          some: {
            shopProduct: {
              shopId: shopId
            }
          }
        }
      },
      include: {
        items: {
          include: {
            shopProduct: {
              include: {
                product: true
              }
            }
          }
        },
        user: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getOrdersForCustomer(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            shopProduct: {
              include: {
                product: true,
                shop: true
              }
            }
          }
        },
        user: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }
  // --- Service Provider Methods ---

  async createServiceProvider(ownerId: string, name: string, services?: string) {
    return this.prisma.serviceProvider.create({
      data: {
        ownerId,
        name,
        services,
      },
      include: { owner: true }
    });
  }

  async getServiceProviders(query: string) {
    if (!query) return this.prisma.serviceProvider.findMany({ include: { owner: true } });
    return this.prisma.serviceProvider.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { services: { contains: query, mode: 'insensitive' } }
        ]
      },
      include: { owner: true }
    });
  }

  // --- Service Methods ---

  async addService(providerId: string, data: { name: string; price: number; description?: string; category: string }) {
    return this.prisma.service.create({
      data: {
        providerId,
        name: data.name,
        price: data.price,
        description: data.description,
        category: data.category,
      },
      include: { provider: true }
    });
  }

  async searchServices(query: string) {
    if (!query) return this.prisma.service.findMany({ include: { provider: true } });
    return this.prisma.service.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } }
        ]
      },
      include: { provider: true }
    });
  }

  // --- Booking Methods ---

  async createBooking(userId: string, serviceId: string, timeSlot: string, date: string) {
    return this.prisma.booking.create({
      data: {
        userId,
        serviceId,
        timeSlot,
        date,
      },
      include: { service: { include: { provider: true } }, user: true }
    });
  }

  async getBookingsForUser(userId: string) {
    return this.prisma.booking.findMany({
      where: { userId },
      include: { service: { include: { provider: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  // --- Order Creation Methods ---

  async createOrder(userId: string, items: Array<{ shopProductId: string; quantity: number; priceAtTime: number }>) {
    const totalAmount = items.reduce((sum, item) => sum + item.priceAtTime * item.quantity, 0);
    return this.prisma.order.create({
      data: {
        userId,
        totalAmount,
        status: 'PENDING',
        items: {
          create: items.map(item => ({
            shopProductId: item.shopProductId,
            quantity: item.quantity,
            priceAtTime: item.priceAtTime
          }))
        }
      },
      include: {
        items: {
          include: {
            shopProduct: {
              include: { product: true, shop: true }
            }
          }
        },
        user: true
      }
    });
  }
}
