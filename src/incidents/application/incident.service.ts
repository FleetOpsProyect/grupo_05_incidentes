import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { getCorrelationId } from '../../shared/context/correlation-context';
import { Incident } from '../domain/incident';
import { IncidentEventFactory } from '../domain/incident-event.factory';
import { Severity } from '../domain/severity';
import {
  INCIDENT_REPOSITORY,
  IncidentFilter,
  IncidentPage,
  type IncidentRepository,
} from './ports/incident.repository.port';
import { AssignmentInProgressValidator } from './validation/assignment-in-progress.validator';
import { CreateIncidentContext } from './validation/create-incident.context';
import { ReportedAtNotInFutureValidator } from './validation/reported-at-not-in-future.validator';
import { VehicleExistsValidator } from './validation/vehicle-exists.validator';

export interface CreateIncidentCommand {
  assignmentId: string;
  severity: Severity;
  description: string;
  reportedAt: Date;
  /** `sub` del JWT (solo para trazabilidad en el log). */
  userSub?: string;
}

export interface ListIncidentsQuery extends IncidentFilter {
  page: number;
  size: number;
}

@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);
  private readonly validationChain: ReportedAtNotInFutureValidator;

  constructor(
    @Inject(INCIDENT_REPOSITORY)
    private readonly repository: IncidentRepository,
    private readonly eventFactory: IncidentEventFactory,
    reportedAtValidator: ReportedAtNotInFutureValidator,
    assignmentValidator: AssignmentInProgressValidator,
    vehicleValidator: VehicleExistsValidator,
  ) {
    // Orden de la cadena: fecha (sin llamadas externas) → asignación → vehículo.
    reportedAtValidator.setNext(assignmentValidator).setNext(vehicleValidator);
    this.validationChain = reportedAtValidator;
  }

  async create(command: CreateIncidentCommand): Promise<Incident> {
    const context: CreateIncidentContext = {
      assignmentId: command.assignmentId,
      severity: command.severity,
      description: command.description,
      reportedAt: command.reportedAt,
    };
    await this.validationChain.handle(context);

    // El incidente no guarda vehicle_id ni driver_id (ADR-10): viajan solo en el evento.
    if (!context.vehicleId || !context.driverId) {
      throw new Error(
        'La cadena de validación no resolvió vehicle_id y driver_id de la asignación',
      );
    }

    const now = new Date();
    const incident: Incident = {
      id: randomUUID(),
      assignmentId: command.assignmentId,
      severity: command.severity,
      description: command.description,
      status: 'reported',
      reportedAt: command.reportedAt,
      createdAt: now,
    };
    const correlationId = getCorrelationId() ?? randomUUID();
    const event = this.eventFactory.create(
      incident,
      { vehicleId: context.vehicleId, driverId: context.driverId },
      correlationId,
      now,
    );

    const saved = await this.repository.save(incident, event);

    // Sin la descripción completa ni el token (HU_FLEETOPS_INC_01, trazabilidad).
    this.logger.log({
      event: 'incident_reported',
      incident_id: saved.id,
      assignment_id: saved.assignmentId,
      severity: saved.severity,
      correlation_id: correlationId,
      sub: command.userSub,
    });
    return saved;
  }

  findById(_id: string): Promise<Incident> {
    return Promise.reject(
      new NotImplementedException(
        'GET /incidents/{id}: TODO(HU_FLEETOPS_INC_05)',
      ),
    );
  }

  list(_query: ListIncidentsQuery): Promise<IncidentPage> {
    return Promise.reject(
      new NotImplementedException('GET /incidents: TODO(HU_FLEETOPS_INC_06)'),
    );
  }
}
