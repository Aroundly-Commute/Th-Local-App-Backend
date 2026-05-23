import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class AppController {
  @Get()
  checkHealth() {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      message: 'Server is awake and running.'
    };
  }
}
