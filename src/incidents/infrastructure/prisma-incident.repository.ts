import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  IncidentEvent,
  IncidentReportedData,
} from '../domain/events/incident-event';
import { Incident } from '../domain/incident';
import { Severity } from '../domain/severity';
import {
  IncidentFilter,
  IncidentPage,
  IncidentRepository,
} from '../application/ports/incident.repository.port';
import { PrismaService } from '../../shared/prisma/prisma.service';

@Injectable()
export class PrismaIncidentRepository implements IncidentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Transactional Outbox: incidente y evento se confirman juntos o ninguno (DAS ADR-06).
  async save(
    incident: Incident,
    event: IncidentEvent<string, IncidentReportedData>,
  ): Promise<Incident> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          id: incident.id,
          assignmentId: incident.assignmentId,
          severity: incident.severity,
          description: incident.description,
          status: incident.status,
          reportedAt: incident.reportedAt,
          createdAt: incident.createdAt,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: event.event_id,
          incidentId: incident.id,
          eventType: event.event_type,
          occurredAt: new Date(event.occurred_at),
          source: event.source,
          correlationId: event.correlation_id,
          data: { ...event.data },
        },
      });
      return created;
    });

    return {
      id: row.id,
      assignmentId: row.assignmentId,
      severity: row.severity as Severity,
      description: row.description,
      status: 'reported',
      reportedAt: row.reportedAt,
      createdAt: row.createdAt,
    };
  }

  // TODO(HU_FLEETOPS_INC_05): consulta por id.
  findById(_id: string): Promise<Incident | null> {
    return Promise.reject(
      new NotImplementedException('PrismaIncidentRepository.findById'),
    );
  }

  // TODO(HU_FLEETOPS_INC_06): listado filtrado y paginado, con el conteo por severidad (summary).
  findAll(
    _filter: IncidentFilter,
    _page: number,
    _size: number,
  ): Promise<IncidentPage> {
    return Promise.reject(
      new NotImplementedException('PrismaIncidentRepository.findAll'),
    );
  }
}
