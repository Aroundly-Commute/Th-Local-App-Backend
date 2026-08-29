import { Injectable, Logger } from '@nestjs/common';

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  private get phoneNumberId(): string {
    return process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  }

  private get accessToken(): string {
    return process.env.WHATSAPP_ACCESS_TOKEN || '';
  }

  private get apiVersion(): string {
    return process.env.WHATSAPP_API_VERSION || 'v21.0';
  }

  private get apiUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  /**
   * Format phone number into clean WhatsApp format (digits only, e.g. 919876543210).
   */
  sanitizePhoneNumber(phone: string): string {
    let clean = phone.replace(/[^0-9]/g, '');
    // If it starts with +91 or has country code, ensure it doesn't have double zeros
    if (clean.startsWith('0')) {
      clean = clean.substring(1);
    }
    return clean;
  }

  /**
   * Sends raw payload to Meta WhatsApp Cloud API
   */
  async sendMessage(payload: any): Promise<any> {
    if (!this.phoneNumberId || !this.accessToken || this.phoneNumberId === 'your_whatsapp_phone_number_id') {
      this.logger.warn(
        `[WhatsAppService] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in .env. Mocking message dispatch:`,
        JSON.stringify(payload)
      );
      return { messaging_product: 'whatsapp', contacts: [{ input: payload.to, wa_id: payload.to }], messages: [{ id: `mock_${Date.now()}` }] };
    }

    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        this.logger.error(`[WhatsApp API Error] ${res.status} - ${JSON.stringify(data)}`);
        throw new Error(data?.error?.message || 'Failed to send WhatsApp message');
      }
      return data;
    } catch (err: any) {
      this.logger.error(`[WhatsApp Dispatch Failed] ${err.message}`);
      throw err;
    }
  }

  /**
   * Send regular text message (supports WhatsApp markdown: *bold*, _italic_, ~strike~)
   */
  async sendText(to: string, text: string, previewUrl = false): Promise<any> {
    const formattedTo = this.sanitizePhoneNumber(to);
    return this.sendMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'text',
      text: {
        preview_url: previewUrl,
        body: text,
      },
    });
  }

  /**
   * Send Quick Reply Interactive Buttons (max 3 buttons)
   */
  async sendButtons(to: string, bodyText: string, buttons: WhatsAppButton[], headerText?: string, footerText = 'Powered by The34'): Promise<any> {
    const formattedTo = this.sanitizePhoneNumber(to);
    
    // Meta allows max 3 buttons in reply button component
    const safeButtons = buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: b.id,
        title: b.title.slice(0, 20), // Max 20 chars
      },
    }));

    const interactive: any = {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: safeButtons },
    };

    if (headerText) {
      interactive.header = { type: 'text', text: headerText };
    }
    if (footerText) {
      interactive.footer = { text: footerText };
    }

    return this.sendMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'interactive',
      interactive,
    });
  }

  /**
   * Send Interactive List Message (Dropdown selection for multiple rides)
   */
  async sendList(
    to: string,
    bodyText: string,
    buttonTitle: string,
    sections: WhatsAppListSection[],
    headerText?: string,
    footerText = 'Select a ride to book'
  ): Promise<any> {
    const formattedTo = this.sanitizePhoneNumber(to);

    const interactive: any = {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonTitle.slice(0, 20),
        sections: sections.map((s) => ({
          title: s.title.slice(0, 24),
          rows: s.rows.slice(0, 10).map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            description: r.description ? r.description.slice(0, 72) : undefined,
          })),
        })),
      },
    };

    if (headerText) {
      interactive.header = { type: 'text', text: headerText };
    }
    if (footerText) {
      interactive.footer = { text: footerText };
    }

    return this.sendMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'interactive',
      interactive,
    });
  }

  /**
   * Send Location Request
   */
  async sendLocationPrompt(to: string, promptText: string): Promise<any> {
    const textWithHint = `${promptText}\n\n💡 *Tip:* You can tap the 📎 attachment icon in WhatsApp and choose *Location* to send your exact pin!`;
    return this.sendText(to, textWithHint);
  }
}
