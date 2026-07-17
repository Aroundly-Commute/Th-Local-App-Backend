import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body } = request;
    const now = Date.now();
    const user: any = request.user;
    const userId = user?.id || user?.sub || 'anonymous';

    const sanitizedBody = this.sanitizePayload(body);
    const bodyStr = sanitizedBody && Object.keys(sanitizedBody).length > 0 ? ` - Body: ${JSON.stringify(sanitizedBody)}` : '';

    this.logger.log(`[REQ] ${method} ${url} (User: ${userId})${bodyStr}`);

    return next.handle().pipe(
      tap((response) => {
        const delay = Date.now() - now;
        const statusCode = context.switchToHttp().getResponse().statusCode || 200;
        this.logger.log(`[RES] ${method} ${url} Status: ${statusCode} +${delay}ms (User: ${userId})`);
      }),
      catchError((error) => {
        const delay = Date.now() - now;
        const status = error.status || 500;
        this.logger.error(
          `[ERR] ${method} ${url} Status: ${status} +${delay}ms (User: ${userId}) - ${error.message}`,
        );
        return throwError(() => error);
      }),
    );
  }

  private sanitizePayload(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const copy = { ...body };
    const sensitiveKeys = ['password', 'code', 'token', 'idToken', 'jwt', 'secret'];
    for (const key of Object.keys(copy)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        copy[key] = '***REDACTED***';
      }
    }
    return copy;
  }
}
