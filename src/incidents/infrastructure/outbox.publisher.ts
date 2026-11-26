import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
} from '../application/ports/event.publisher.port';
import { IncidentEvent } from '../domain/events/incident-event';
import { toBogotaIso } from '../domain/incident';

export const OUTBOX_BATCH_SIZE = 10;
// Mayor que el peor caso de un lote (10 publicaciones de hasta 3 s).
export const OUTBOX_LEASE_SECONDS = 60;
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;
// Largo de outbox_events.last_error: si se desborda, no se podría registrar el fallo.
const LAST_ERROR_MAX_LENGTH = 500;

export interface PendingOutboxEvent {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  source: string;
  correlationId: string;
  data: unknown;
  attempts: number;
}

function toEnvelope(row: PendingOutboxEvent): IncidentEvent<string, unknown> {
  return {
    event_id: row.eventId,
    event_type: row.eventType,
    occurred_at: toBogotaIso(row.occurredAt),
    source: row.source as 'incident',
    correlation_id: row.correlationId,
    data: row.data,
  };
}

function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, LAST_ERROR_MAX_LENGTH);
}

// Publica los eventos pendientes de outbox_events (DAS ADR-07). La entrega es al menos una
// vez: si falla el marcado tras publicar, se reenvía y el consumidor deduplica por event_id.
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly config: ConfigService,
  ) {}

  async publishPending(): Promise<void> {
    for (const row of await this.claimPending()) {
      try {
        await this.publishOne(row);
      } catch (error) {
        // Falló la BD al marcar: el evento vuelve a reclamarse cuando venza el lease.
        this.logger.error({
          event: 'outbox_update_failed',
          event_id: row.eventId,
          error: describeError(error),
        });
      }
    }
  }

  // SKIP LOCKED solo bloquea hasta el commit, y una transacción abierta durante la llamada a
  // SNS excedería el timeout de Prisma. Por eso el reclamo es una sola sentencia que deja un
  // lease en next_attempt_at: otra instancia no toma estos eventos mientras se publican.
  private async claimPending(): Promise<PendingOutboxEvent[]> {
    const rows = await this.prisma.$queryRaw<PendingOutboxEvent[]>`
      UPDATE outbox_events
      SET next_attempt_at = now() + make_interval(secs => ${OUTBOX_LEASE_SECONDS})
      WHERE event_id IN (
        SELECT event_id FROM outbox_events
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY occurred_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${OUTBOX_BATCH_SIZE}
      )
      RETURNING
        event_id AS "eventId",
        event_type AS "eventType",
        occurred_at AS "occurredAt",
        source,
        correlation_id AS "correlationId",
        data,
        attempts`;
    // RETURNING no garantiza orden.
    return rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  private async publishOne(row: PendingOutboxEvent): Promise<void> {
    let messageId: string;
    try {
      messageId = await this.publisher.publish(toEnvelope(row));
    } catch (error) {
      await this.scheduleRetry(row, describeError(error));
      return;
    }

    this.logger.log({
      event: 'outbox_event_published',
      event_type: row.eventType,
      event_id: row.eventId,
      message_id: messageId,
      correlation_id: row.correlationId,
    });
    await this.prisma.outboxEvent.update({
      where: { eventId: row.eventId },
      data: { publishedAt: new Date(), messageId, lastError: null },
    });
  }

  // El incidente nunca se revierte ni el evento se descarta: se reintenta con espera creciente.
  private async scheduleRetry(
    row: PendingOutboxEvent,
    lastError: string,
  ): Promise<void> {
    const baseMs = this.config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    const delayMs = Math.min(baseMs * 2 ** row.attempts, OUTBOX_MAX_BACKOFF_MS);

    // Sin data ni description en el log.
    this.logger.warn({
      event: 'outbox_publish_failed',
      event_id: row.eventId,
      event_type: row.eventType,
      correlation_id: row.correlationId,
      attempts: row.attempts + 1,
      retry_in_ms: delayMs,
      error: lastError,
    });
    await this.prisma.outboxEvent.update({
      where: { eventId: row.eventId },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError,
      },
    });
  }
}
