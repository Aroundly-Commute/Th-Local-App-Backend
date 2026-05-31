import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  /**
   * Generates a 6-digit random verification code.
   */
  public generateOtpCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Dispatches an SMS verification code via Twilio REST API, or logs to console if in development.
   */
  async sendOtp(phoneNumber: string, code: string): Promise<boolean> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

    const messageBody = `Your Aroundly verification code is: ${code}. Valid for 5 minutes.`;

    // Sandbox Mock Mode: Used if Twilio keys are not configured in local development environment
    if (!accountSid || !authToken || !twilioPhone) {
      this.logger.warn(`
┌──────────────────────────────────────────────────────────┐
│             [TWILIO SMS DEV SANDBOX]                     │
├──────────────────────────────────────────────────────────┤
│ Phone Number: ${phoneNumber}                             │
│ OTP Code:     ${code}                                    │
│ Message:      ${messageBody}                             │
├──────────────────────────────────────────────────────────┤
│ To send real SMS messages, configure these in your .env: │
│ - TWILIO_ACCOUNT_SID                                     │
│ - TWILIO_AUTH_TOKEN                                      │
│ - TWILIO_PHONE_NUMBER                                    │
└──────────────────────────────────────────────────────────┘
      `);
      return true;
    }

    try {
      this.logger.log(`[SMS] Sending authentic Twilio SMS OTP code to ${phoneNumber}...`);
      
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      
      const details = {
        To: phoneNumber,
        From: twilioPhone,
        Body: messageBody,
      };

      // Convert details to form urlencoded format as required by Twilio API
      const formBody = Object.keys(details)
        .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent((details as any)[key]))
        .join('&');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
      });

      const responseData = await response.json();

      if (response.ok) {
        this.logger.log(`[SMS] SMS OTP successfully dispatched to ${phoneNumber}. SID: ${responseData.sid}`);
        return true;
      } else {
        this.logger.error(`[SMS] Twilio API returned error code ${response.status}:`, responseData);
        return false;
      }
    } catch (err: any) {
      this.logger.error(`[SMS] Failed to send SMS via Twilio to ${phoneNumber}:`, err.message || err);
      return false;
    }
  }
}
