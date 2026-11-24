import { Severity } from '../../domain/severity';

export interface CreateIncidentContext {
  assignmentId: string;
  severity: Severity;
  description: string;
  reportedAt: Date;
  // Los llena AssignmentInProgressValidator (HU_FLEETOPS_INC_02) con los datos de la asignación.
  vehicleId?: string;
  driverId?: string;
}
