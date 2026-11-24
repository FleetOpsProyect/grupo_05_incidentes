import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../../shared/errors/error-catalog';
import { CreateIncidentContext } from './create-incident.context';
import { ValidationHandler } from './validation-handler';

const DEFAULT_TOLERANCE_MS = 300000;

// Regla propuesta en el DAS v3.2: reported_at no puede ser posterior a la hora actual
// más la tolerancia REPORTED_AT_FUTURE_TOLERANCE_MS.
@Injectable()
export class ReportedAtNotInFutureValidator extends ValidationHandler<CreateIncidentContext> {
  constructor(private readonly config: ConfigService) {
    super();
  }

  protected validate(context: CreateIncidentContext): Promise<void> {
    const toleranceMs = this.config.get<number>(
      'REPORTED_AT_FUTURE_TOLERANCE_MS',
      DEFAULT_TOLERANCE_MS,
    );
    if (context.reportedAt.getTime() > Date.now() + toleranceMs) {
      return Promise.reject(
        new UnprocessableEntityException({
          code: ErrorCode.ReportedAtInFuture,
          message: 'reported_at no puede ser una fecha futura.',
        }),
      );
    }
    return Promise.resolve();
  }
}
