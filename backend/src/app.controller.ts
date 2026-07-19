import { Controller, Get, Param, Query, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { ParkingService } from './modules/parking/parking.service';

@Controller()
export class AppController {
  constructor(private readonly parkingService: ParkingService) {}

  @Get('health')
  checkHealth() {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      message: 'Server is awake and running.'
    };
  }

  @Get('parking/ticket/:id')
  @Header('Content-Type', 'text/html')
  async getWebTicket(
    @Param('id') id: string,
    @Query('spot') spotQuery?: string,
  ) {
    let booking: any = null;
    let errorMsg = '';
    
    try {
      booking = await this.parkingService.getTicketById(id);
    } catch (err: any) {
      errorMsg = err?.message || 'Ticket not found';
    }

    const spotName = booking?.spot?.spotName || spotQuery || 'N/A';
    const status = booking?.status || 'UNKNOWN';
    const userName = booking?.user?.name || 'Visitor';
    const price = booking?.price !== undefined ? `₹${booking.price}` : 'N/A';
    
    // Format times
    let timeRange = 'N/A';
    if (booking?.startTime && booking?.endTime) {
      const start = new Date(booking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const end = new Date(booking.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = new Date(booking.startTime).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      timeRange = `${date} (${start} - ${end})`;
    }

    // Color code status
    let statusColor = '#EAB308'; // yellow for pending
    if (status === 'ACCEPTED') statusColor = '#22C55E'; // green
    if (status === 'REJECTED' || status === 'CANCELLED') statusColor = '#EF4444'; // red
    if (status === 'EXPIRED') statusColor = '#6B7280'; // gray

    const appScheme = `aroundly://parking/ticket/${id}${spotQuery ? `?spot=${encodeURIComponent(spotQuery)}` : ''}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aroundly Parking Ticket</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --bg: #0f172a;
      --card-bg: rgba(30, 41, 59, 0.7);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at top, #1e1b4b 0%, #0f172a 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      overflow-x: hidden;
    }

    .container {
      width: 100%;
      max-width: 440px;
      text-align: center;
      animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .logo span {
      background: linear-gradient(135deg, #818cf8 0%, #c084fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .status-banner {
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 500;
      color: #e0e7ff;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      backdrop-filter: blur(10px);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--primary);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.6; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.6; }
    }

    /* Ticket Card styling */
    .ticket-card {
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 32px 24px;
      backdrop-filter: blur(20px);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      position: relative;
      margin-bottom: 32px;
    }

    .ticket-card::before, .ticket-card::after {
      content: '';
      position: absolute;
      width: 24px;
      height: 24px;
      background: #111424; /* matches background gradient cutout */
      border-radius: 50%;
      top: 60%;
    }
    .ticket-card::before { left: -13px; border-right: 1px solid rgba(255, 255, 255, 0.1); }
    .ticket-card::after { right: -13px; border-left: 1px solid rgba(255, 255, 255, 0.1); }

    .ticket-divider {
      border-top: 2px dashed rgba(255, 255, 255, 0.1);
      margin: 24px 0;
      position: relative;
    }

    .spot-header {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .spot-name {
      font-size: 40px;
      font-weight: 700;
      color: #fff;
      text-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }

    .status-badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 12px;
    }

    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      text-align: left;
    }

    .info-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }

    .info-val {
      font-size: 16px;
      font-weight: 500;
      color: #fff;
    }

    .info-val-full {
      grid-column: span 2;
    }

    /* Actions */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 16px;
      border-radius: 16px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      cursor: pointer;
      border: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: #fff;
      box-shadow: 0 8px 20px rgba(99, 102, 241, 0.4);
      margin-bottom: 16px;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 24px rgba(99, 102, 241, 0.5);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .footer {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 32px;
    }

    .footer a {
      color: var(--primary);
      text-decoration: none;
    }

    /* Error View */
    .error-container {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 20px;
      padding: 24px;
    }
  </style>
  <script>
    // Automatically attempt deep link redirect
    window.onload = function() {
      const appScheme = "${appScheme}";
      
      // Attempt redirect
      window.location.href = appScheme;
      
      // Update UI if user stays on page
      setTimeout(() => {
        const text = document.getElementById('status-text');
        if (text) {
          text.innerText = "If the app didn't open automatically, you can open it manually or view ticket details below.";
        }
      }, 2500);
    };
  </script>
</head>
<body>

  <div class="container">
    <div class="logo">
      <span>Aroundly</span> Parking
    </div>

    ${errorMsg ? `
      <div class="error-container">
        <h2 style="color: #ef4444; margin-bottom: 8px;">Ticket Not Found</h2>
        <p style="color: var(--text-muted); font-size: 15px; margin-bottom: 20px;">${errorMsg}</p>
        <a href="aroundly://" class="btn btn-primary">Open Aroundly App</a>
      </div>
    ` : `
      <div class="status-banner">
        <div class="status-dot"></div>
        <span id="status-text">Redirecting to Aroundly App...</span>
      </div>

      <div class="ticket-card">
        <div class="spot-header">Reserved Spot</div>
        <div class="spot-name">${spotName}</div>
        
        <span class="status-badge" style="background-color: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}44;">
          ${status}
        </span>

        <div class="ticket-divider"></div>

        <div class="info-grid">
          <div>
            <div class="info-label">Booked By</div>
            <div class="info-val">${userName}</div>
          </div>
          <div>
            <div class="info-label">Price</div>
            <div class="info-val">${price}</div>
          </div>
          <div class="info-val-full" style="margin-top: 16px;">
            <div class="info-label">Time & Date</div>
            <div class="info-val">${timeRange}</div>
          </div>
        </div>
      </div>

      <a href="${appScheme}" class="btn btn-primary">Open in Aroundly App</a>
      <a href="https://aroundly.app/download" class="btn btn-secondary">Get the App</a>
    `}

    <div class="footer">
      Powered by <a href="https://aroundly.app">Aroundly</a>
    </div>
  </div>

</body>
</html>`;
  }
}
