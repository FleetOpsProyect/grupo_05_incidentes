import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosHeaders, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { getCorrelationId } from '../../shared/context/correlation-context';
import { AssignmentsHttpClient } from './assignments-http.client';

jest.mock('../../shared/context/correlation-context', () => ({
  getCorrelationId: jest.fn(),
}));

// HU_FLEETOPS_INC_02: consulta síncrona GET /assignment/{id} a Asignaciones (G2).
describe('AssignmentsHttpClient', () => {
  const ID = '22222222-2222-4222-8222-222222222222';
  const get = jest.fn();
  const http = { get } as unknown as HttpService;
  const config = {
    getOrThrow: jest.fn().mockReturnValue('http://assignments:3001'),
  } as unknown as ConfigService;
  const client = new AssignmentsHttpClient(http, config);
  const correlation = getCorrelationId as jest.Mock;

  function httpError(status?: number, code?: string): AxiosError {
    const error = new AxiosError('boom', code);
    if (status) {
      error.response = {
        status,
        data: {},
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
      } as AxiosResponse;
    }
    return error;
  }

  beforeEach(() => {
    get.mockReset();
    correlation.mockReturnValue('corr-1');
  });

  // CA: GET {ASSIGNMENTS_BASE_URL}/assignment/{id} propagando X-Correlation-Id.
  it('llama GET /assignment/{id} en la URL base configurada con X-Correlation-Id', async () => {
    get.mockReturnValue(
      of({ data: { status: 'in_progress', vehicle_id: 'v', driver_id: 'd' } }),
    );

    await client.findById(ID);

    expect(get).toHaveBeenCalledWith(
      `http://assignments:3001/assignment/${ID}`,
      {
        headers: { 'X-Correlation-Id': 'corr-1' },
      },
    );
  });

  it('no envía X-Correlation-Id si no hay contexto de petición', async () => {
    correlation.mockReturnValue(undefined);
    get.mockReturnValue(
      of({ data: { status: 'in_progress', vehicle_id: 'v', driver_id: 'd' } }),
    );

    await client.findById(ID);

    expect(get).toHaveBeenCalledWith(expect.any(String), { headers: {} });
  });

  // CA: Incidentes nunca modifica la asignación: solo hace GET.
  it('solo usa GET: nunca POST, PUT, PATCH ni DELETE', async () => {
    const forbidden = {
      get,
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    };
    const guarded = new AssignmentsHttpClient(
      forbidden as unknown as HttpService,
      config,
    );
    get.mockReturnValue(
      of({ data: { status: 'in_progress', vehicle_id: 'v', driver_id: 'd' } }),
    );

    await guarded.findById(ID);

    expect(forbidden.post).not.toHaveBeenCalled();
    expect(forbidden.put).not.toHaveBeenCalled();
    expect(forbidden.patch).not.toHaveBeenCalled();
    expect(forbidden.delete).not.toHaveBeenCalled();
  });

  // CA: traduce status, vehicle_id y driver_id al modelo interno (capa anticorrupción).
  it('mapea la respuesta al modelo interno', async () => {
    get.mockReturnValue(
      of({
        data: {
          status: 'in_progress',
          vehicle_id: 'vehicle-1',
          driver_id: 'driver-1',
          otro_campo: 'se ignora',
        },
      }),
    );

    await expect(client.findById(ID)).resolves.toEqual({
      id: ID,
      status: 'in_progress',
      vehicleId: 'vehicle-1',
      driverId: 'driver-1',
    });
  });

  // CA: 404 de Asignaciones → null (el validador responde assignment_not_found).
  it('devuelve null cuando Asignaciones responde 404', async () => {
    get.mockReturnValue(throwError(() => httpError(404)));

    await expect(client.findById(ID)).resolves.toBeNull();
  });

  // Integración: timeout, error de red, 5xx u otros 4xx → 503 dependency_unavailable.
  it.each([
    ['timeout', httpError(undefined, 'ECONNABORTED')],
    ['error de red', httpError(undefined, 'ECONNREFUSED')],
    ['500', httpError(500)],
    ['401', httpError(401)],
  ])('responde 503 dependency_unavailable ante %s', async (_name, error) => {
    get.mockReturnValue(throwError(() => error));

    await expect(client.findById(ID)).rejects.toMatchObject({
      status: 503,
      response: { code: 'dependency_unavailable' },
    });
  });

  it.each([
    ['sin status', { vehicle_id: 'v', driver_id: 'd' }],
    ['sin vehicle_id', { status: 'in_progress', driver_id: 'd' }],
    ['sin driver_id', { status: 'in_progress', vehicle_id: 'v' }],
    ['vacía', undefined],
  ])(
    'responde 503 si la respuesta de Asignaciones viene %s',
    async (_name, data) => {
      get.mockReturnValue(of({ data }));

      await expect(client.findById(ID)).rejects.toMatchObject({ status: 503 });
    },
  );
});
