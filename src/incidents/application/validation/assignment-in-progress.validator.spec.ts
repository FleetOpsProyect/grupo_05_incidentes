import { Severity } from '../../domain/severity';
import {
  AssignmentsGateway,
  AssignmentSummary,
} from '../ports/assignments.gateway.port';
import { AssignmentInProgressValidator } from './assignment-in-progress.validator';
import { CreateIncidentContext } from './create-incident.context';

// HU_FLEETOPS_INC_02: validar que la asignación exista y esté en curso (in_progress).
describe('AssignmentInProgressValidator', () => {
  const findById = jest.fn<
    ReturnType<AssignmentsGateway['findById']>,
    Parameters<AssignmentsGateway['findById']>
  >();
  const validator = new AssignmentInProgressValidator({ findById });

  const assignment = (status: string): AssignmentSummary => ({
    id: '22222222-2222-4222-8222-222222222222',
    status,
    vehicleId: '33333333-3333-4333-8333-333333333333',
    driverId: '44444444-4444-4444-8444-444444444444',
  });

  const context = (): CreateIncidentContext => ({
    assignmentId: '22222222-2222-4222-8222-222222222222',
    severity: Severity.Minor,
    description: 'd',
    reportedAt: new Date(),
  });

  beforeEach(() => {
    findById.mockReset();
  });

  // CA: consulta Asignaciones con el assignment_id recibido.
  it('consulta la asignación por su id', async () => {
    findById.mockResolvedValue(assignment('in_progress'));
    const ctx = context();

    await validator.handle(ctx);

    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(ctx.assignmentId);
  });

  // CA: 404 de Asignaciones → 404 assignment_not_found.
  it('responde 404 assignment_not_found si la asignación no existe', async () => {
    findById.mockResolvedValue(null);

    await expect(validator.handle(context())).rejects.toMatchObject({
      status: 404,
      response: { code: 'assignment_not_found' },
    });
  });

  // CA: estado distinto de in_progress → 409 assignment_not_in_progress.
  it.each(['pending', 'finished', 'interrupted_by_incident', 'cancelled', ''])(
    'responde 409 assignment_not_in_progress si el estado es "%s"',
    async (status) => {
      findById.mockResolvedValue(assignment(status));

      await expect(validator.handle(context())).rejects.toMatchObject({
        status: 409,
        response: { code: 'assignment_not_in_progress' },
      });
    },
  );

  // CA: in_progress → toma vehicle_id y driver_id de la respuesta de Asignaciones.
  it('con la asignación in_progress deja vehicle_id y driver_id en el contexto', async () => {
    findById.mockResolvedValue(assignment('in_progress'));
    const ctx = context();

    await validator.handle(ctx);

    expect(ctx.vehicleId).toBe('33333333-3333-4333-8333-333333333333');
    expect(ctx.driverId).toBe('44444444-4444-4444-8444-444444444444');
  });

  // CA: en 404 y 409 no se llena el contexto (nada que publicar).
  it('no llena vehicle_id ni driver_id cuando rechaza', async () => {
    findById.mockResolvedValue(assignment('finished'));
    const ctx = context();

    await expect(validator.handle(ctx)).rejects.toBeDefined();

    expect(ctx.vehicleId).toBeUndefined();
    expect(ctx.driverId).toBeUndefined();
  });

  // CA: si Asignaciones no responde (503 del adaptador) el error se propaga sin tocar el contexto.
  it('propaga el error de dependencia no disponible', async () => {
    findById.mockRejectedValue(new Error('dependency_unavailable'));

    await expect(validator.handle(context())).rejects.toThrow(
      'dependency_unavailable',
    );
  });

  it('sigue con el siguiente validador cuando la asignación está en curso', async () => {
    findById.mockResolvedValue(assignment('in_progress'));
    const seen: Array<string | undefined> = [];
    class Next extends AssignmentInProgressValidator {
      constructor() {
        super({ findById });
      }

      protected override validate(ctx: CreateIncidentContext): Promise<void> {
        seen.push(ctx.vehicleId);
        return Promise.resolve();
      }
    }
    validator.setNext(new Next());

    await validator.handle(context());

    expect(seen).toEqual(['33333333-3333-4333-8333-333333333333']);
  });
});
