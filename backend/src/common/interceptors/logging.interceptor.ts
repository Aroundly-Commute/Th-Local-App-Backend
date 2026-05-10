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

    this.logger.log(`Incoming Request: ${method} ${url} - Body: ${JSON.stringify(body)}`);

    return next.handle().pipe(
      tap((response) => {
        const delay = Date.now() - now;
        this.logger.log(`Outgoing Response: ${method} ${url} +${delay}ms - Status: 200/201`);
      }),
      catchError((error) => {
        const delay = Date.now() - now;
        this.logger.error(
          `Error Response: ${method} ${url} +${delay}ms - Status: ${error.status || 500} - Message: ${error.message}`,
          error.stack,
        );
        return throwError(() => error);
      }),
    );
  }
}
