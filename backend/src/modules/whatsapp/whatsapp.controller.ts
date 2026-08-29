import { Controller, Get, Post, Query, Body, Res, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { WhatsAppBotService } from './whatsapp-bot.service';
import { WhatsAppService } from './whatsapp.service';

@Controller(['whatsapp', 'api/whatsapp'])
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly botService: WhatsAppBotService,
    private readonly waService: WhatsAppService,
  ) {}

  /**
   * Webhook Verification Endpoint (Meta WhatsApp Cloud API Handshake)
   * Meta sends GET request with hub.mode, hub.verify_token, and hub.challenge
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'carpool_wa_webhook_secret_2026';

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('✅ WhatsApp Webhook verified successfully by Meta!');
      return res.status(HttpStatus.OK).send(challenge);
    }

    this.logger.warn(`❌ Webhook verification failed. Received token: "${token}", Expected: "${verifyToken}"`);
    return res.status(HttpStatus.FORBIDDEN).send('Verification token mismatch');
  }

  /**
   * Webhook Event Listener (Receives incoming messages from WhatsApp users)
   */
  @Post('webhook')
  async handleIncomingWebhook(@Body() body: any, @Res() res: Response) {
    // Meta requires an immediate 200 OK response to prevent retry flooding
    res.status(HttpStatus.OK).send('EVENT_RECEIVED');

    try {
      if (body?.object !== 'whatsapp_business_account') {
        return;
      }

      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
          if (!value || !value.messages || value.messages.length === 0) {
            continue;
          }

          const contact = (value.contacts && value.contacts[0]) || {};
          const profileName = contact.profile?.name;
          const message = value.messages[0];

          const from = message.from; // Phone number (e.g. 919876543210)
          const type = message.type; // text, location, interactive, button, etc.

          let incomingText: string | undefined;
          let location: { latitude: number; longitude: number; name?: string; address?: string } | undefined;
          let buttonReplyId: string | undefined;
          let listReplyId: string | undefined;

          if (type === 'text') {
            incomingText = message.text?.body;
          } else if (type === 'location') {
            location = {
              latitude: message.location?.latitude,
              longitude: message.location?.longitude,
              name: message.location?.name,
              address: message.location?.address,
            };
          } else if (type === 'interactive') {
            const interactive = message.interactive;
            if (interactive.type === 'button_reply') {
              buttonReplyId = interactive.button_reply?.id;
              incomingText = interactive.button_reply?.title;
            } else if (interactive.type === 'list_reply') {
              listReplyId = interactive.list_reply?.id;
              incomingText = interactive.list_reply?.title;
            }
          } else if (type === 'button') {
            buttonReplyId = message.button?.payload || message.button?.text;
            incomingText = message.button?.text;
          }

          // Process the message asynchronously in the background
          this.botService.processIncomingMessage({
            from,
            name: profileName,
            type,
            text: incomingText,
            location,
            buttonReplyId,
            listReplyId,
          }).catch((err) => {
            this.logger.error(`Error processing WhatsApp message from ${from}: ${err?.message}`, err?.stack);
          });
        }
      }
    } catch (err: any) {
      this.logger.error(`Error in handleIncomingWebhook: ${err?.message}`);
    }
  }

  /**
   * Test Endpoint to verify outbound WhatsApp dispatch
   */
  @Post('send-test')
  async sendTestMessage(@Body() body: { to: string; message?: string }) {
    const text = body.message || 'Hello from The34 Carpool! Your WhatsApp automation is active. 🚀';
    return this.waService.sendText(body.to, text);
  }
}
