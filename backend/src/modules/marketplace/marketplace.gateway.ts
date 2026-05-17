import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class MarketplaceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MarketplaceGateway.name);

  constructor(private prisma: PrismaService) {}

  handleConnection(client: Socket) {
    this.logger.log(`[WS] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`[WS] Client disconnected: ${client.id}`);
  }

  // Merchant joins a room specific to their shop to receive orders
  @SubscribeMessage('joinShopRoom')
  handleJoinShopRoom(@ConnectedSocket() client: Socket, @MessageBody() shopId: string) {
    const room = `shop_${shopId}`;
    client.join(room);
    this.logger.log(`[WS] joinShopRoom: client=${client.id} room=${room}`);
    const roomSize = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    this.logger.log(`[WS] Room ${room} now has ${roomSize} member(s)`);
    return { event: 'joined', data: shopId };
  }

  // Customer joins a room specific to their user ID
  @SubscribeMessage('joinCustomerRoom')
  handleJoinCustomerRoom(@ConnectedSocket() client: Socket, @MessageBody() customerId: string) {
    const room = `customer_${customerId}`;
    client.join(room);
    this.logger.log(`[WS] joinCustomerRoom: client=${client.id} room=${room}`);
    return { event: 'joined', data: customerId };
  }

  // Place an order (from Customer)
  @SubscribeMessage('placeOrder')
  async handlePlaceOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { shopId: string; customerId: string; items: any[]; totalAmount: number }
  ) {
    this.logger.log(`[WS] placeOrder from client=${client.id} shopId=${data.shopId} customerId=${data.customerId} total=${data.totalAmount} items=${data.items?.length}`);

    let userId = data.customerId;

    // Resolve userId — verify it exists in DB
    const userExists = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!userExists) {
      this.logger.warn(`[WS] placeOrder: customerId="${userId}" not found in DB, resolving to first user`);
      const firstUser = await this.prisma.user.findFirst();
      if (firstUser) {
        userId = firstUser.id;
      } else {
        this.logger.warn(`[WS] placeOrder: No users in DB, creating mock customer`);
        const mockUser = await this.prisma.user.create({
          data: { name: 'Mock Customer', firebaseUid: 'mock-customer-' + Date.now(), role: 'passenger' }
        });
        userId = mockUser.id;
      }
      this.logger.log(`[WS] placeOrder: Resolved userId to ${userId}`);
    }

    // Save order in DB
    this.logger.log(`[WS] placeOrder: Creating order in DB for userId=${userId}`);
    const order = await this.prisma.order.create({
      data: {
        userId: userId,
        totalAmount: data.totalAmount,
        status: 'PENDING',
        items: {
          create: data.items.map(i => ({
            shopProductId: i.shopProductId,
            quantity: i.quantity,
            priceAtTime: i.price
          }))
        }
      },
      include: { items: { include: { shopProduct: { include: { product: true } } } }, user: true }
    });
    this.logger.log(`[WS] placeOrder: Order created id=${order.id}`);

    // Notify Merchant's room
    const shopRoom = `shop_${data.shopId}`;
    const roomSize = this.server.sockets.adapter.rooms.get(shopRoom)?.size ?? 0;
    this.logger.log(`[WS] placeOrder: Emitting 'newOrder' to room=${shopRoom} (${roomSize} members)`);
    this.server.to(shopRoom).emit('newOrder', order);

    return { event: 'orderPlaced', data: order };
  }

  // Update order status (from Merchant)
  @SubscribeMessage('updateOrderStatus')
  async handleUpdateOrderStatus(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; status: 'CONFIRMED' | 'REJECTED' }
  ) {
    this.logger.log(`[WS] updateOrderStatus: client=${client.id} orderId=${data.orderId} status=${data.status}`);

    const order = await this.prisma.order.update({
      where: { id: data.orderId },
      data: { status: data.status },
      include: { user: true }
    });

    const customerRoom = `customer_${order.userId}`;
    this.logger.log(`[WS] updateOrderStatus: Notifying customer room=${customerRoom}`);
    this.server.to(customerRoom).emit('orderStatusUpdated', order);

    this.logger.log(`[WS] updateOrderStatus: Done, orderId=${order.id} status=${order.status}`);
    return { event: 'orderUpdated', data: order };
  }
}
