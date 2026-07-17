import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const user: any = (request as any).user;
    const userId = user?.id || user?.sub || 'unauthenticated';
    const userEmail = user?.email || user?.phoneNumber || 'N/A';

    let message: string | object = 'Internal server error';
    let errorName = 'InternalServerError';

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      message = typeof res === 'object' && (res as any).message ? (res as any).message : exception.message;
      errorName = exception.name;
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
    }

    // Redact sensitive keys from request body before logging
    const sanitizedBody = this.sanitizePayload(request.body);

    const logDetails = {
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      status,
      userId,
      userEmail,
      ip: request.ip || request.headers['x-forwarded-for'],
      body: sanitizedBody,
      query: request.query,
      message,
    };

    if (status >= 500) {
      this.logger.error(
        `[CRITICAL SERVER EXCEPTION] ${request.method} ${request.url} - Status ${status} - User: ${userId} (${userEmail})`,
        exception instanceof Error ? exception.stack : String(exception),
        JSON.stringify(logDetails),
      );
    } else {
      this.logger.warn(
        `[CLIENT ERROR] ${request.method} ${request.url} - Status ${status} - Message: ${JSON.stringify(message)} - User: ${userId}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: Array.isArray(message) ? message.join(', ') : message,
      error: errorName,
    });
  }

  private sanitizePayload(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const copy = { ...body };
    const sensitiveKeys = ['password', 'code', 'token', 'idToken', 'jwt', 'secret'];
    for (const key of Object.keys(copy)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        copy[key] = '***REDACTED***';
      } else if (typeof copy[key] === 'object') {
        copy[key] = this.sanitizePayload(copy[key]);
      }
    }
    return copy;
  }
}
