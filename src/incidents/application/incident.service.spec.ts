import { Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getCorrelationId } from '../../shared/context/correlation-context';
import { IncidentEventFactory } from '../domain/incident-event.factory';
import { Severity } from '../domain/severity';
import { CreateIncidentCommand, IncidentService } from './incident.service';
import { AssignmentsGateway } from './ports/assignments.gateway.port';
import { IncidentRepository } from './ports/incident.repository.port';
import { AssignmentInProgressValidator } from './validation/assignment-in-progress.validator';
import { CreateIncidentContext } from './validation/create-incident.context';
import { ReportedAtNotInFutureValidator } from './validation/reported-at-not-in-future.validator';
import { VehicleExistsValidator } from './validation/vehicle-exists.validator';

jest.mock('../../shared/context/correlation-context', () => ({
  getCorrelationId: jest.fn(),
}));

const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
const DRIVER_ID = '44444444-4444-4444-8444-444444444444';
const calls: string[] = [];

// Dobles de las HU vecinas: HU_FLEETOPS_INC_02 (asignación) y HU_FLEETOPS_INC_03 (vehículo).
const unusedGateway: AssignmentsGateway = { findById: jest.fn() };

class FakeAssignmentValidator extends AssignmentInProgressValidator {
  constructor() {
    super(unusedGateway);
  }

  protected override validate(context: CreateIncidentContext): Promise<void> {
    calls.push('assignment');
    context.vehicleId = VEHICLE_ID;
    context.driverId = DRIVER_ID;
    return Promise.resolve();
  }
}

class FakeVehicleValidator extends VehicleExistsValidator {
  protected override validate(): Promise<void> {
    calls.push('vehicle');
    return Promise.resolve();
  }
}

describe('IncidentService', () => {
  const futureTolerance = {
    get: () => 300000,
  } as unknown as ConfigService;
  const getCorrelationIdMock = getCorrelationId as jest.Mock;

  let repository: jest.Mocked<IncidentRepository>;
  let logSpy: jest.SpyInstance;

  function buildService(
    assignment: AssignmentInProgressValidator = new FakeAssignmentValidator(),
  ) {
    return new IncidentService(
      repository,
      new IncidentEventFactory(),
      new ReportedAtNotInFutureValidator(futureTolerance),
      assignment,
      new FakeVehicleValidator(),
    );
  }

  function command(
    overrides: Partial<CreateIncidentCommand> = {},
  ): CreateIncidentCommand {
    return {
      assignmentId: '22222222-2222-4222-8222-222222222222',
      severity: Severity.Minor,
      description: 'Llanta pinchada en la vía',
      reportedAt: new Date(Date.now() - 60_000),
      userSub: 'user-sub-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    calls.length = 0;
    getCorrelationIdMock.mockReturnValue('corr-1');
    repository = {
      save: jest.fn<
        ReturnType<IncidentRepository['save']>,
        Parameters<IncidentRepository['save']>
      >((incident) => Promise.resolve(incident)),
      findById: jest.fn(),
      findAll: jest.fn(),
    };
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create (HU_FLEETOPS_INC_01)', () => {
    // CA: guarda el incidente en estado "reported" y devuelve lo guardado.
    it('guarda el incidente en estado reported y lo devuelve', async () => {
      const input = command();

      const result = await buildService().create(input);

      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        assignmentId: input.assignmentId,
        severity: Severity.Minor,
        description: input.description,
        status: 'reported',
        reportedAt: input.reportedAt,
      });
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    // CA (ADR-10): el incidente solo guarda assignment_id; vehicle_id y driver_id van solo en el evento.
    it('no persiste vehicle_id ni driver_id en el incidente; viajan en el evento', async () => {
      await buildService().create(command());

      const [incident, event] = repository.save.mock.calls[0];
      expect(incident).not.toHaveProperty('vehicleId');
      expect(incident).not.toHaveProperty('driverId');
      expect(event.data).toMatchObject({
        incident_id: incident.id,
        vehicle_id: VEHICLE_ID,
        driver_id: DRIVER_ID,
      });
    });

    // CA: minor publica minor_incident_reported_event.
    it('un incidente minor produce minor_incident_reported_event', async () => {
      await buildService().create(command({ severity: Severity.Minor }));

      expect(repository.save.mock.calls[0][1].event_type).toBe(
        'minor_incident_reported_event',
      );
    });

    // CA: severe publica severe_incident_reported_event.
    it('un incidente severe produce severe_incident_reported_event', async () => {
      await buildService().create(command({ severity: Severity.Severe }));

      expect(repository.save.mock.calls[0][1].event_type).toBe(
        'severe_incident_reported_event',
      );
    });

    // CA (trazabilidad): el evento lleva el correlation_id de la petición.
    it('copia el correlation_id de la petición al evento', async () => {
      await buildService().create(command());

      expect(repository.save.mock.calls[0][1].correlation_id).toBe('corr-1');
    });

    it('genera un correlation_id si la petición no tiene contexto', async () => {
      getCorrelationIdMock.mockReturnValue(undefined);

      await buildService().create(command());

      expect(repository.save.mock.calls[0][1].correlation_id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    // CA (422): reported_at futura → no se consulta Asignaciones ni se guarda.
    it('rechaza reported_at futura con 422 sin consultar dependencias ni guardar', async () => {
      const future = command({ reportedAt: new Date(Date.now() + 3_600_000) });

      await expect(buildService().create(future)).rejects.toMatchObject({
        status: 422,
        response: { code: 'reported_at_in_future' },
      });
      expect(calls).toEqual([]);
      expect(repository.save).not.toHaveBeenCalled();
    });

    // La cadena valida: fecha → asignación → vehículo.
    it('ejecuta la cadena en orden: asignación y luego vehículo', async () => {
      await buildService().create(command());

      expect(calls).toEqual(['assignment', 'vehicle']);
    });

    // CA (404/409 de HU_02): si un validador falla no se guarda ni se publica nada.
    it('no guarda si un validador de la cadena falla', async () => {
      class FailingAssignment extends AssignmentInProgressValidator {
        constructor() {
          super(unusedGateway);
        }

        protected override validate(): Promise<void> {
          return Promise.reject(new Error('assignment_not_in_progress'));
        }
      }

      await expect(
        buildService(new FailingAssignment()).create(command()),
      ).rejects.toThrow('assignment_not_in_progress');
      expect(repository.save).not.toHaveBeenCalled();
    });

    // CA (500): si la cadena no resuelve vehicle_id/driver_id es un error interno, no un 201.
    it('lanza error interno si la cadena no resuelve vehicle_id y driver_id', async () => {
      class NoRefsAssignment extends AssignmentInProgressValidator {
        constructor() {
          super(unusedGateway);
        }

        protected override validate(): Promise<void> {
          return Promise.resolve();
        }
      }

      await expect(
        buildService(new NoRefsAssignment()).create(command()),
      ).rejects.toThrow('vehicle_id y driver_id');
      expect(repository.save).not.toHaveBeenCalled();
    });

    // CA (500): un fallo del repositorio se propaga (el filtro global responde internal_error).
    it('propaga el error del repositorio', async () => {
      repository.save.mockRejectedValue(new Error('db down'));

      await expect(buildService().create(command())).rejects.toThrow('db down');
      expect(logSpy).not.toHaveBeenCalled();
    });

    // CA (trazabilidad): log con ids, severidad, correlation_id y sub; sin descripción ni token.
    it('registra un log con los campos de trazabilidad y sin la descripción', async () => {
      const result = await buildService().create(command());

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(logged).toEqual({
        event: 'incident_reported',
        incident_id: result.id,
        assignment_id: result.assignmentId,
        severity: 'minor',
        correlation_id: 'corr-1',
        sub: 'user-sub-1',
      });
      expect(JSON.stringify(logged)).not.toContain('Llanta pinchada');
    });
  });

  // HU_FLEETOPS_INC_02: la cadena real consulta Asignaciones antes de guardar.
  describe('create con la validación de asignación real (HU_FLEETOPS_INC_02)', () => {
    const findById = jest.fn();
    const withGateway = () =>
      buildService(new AssignmentInProgressValidator({ findById }));

    // CA: Asignaciones responde 404 → 404 assignment_not_found, sin guardar ni publicar.
    it('asignación inexistente → 404 assignment_not_found y no guarda', async () => {
      findById.mockResolvedValue(null);

      await expect(withGateway().create(command())).rejects.toMatchObject({
        status: 404,
        response: { code: 'assignment_not_found' },
      });
      expect(repository.save).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    // CA: estado distinto de in_progress → 409 assignment_not_in_progress, sin guardar ni publicar.
    it.each(['pending', 'finished', 'interrupted_by_incident', 'cancelled'])(
      'asignación %s → 409 assignment_not_in_progress y no guarda',
      async (status) => {
        findById.mockResolvedValue({
          id: 'a',
          status,
          vehicleId: VEHICLE_ID,
          driverId: DRIVER_ID,
        });

        await expect(withGateway().create(command())).rejects.toMatchObject({
          status: 409,
          response: { code: 'assignment_not_in_progress' },
        });
        expect(repository.save).not.toHaveBeenCalled();
      },
    );

    // CA: in_progress → vehicle_id y driver_id salen de la asignación y viajan solo en el evento.
    it('asignación in_progress → toma vehicle_id y driver_id de la respuesta para el evento', async () => {
      findById.mockResolvedValue({
        id: 'a',
        status: 'in_progress',
        vehicleId: 'vehicle-from-g2',
        driverId: 'driver-from-g2',
      });
      const input = command();

      await withGateway().create(input);

      expect(findById).toHaveBeenCalledWith(input.assignmentId);
      expect(repository.save.mock.calls[0][1].data).toMatchObject({
        vehicle_id: 'vehicle-from-g2',
        driver_id: 'driver-from-g2',
      });
    });

    // CA: si Asignaciones no responde el 503 se propaga y no se guarda.
    it('si Asignaciones no está disponible propaga el error y no guarda', async () => {
      findById.mockRejectedValue(new Error('dependency_unavailable'));

      await expect(withGateway().create(command())).rejects.toThrow(
        'dependency_unavailable',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('placeholders de otras HU', () => {
    // TODO(HU_FLEETOPS_INC_05): reemplazar por pruebas reales de esta HU (consultar por id).
    it('IncidentService.findById responde 501', async () => {
      await expect(buildService().findById('id')).rejects.toBeInstanceOf(
        NotImplementedException,
      );
    });

    // TODO(HU_FLEETOPS_INC_06): reemplazar por pruebas reales de esta HU (listar con filtros).
    it('IncidentService.list responde 501', async () => {
      await expect(
        buildService().list({ page: 0, size: 20 }),
      ).rejects.toBeInstanceOf(NotImplementedException);
    });
  });
});
