import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { getCorrelationId } from '../../shared/context/correlation-context';
import { ErrorCode } from '../../shared/errors/error-catalog';
import {
  AssignmentsGateway,
  AssignmentSummary,
} from '../application/ports/assignments.gateway.port';

// Forma de la respuesta de Asignaciones (G2) que usa Incidentes. Supuesto pendiente de confirmar con G2.
interface AssignmentResponse {
  status?: unknown;
  vehicle_id?: unknown;
  driver_id?: unknown;
}

// Adaptador / capa anticorrupción: traduce la respuesta de Asignaciones al modelo interno.
// Solo hace GET: Asignaciones es la única autoridad sobre la asignación.
// TODO(HU_FLEETOPS_INC_07): circuit breaker (opossum) y bulkhead (agente HTTP con maxSockets propio).
@Injectable()
export class AssignmentsHttpClient implements AssignmentsGateway {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async findById(id: string): Promise<AssignmentSummary | null> {
    const baseUrl = this.config.getOrThrow<string>('ASSIGNMENTS_BASE_URL');
    const correlationId = getCorrelationId();

    try {
      const { data } = await firstValueFrom(
        this.http.get<AssignmentResponse>(`${baseUrl}/assignment/${id}`, {
          headers: correlationId ? { 'X-Correlation-Id': correlationId } : {},
        }),
      );
      return this.toSummary(id, data);
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw this.unavailable();
    }
  }

  private toSummary(id: string, data: AssignmentResponse): AssignmentSummary {
    if (
      typeof data?.status !== 'string' ||
      typeof data.vehicle_id !== 'string' ||
      typeof data.driver_id !== 'string'
    ) {
      throw this.unavailable();
    }
    return {
      id,
      status: data.status,
      vehicleId: data.vehicle_id,
      driverId: data.driver_id,
    };
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: ErrorCode.DependencyUnavailable,
      message: 'El servicio de Asignaciones no está disponible.',
    });
  }
}
