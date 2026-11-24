import { ConfigService } from '@nestjs/config';
import { Severity } from '../../domain/severity';
import { CreateIncidentContext } from './create-incident.context';
import { ReportedAtNotInFutureValidator } from './reported-at-not-in-future.validator';

// HU_FLEETOPS_INC_01, regla 422 (DAS v3.2): reported_at no puede superar la hora actual + tolerancia.
describe('ReportedAtNotInFutureValidator', () => {
  const NOW = new Date('2026-10-28T15:00:00.000Z');
  const TOLERANCE_MS = 300000;

  function validator(tolerance: number | undefined = TOLERANCE_MS) {
    const config = {
      get: jest.fn((_key: string, fallback: number) => tolerance ?? fallback),
    };
    return {
      validator: new ReportedAtNotInFutureValidator(
        config as unknown as ConfigService,
      ),
      config,
    };
  }

  function contextAt(offsetMs: number): CreateIncidentContext {
    return {
      assignmentId: 'a',
      severity: Severity.Minor,
      description: 'd',
      reportedAt: new Date(NOW.getTime() + offsetMs),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('acepta una fecha pasada', async () => {
    await expect(
      validator().validator.handle(contextAt(-3_600_000)),
    ).resolves.toBeUndefined();
  });

  it('acepta una fecha futura dentro de la tolerancia', async () => {
    await expect(
      validator().validator.handle(contextAt(TOLERANCE_MS - 1000)),
    ).resolves.toBeUndefined();
  });

  it('acepta exactamente el límite de la tolerancia', async () => {
    await expect(
      validator().validator.handle(contextAt(TOLERANCE_MS)),
    ).resolves.toBeUndefined();
  });

  it('rechaza con 422 reported_at_in_future por encima de la tolerancia', async () => {
    await expect(
      validator().validator.handle(contextAt(TOLERANCE_MS + 1)),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'reported_at_in_future' },
    });
  });

  it('respeta una tolerancia configurada (0 ms rechaza cualquier futuro)', async () => {
    await expect(
      validator(0).validator.handle(contextAt(1)),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lee la variable REPORTED_AT_FUTURE_TOLERANCE_MS con 5 minutos por defecto', async () => {
    const { validator: v, config } = validator();

    await v.handle(contextAt(0));

    expect(config.get).toHaveBeenCalledWith(
      'REPORTED_AT_FUTURE_TOLERANCE_MS',
      300000,
    );
  });

  it('delega en el siguiente validador cuando la fecha es válida', async () => {
    const { validator: first } = validator();
    const seen: string[] = [];
    class Next extends ReportedAtNotInFutureValidator {
      protected override validate(): Promise<void> {
        seen.push('next');
        return Promise.resolve();
      }
    }
    first.setNext(new Next({ get: jest.fn() } as unknown as ConfigService));

    await first.handle(contextAt(0));

    expect(seen).toEqual(['next']);
  });
});
