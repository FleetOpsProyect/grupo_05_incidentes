import { PrismaService } from '../../shared/prisma/prisma.service';
import { Incident } from '../domain/incident';
import { IncidentEventFactory } from '../domain/incident-event.factory';
import { Severity } from '../domain/severity';
import { PrismaIncidentRepository } from './prisma-incident.repository';

// HU_FLEETOPS_INC_01: el incidente y su fila de outbox_events se guardan en la misma transacción.
describe('PrismaIncidentRepository.save', () => {
  const incident: Incident = {
    id: '11111111-1111-4111-8111-111111111111',
    assignmentId: '22222222-2222-4222-8222-222222222222',
    severity: Severity.Severe,
    description: 'Falla del motor',
    status: 'reported',
    reportedAt: new Date('2026-10-27T14:29:55.000Z'),
    createdAt: new Date('2026-10-27T14:29:56.000Z'),
  };
  const event = new IncidentEventFactory().create(
    incident,
    {
      vehicleId: '33333333-3333-4333-8333-333333333333',
      driverId: '44444444-4444-4444-8444-444444444444',
    },
    'corr-1',
    new Date('2026-10-27T14:29:56.000Z'),
    '55555555-5555-4555-8555-555555555555',
  );

  const tx = {
    incident: { create: jest.fn() },
    outboxEvent: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() };
  let repository: PrismaIncidentRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((work: (t: typeof tx) => unknown) =>
      work(tx),
    );
    tx.incident.create.mockResolvedValue({ ...incident });
    tx.outboxEvent.create.mockResolvedValue({});
    repository = new PrismaIncidentRepository(
      prisma as unknown as PrismaService,
    );
  });

  it('inserta incidente y outbox dentro de una sola $transaction', async () => {
    await repository.save(incident, event);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.incident.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('guarda solo assignment_id en el incidente (sin vehicle_id ni driver_id)', async () => {
    await repository.save(incident, event);

    expect(tx.incident.create).toHaveBeenCalledWith({
      data: {
        id: incident.id,
        assignmentId: incident.assignmentId,
        severity: 'severe',
        description: 'Falla del motor',
        status: 'reported',
        reportedAt: incident.reportedAt,
        createdAt: incident.createdAt,
      },
    });
  });

  it('mapea el sobre del evento a las columnas de outbox_events y deja en data solo el payload', async () => {
    await repository.save(incident, event);

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        eventId: '55555555-5555-4555-8555-555555555555',
        incidentId: incident.id,
        eventType: 'severe_incident_reported_event',
        occurredAt: new Date('2026-10-27T14:29:56.000Z'),
        source: 'incident',
        correlationId: 'corr-1',
        data: event.data,
      },
    });
  });

  it('devuelve el incidente guardado', async () => {
    await expect(repository.save(incident, event)).resolves.toEqual(incident);
  });

  it('propaga el error de la transacción (el incidente no queda a medias)', async () => {
    prisma.$transaction.mockRejectedValue(new Error('tx rolled back'));

    await expect(repository.save(incident, event)).rejects.toThrow(
      'tx rolled back',
    );
  });
});
