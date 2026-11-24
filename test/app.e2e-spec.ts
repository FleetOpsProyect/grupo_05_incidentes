import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

process.env.DATABASE_URL = 'postgresql://e2e:e2e@localhost:5432/e2e';
process.env.LOG_LEVEL = 'silent';

import { AppModule } from '../src/app.module';
import { ASSIGNMENTS_GATEWAY } from '../src/incidents/application/ports/assignments.gateway.port';
import { PrismaService } from '../src/shared/prisma/prisma.service';

const ASSIGNMENT_ID = '3f2b8c1e-5a7d-4e0b-9c64-1d2e3f4a5b6c';

describe('Incident API (e2e, sin BD real)', () => {
  let app: INestApplication<App>;
  const prisma = {
    $queryRaw: jest.fn(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
  };

  // Evita que el cliente HTTP real llame a ASSIGNMENTS_BASE_URL durante el e2e.
  const assignments = { findById: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ASSIGNMENTS_GATEWAY)
      .useValue(assignments)
      .compile();

    app = moduleRef.createNestApplication();
    SwaggerModule.setup(
      'docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('e2e').build(),
      ),
      { jsonDocumentUrl: 'docs-json' },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const VEHICLE_ID = '33333333-3333-4333-8333-333333333333';
  const DRIVER_ID = '44444444-4444-4444-8444-444444444444';
  const body = {
    assignment_id: ASSIGNMENT_ID,
    severity: 'severe',
    description: 'Falla del motor en el km 45',
    reported_at: '2026-10-28T09:30:00-05:00',
  };

  function inProgress(status = 'in_progress') {
    return {
      id: ASSIGNMENT_ID,
      status,
      vehicleId: VEHICLE_ID,
      driverId: DRIVER_ID,
    };
  }

  // Simula la transacción de Prisma: ejecuta el callback con un cliente transaccional falso.
  function mockTransaction() {
    const tx = {
      incident: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(data),
        ),
      },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((work: (t: typeof tx) => unknown) =>
      work(tx),
    );
    return tx;
  }

  beforeEach(() => {
    assignments.findById.mockReset();
    prisma.$transaction.mockReset();
  });

  // HU_01 + HU_02, camino feliz: 201, Location y evento en outbox con vehicle_id/driver_id de la asignación.
  it('POST /incidents con asignación in_progress responde 201, Location y guarda incidente + outbox', async () => {
    assignments.findById.mockResolvedValue(inProgress());
    const tx = mockTransaction();

    const res = await request(app.getHttpServer())
      .post('/incidents')
      .set('X-Correlation-Id', 'corr-e2e')
      .send({ ...body, vehicle_id: 'se-descarta', driver_id: 'se-descarta' })
      .expect(201);

    expect(res.headers['x-correlation-id']).toBe('corr-e2e');
    expect(res.headers.location).toBe(`/incidents/${res.body.incident_id}`);
    expect(res.body).toEqual({
      incident_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      assignment_id: ASSIGNMENT_ID,
      severity: 'severe',
      status: 'reported',
      description: 'Falla del motor en el km 45',
      reported_at: '2026-10-28T09:30:00.000-05:00',
      created_at: expect.stringMatching(/-05:00$/),
    });
    expect(res.body).not.toHaveProperty('vehicle_id');
    expect(assignments.findById).toHaveBeenCalledWith(ASSIGNMENT_ID);
    expect(tx.incident.create.mock.calls[0][0].data).not.toHaveProperty(
      'vehicleId',
    );
    expect(tx.outboxEvent.create.mock.calls[0][0].data).toMatchObject({
      eventType: 'severe_incident_reported_event',
      correlationId: 'corr-e2e',
      data: { vehicle_id: VEHICLE_ID, driver_id: DRIVER_ID },
    });
  });

  it('POST /incidents minor publica minor_incident_reported_event', async () => {
    assignments.findById.mockResolvedValue(inProgress());
    const tx = mockTransaction();

    await request(app.getHttpServer())
      .post('/incidents')
      .send({ ...body, severity: 'minor' })
      .expect(201);

    expect(tx.outboxEvent.create.mock.calls[0][0].data.eventType).toBe(
      'minor_incident_reported_event',
    );
  });

  // CA HU_02: Asignaciones responde 404 → 404 assignment_not_found, sin guardar.
  it('POST /incidents con asignación inexistente responde 404 assignment_not_found', async () => {
    assignments.findById.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send(body)
      .expect(404);

    expect(res.body).toMatchObject({
      code: 'assignment_not_found',
      path: '/incidents',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // CA HU_02: estado distinto de in_progress → 409 assignment_not_in_progress, sin guardar.
  it.each(['pending', 'finished', 'interrupted_by_incident', 'cancelled'])(
    'POST /incidents con asignación %s responde 409 assignment_not_in_progress',
    async (status) => {
      assignments.findById.mockResolvedValue(inProgress(status));

      const res = await request(app.getHttpServer())
        .post('/incidents')
        .send(body)
        .expect(409);

      expect(res.body).toMatchObject({
        code: 'assignment_not_in_progress',
        message: 'La asignación no está en curso.',
        path: '/incidents',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  // CA HU_02: assignment_id no UUID → 400 validation_error sin llamar a Asignaciones.
  it('POST /incidents con assignment_id no UUID responde 400 y no llama a Asignaciones', async () => {
    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send({ ...body, assignment_id: 'no-es-uuid' })
      .expect(400);

    expect(res.body.errors).toEqual([
      { field: 'assignment_id', code: 'invalid_format' },
    ]);
    expect(assignments.findById).not.toHaveBeenCalled();
  });

  // CA HU_02 / integración: Asignaciones no responde → 503, no se guarda el incidente.
  it('POST /incidents con Asignaciones caída responde 503 dependency_unavailable', async () => {
    assignments.findById.mockRejectedValue(
      new ServiceUnavailableException({ code: 'dependency_unavailable' }),
    );

    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send(body)
      .expect(503);

    expect(res.body.code).toBe('dependency_unavailable');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // CA HU_01: error no controlado → 500 internal_error sin trazas.
  it('POST /incidents con la BD caída responde 500 internal_error sin trazas', async () => {
    assignments.findById.mockResolvedValue(inProgress());
    prisma.$transaction.mockRejectedValue(new Error('ECONNREFUSED db'));

    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send(body)
      .expect(500);

    expect(res.body).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
      timestamp: expect.stringMatching(/-05:00$/),
      path: '/incidents',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|\bat /);
  });

  // CA HU_01: reported_at posterior a ahora + tolerancia → 422 reported_at_in_future.
  it('POST /incidents con reported_at futura responde 422 reported_at_in_future', async () => {
    prisma.$transaction.mockClear();

    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send({
        assignment_id: ASSIGNMENT_ID,
        severity: 'severe',
        description: 'Colisión',
        reported_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(422);

    expect(res.body).toMatchObject({
      code: 'reported_at_in_future',
      path: '/incidents',
    });
    expect(assignments.findById).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // CA HU_01: reported_at sin offset es formato inválido (400), no 422.
  it('POST /incidents con reported_at sin offset responde 400 invalid_format', async () => {
    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send({
        assignment_id: ASSIGNMENT_ID,
        severity: 'minor',
        description: 'x',
        reported_at: '2026-10-28T09:30:00',
      })
      .expect(400);

    expect(res.body.errors).toEqual([
      { field: 'reported_at', code: 'invalid_format' },
    ]);
  });

  it('POST /incidents inválido responde 400 con errors[] {field, code}', async () => {
    const res = await request(app.getHttpServer())
      .post('/incidents')
      .send({
        assignment_id: ASSIGNMENT_ID,
        severity: 'urgent',
        reported_at: '2026-10-28T09:30:00-05:00',
      })
      .expect(400);

    expect(res.body).toMatchObject({
      code: 'validation_error',
      message: 'La solicitud tiene campos inválidos.',
      path: '/incidents',
    });
    expect(res.body.errors).toEqual([
      { field: 'severity', code: 'invalid_value' },
      { field: 'description', code: 'required' },
    ]);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /incidents/{id} con id no UUID responde 400 con field id', async () => {
    const res = await request(app.getHttpServer())
      .get('/incidents/abc')
      .expect(400);

    expect(res.body.errors).toEqual([{ field: 'id', code: 'invalid_format' }]);
  });

  it('GET /incidents/{id} responde 501', async () => {
    await request(app.getHttpServer())
      .get(`/incidents/${ASSIGNMENT_ID}`)
      .expect(501);
  });

  it('GET /incidents responde 501 y valida los query params', async () => {
    await request(app.getHttpServer()).get('/incidents').expect(501);
    await request(app.getHttpServer()).get('/incidents?size=0').expect(400);
  });

  it('GET /health responde 200 con la BD arriba y 503 si cae', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const ok = await request(app.getHttpServer()).get('/health').expect(200);
    expect(ok.body.status).toBe('ok');
    expect(ok.body.info.database.status).toBe('up');

    prisma.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
    const down = await request(app.getHttpServer()).get('/health').expect(503);
    expect(down.body.code).toBe('dependency_unavailable');
  });

  it('GET /metrics responde formato Prometheus', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(res.text).toContain('# HELP');
    expect(res.text).toContain(
      'http_request_duration_seconds_count{method="POST",route="/incidents",status_code="500"}',
    );
    expect(res.text).not.toMatch(/route="\/(metrics|health)"/);
  });

  it('Swagger documenta los 5 endpoints', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    expect(Object.keys(res.body.paths).sort()).toEqual([
      '/health',
      '/incidents',
      '/incidents/{id}',
      '/metrics',
    ]);
    expect(Object.keys(res.body.paths['/incidents'])).toEqual(['post', 'get']);
  });
});
