# FleetOps · Incident Service (Grupo 5)

Microservicio de Incidentes. NestJS 12 (CommonJS) · TypeScript 6.0 · Prisma 7 · PostgreSQL 18 · Jest.
Este repositorio es el **arquetipo**: capas, configuración y endpoints existen, pero la lógica de negocio responde `501 not_implemented` hasta que se desarrollen las HU. La guía de proceso está en [`docs/GUIA_SETUP_FLEETOPS_INCIDENT.md`](docs/GUIA_SETUP_FLEETOPS_INCIDENT.md).

## Requisitos

- Node.js **24** (`.nvmrc`).
- **pnpm**. La versión está fijada en `package.json` (`packageManager`). Actívala con:

  ```bash
  corepack enable
  ```

## Puesta en marcha

```bash
pnpm install --frozen-lockfile
cp .env.example .env        # y poner la DATABASE_URL real de la BD de pruebas compartida
pnpm prisma:generate
pnpm start:dev
```

- Swagger: <http://localhost:3000/docs> · JSON del contrato: `/docs-json`
- Métricas: `GET /metrics` (incluye `http_request_duration_seconds` con labels `method`, `route`, `status_code`)
- Salud: `GET /health`

### Formato de `/health`

Es el de Terminus. Con la BD arriba responde `200`:

```json
{ "status": "ok", "info": { "database": { "status": "up" } }, "error": {}, "details": { "database": { "status": "up" } } }
```

Si `SELECT 1` falla, responde `503` con el formato estándar de errores del servicio
(`{"code": "dependency_unavailable", "message": "Service Unavailable Exception", "timestamp": …, "path": "/health"}`).
El cuerpo propio de Terminus (`"status": "error"`) solo se ve en los logs.

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm build` | `prisma generate` + `nest build` |
| `pnpm start:dev` / `start:prod` | Arranque en desarrollo / sobre `dist/` |
| `pnpm lint` · `pnpm format` | ESLint 10 + typescript-eslint · Prettier |
| `pnpm test` · `test:cov` · `test:ci` | Pruebas unitarias · con cobertura · modo CI |
| `pnpm test:e2e` | Pruebas e2e (Prisma mockeado, no tocan la BD) |
| `pnpm prisma:migrate:deploy` · `prisma:migrate:status` | Migraciones contra la BD configurada |

**Linter:** ESLint 10 con `typescript-eslint` (configuración flat en `eslint.config.mjs`).

**Jest y paquetes ESM:** NestJS 12 se publica solo como ESM. En ejecución, Node 24 lo carga desde CommonJS sin flags. Jest lo necesita con `--experimental-vm-modules`, por eso los scripts de prueba llaman a Jest vía `node --experimental-vm-modules`. No ejecutes `jest` directamente: usa `pnpm test`.

**`tsconfig`:** `moduleResolution: node10` está deprecado en TS 6; se mantiene (ADR-03) con `ignoreDeprecations: "6.0"`. TypeScript 7 no es compatible, por eso va fijado `~6.0`.

## Pruebas

Las pruebas unitarias no necesitan BD, red ni SNS. Umbrales de cobertura: 80 % global y 100 % de líneas en `domain` y `application` (`jest.config.ts`).

Las pruebas `placeholder 501` solo sostienen la cobertura del arquetipo; cada HU debe borrar las suyas y reemplazarlas por pruebas del comportamiento real en el mismo PR.

## Variables de entorno

Se validan con Joi al arrancar (`src/shared/config/env.validation.ts`); la plantilla es `.env.example`.

| Variable | Regla | Por defecto |
|---|---|---|
| `DATABASE_URL` | URL `postgresql://` · **obligatoria** | — |
| `NODE_ENV`, `PORT`, `TZ`, `SWAGGER_ENABLED`, `LOG_LEVEL` | `LOG_LEVEL`: fatal, error, warn, info, debug, trace, silent | development, 3000, America/Bogota, true, info |
| `ASSIGNMENTS_BASE_URL`, `VEHICLES_BASE_URL` | URL http/https · **obligatorias en producción** | — |
| `HTTP_TIMEOUT_MS` | entero ≥ 100 | 3000 |
| `CIRCUIT_BREAKER_ERROR_THRESHOLD` | entero 1–100 | 50 |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | entero ≥ 1000 | 10000 |
| `AWS_REGION` | texto | us-east-1 |
| `SNS_TOPIC_ARN` | `arn:aws:sns:<región>:<12 dígitos>:fleetops_incident_events` · **obligatoria en producción** | — |
| `AWS_ENDPOINT_URL` | URL o vacío; solo local con LocalStack | — |
| `OUTBOX_POLL_INTERVAL_MS` | entero ≥ 1000 | 5000 |

## LocalStack (SNS/SQS locales)

`docker compose up` levanta Postgres, la migración, la app y LocalStack (`localstack/localstack:4`, solo SNS y SQS, puerto 4566). El script `docker/localstack/init-aws.sh` (montado en `/etc/localstack/init/ready.d/`) crea:

- el topic `fleetops_incident_events`,
- la cola `incident_events_test_queue`,
- una suscripción SQS al topic con raw message delivery.

La app recibe `AWS_ENDPOINT_URL=http://localstack:4566`, `AWS_REGION`, `SNS_TOPIC_ARN` y credenciales ficticias. El script debe tener permiso de ejecución (`chmod +x`).

Para leer lo publicado en la cola de prueba:

```bash
docker compose exec localstack awslocal sqs receive-message --message-attribute-names All \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/incident_events_test_queue
```

## Publicación de eventos (outbox)

El incidente y su evento se guardan en la misma transacción. `OutboxPublisher` publica los pendientes de `outbox_events` cada `OUTBOX_POLL_INTERVAL_MS` (DAS ADR-06 y ADR-07).

- **Reclamo:** hasta 10 eventos con `FOR UPDATE SKIP LOCKED`, con un lease de 60 s en `next_attempt_at` para que otra instancia no los tome mientras se publican.
- **Publicación:** `SnsEventPublisher` envía el sobre JSON al topic, con el atributo `event_type`. Cada publicación se aborta a los 3 s.
- **Éxito:** se guardan `published_at` y `message_id`.
- **Fallo:** el incidente no se revierte. Sube `attempts`, se guarda `last_error` y el reintento se aplaza con espera creciente: `OUTBOX_POLL_INTERVAL_MS × 2^intentos previos`, con un máximo de 5 minutos. Ningún evento se descarta.
- **Entrega al menos una vez:** un evento puede llegar repetido. Los consumidores deduplican por `event_id`.

El sondeo no arranca sin `SNS_TOPIC_ARN` (los eventos quedan pendientes) ni con `NODE_ENV=test`. En EC2, `AWS_ENDPOINT_URL` va vacío y las credenciales salen del IAM role. Fuera de Docker y contra LocalStack hay que definir `AWS_ACCESS_KEY_ID=test` y `AWS_SECRET_ACCESS_KEY=test`.

> **No actives la publicación contra la BD compartida desde tu equipo.** Tu LocalStack recibiría eventos de otras personas y quedarían marcados como publicados. Para probar el outbox usa el Postgres local de `docker compose`.

### Probar el publicador sin pasar por la API

```bash
docker compose build app && docker compose up -d

docker compose exec db psql -U incident -d incident <<'SQL'
WITH i AS (
  INSERT INTO incidents (id, assignment_id, severity, description, reported_at)
  VALUES (gen_random_uuid(), gen_random_uuid(), 'severe', 'Prueba de outbox', now())
  RETURNING id, assignment_id, severity, description, reported_at
)
INSERT INTO outbox_events (event_id, incident_id, event_type, occurred_at, correlation_id, data)
SELECT gen_random_uuid(), id, 'severe_incident_reported_event', now(), 'prueba-outbox',
       jsonb_build_object('incident_id', id, 'assignment_id', assignment_id,
         'vehicle_id', gen_random_uuid(), 'driver_id', gen_random_uuid(),
         'severity', severity, 'description', description,
         'reported_at', '2026-10-27T09:29:55-05:00')
FROM i;
SQL

docker compose exec db psql -U incident -d incident -c \
  "select event_type, attempts, next_attempt_at, published_at, message_id, last_error from outbox_events order by occurred_at"
```

Para simular la caída de SNS: `docker compose stop localstack`, inserta otro evento y observa cómo crece `attempts`. Con `docker compose start localstack`, el evento se publica en el siguiente reintento.

## Estructura (ADR-02)

`api → application → domain`; `infrastructure` implementa los puertos de `application`. Un controlador nunca importa de `infrastructure`.

```
src/incidents/{api,application,domain,infrastructure}   · lógica del servicio
src/shared                                              · Prisma, config, middlewares, filtro de errores
src/health · src/metrics                                · /health y /metrics
prisma/                                                 · schema y migraciones
```

Lo que aún no tiene HU (por ejemplo el cliente HTTP de Vehículos y las consultas de `PrismaIncidentRepository`) son stubs marcados con `TODO(HU_FLEETOPS_INC_xx)`.

## Base de datos compartida

El equipo usa una BD de pruebas compartida. Su `DATABASE_URL` va **solo** en tu `.env` local (ignorado por git).

- Aplica migraciones **únicamente** con `pnpm prisma:migrate:deploy`.
- **Nunca** ejecutes `prisma migrate dev` ni `prisma migrate reset` contra esa BD: `reset` borra los datos de todos.
- Los CHECK de la BD viven solo en `prisma/migrations/*/migration.sql`; Prisma no los modela.
- Las pruebas unitarias y e2e no necesitan BD.

## Calidad: SonarCloud

Pasos manuales (los hace un admin del repo, guía §5):

1. Importar el repo en <https://sonarcloud.io> y desactivar **Administration → Analysis Method → Automatic Analysis**.
2. Copiar `organization` y `projectKey` a `sonar-project.properties` (hoy son placeholders `<org-en-sonarcloud>`).
3. Crear el secreto `SONAR_TOKEN` en GitHub (Settings → Secrets and variables → Actions).

Las exclusiones de cobertura de `jest.config.ts` y `sonar.coverage.exclusions` deben mantenerse iguales.

## CI / CD

- `.github/workflows/ci.yml`: en cada PR a `develop`/`main` y push a `develop`/`main` corre `build-and-test` (lint, build, pruebas con cobertura) y `sonarcloud`.
- `.github/workflows/cd.yml`: construye y publica la imagen en Docker Hub y despliega en EC2. **Está inactivo** hasta definir la variable de repositorio `CD_ENABLED=true` y los secretos de la guía §14.1.
- `Dockerfile`, `docker-compose.yml` (local) y `docker-compose.prod.yml` (EC2) siguen la guía §2.7 y §9.3.
