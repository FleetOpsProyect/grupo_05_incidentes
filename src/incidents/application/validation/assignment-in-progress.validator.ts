import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../../../shared/errors/error-catalog';
import {
  ASSIGNMENT_IN_PROGRESS,
  ASSIGNMENTS_GATEWAY,
  type AssignmentsGateway,
} from '../ports/assignments.gateway.port';
import { CreateIncidentContext } from './create-incident.context';
import { ValidationHandler } from './validation-handler';

// HU_FLEETOPS_INC_02: la asignación debe existir (404) y estar in_progress (409).
// Si es válida, deja vehicle_id y driver_id en el contexto para el evento (ADR-10).
@Injectable()
export class AssignmentInProgressValidator extends ValidationHandler<CreateIncidentContext> {
  constructor(
    @Inject(ASSIGNMENTS_GATEWAY)
    private readonly assignments: AssignmentsGateway,
  ) {
    super();
  }

  protected async validate(context: CreateIncidentContext): Promise<void> {
    const assignment = await this.assignments.findById(context.assignmentId);

    if (!assignment) {
      throw new NotFoundException({
        code: ErrorCode.AssignmentNotFound,
        message: `No existe una asignación con id '${context.assignmentId}'.`,
      });
    }
    if (assignment.status !== ASSIGNMENT_IN_PROGRESS) {
      throw new ConflictException({
        code: ErrorCode.AssignmentNotInProgress,
        message: 'La asignación no está en curso.',
      });
    }

    context.vehicleId = assignment.vehicleId;
    context.driverId = assignment.driverId;
  }
}
