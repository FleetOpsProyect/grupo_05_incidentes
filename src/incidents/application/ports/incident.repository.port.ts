import {
  IncidentEvent,
  IncidentReportedData,
} from '../../domain/events/incident-event';
import { Incident } from '../../domain/incident';
import { Severity } from '../../domain/severity';

export const INCIDENT_REPOSITORY = Symbol('INCIDENT_REPOSITORY');

export interface IncidentFilter {
  assignmentId?: string;
  severity?: Severity;
  reportedFrom?: Date;
  reportedTo?: Date;
}

export interface IncidentPage {
  content: Incident[];
  total: number;
  /** Se calcula sobre todos los registros que cumplen los filtros, no solo sobre la página. */
  summary: { bySeverity: Record<Severity, number> };
}

export interface IncidentRepository {
  /** Guarda el incidente y su evento de outbox en la misma transacción. */
  save(
    incident: Incident,
    event: IncidentEvent<string, IncidentReportedData>,
  ): Promise<Incident>;
  findById(id: string): Promise<Incident | null>;
  findAll(
    filter: IncidentFilter,
    page: number,
    size: number,
  ): Promise<IncidentPage>;
}
