import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { EventPublisher } from '../application/ports/event.publisher.port';
import {
  OUTBOX_MAX_BACKOFF_MS,
  OutboxPublisher,
  PendingOutboxEvent,
} from './outbox.publisher';

const NOW = new Date('2026-10-27T15:00:00.000Z');

function pending(
  overrides: Partial<PendingOutboxEvent> = {},
): PendingOutboxEvent {
  return {
    eventId: 'evt-1',
    eventType: 'severe_incident_reported_event',
    occurredAt: new Date('2026-10-27T14:30:02.000Z'),
    source: 'incident',
    correlationId: 'corr-1',
    data: { incident_id: 'i-1', description: 'Falla del motor' },
    attempts: 0,
    ...overrides,
  };
}

describe('OutboxPublisher', () => {
  let queryRaw: jest.Mock;
  let update: jest.Mock;
  let publish: jest.Mock;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let outbox: OutboxPublisher;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    queryRaw = jest.fn().mockResolvedValue([pending()]);
    update = jest.fn().mockResolvedValue({});
    publish = jest.fn().mockResolvedValue('msg-1');
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    outbox = new OutboxPublisher(
      {
        $queryRaw: queryRaw,
        outboxEvent: { update },
      } as unknown as PrismaService,
      { publish } as EventPublisher,
      { getOrThrow: () => 5000 } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reclama los pendientes con FOR UPDATE SKIP LOCKED', async () => {
    await outbox.publishPending();

    const sql = (queryRaw.mock.calls[0] as [string[]])[0].join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('published_at IS NULL');
    expect(sql).toContain('next_attempt_at <= now()');
  });

  it('publica el sobre estándar con occurred_at en -05:00 y sin version', async () => {
    await outbox.publishPending();

    expect(publish).toHaveBeenCalledWith({
      event_id: 'evt-1',
      event_type: 'severe_incident_reported_event',
      occurred_at: '2026-10-27T09:30:02.000-05:00',
      source: 'incident',
      correlation_id: 'corr-1',
      data: { incident_id: 'i-1', description: 'Falla del motor' },
    });
  });

  it('marca el evento con el MessageId y lo registra en el log', async () => {
    await outbox.publishPending();

    expect(update).toHaveBeenCalledWith({
      where: { eventId: 'evt-1' },
      data: { publishedAt: NOW, messageId: 'msg-1', lastError: null },
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'severe_incident_reported_event',
        event_id: 'evt-1',
        message_id: 'msg-1',
      }),
    );
  });

  it('ante un fallo deja el evento pendiente, suma un intento y no registra data', async () => {
    publish.mockRejectedValue(new Error('SNS caído'));

    await outbox.publishPending();

    expect(update).toHaveBeenCalledWith({
      where: { eventId: 'evt-1' },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(NOW.getTime() + 5000),
        lastError: 'Error: SNS caído',
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'evt-1', attempts: 1 }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Falla del motor');
  });

  it.each([
    [1, 10000],
    [3, 40000],
    [20, OUTBOX_MAX_BACKOFF_MS],
  ])(
    'con %i intentos previos espera %i ms antes de reintentar',
    async (attempts, delayMs) => {
      queryRaw.mockResolvedValue([pending({ attempts })]);
      publish.mockRejectedValue('timeout');

      await outbox.publishPending();

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextAttemptAt: new Date(NOW.getTime() + delayMs),
          }),
        }),
      );
    },
  );

  it('trunca last_error a 500 caracteres', async () => {
    publish.mockRejectedValue(new Error('x'.repeat(2000)));

    await outbox.publishPending();

    const [[args]] = update.mock.calls as [[{ data: { lastError: string } }]];
    expect(args.data.lastError).toHaveLength(500);
  });

  it('publica en orden de occurred_at y un fallo no detiene el lote', async () => {
    queryRaw.mockResolvedValue([
      pending({
        eventId: 'segundo',
        occurredAt: new Date('2026-10-27T14:31:00Z'),
      }),
      pending({
        eventId: 'primero',
        occurredAt: new Date('2026-10-27T14:30:00Z'),
      }),
    ]);
    publish
      .mockRejectedValueOnce(new Error('falla'))
      .mockResolvedValue('msg-2');
    update.mockRejectedValueOnce(new Error('BD caída'));

    await outbox.publishPending();

    expect(
      publish.mock.calls.map(
        ([event]) => (event as { event_id: string }).event_id,
      ),
    ).toEqual(['primero', 'segundo']);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'outbox_update_failed',
        event_id: 'primero',
      }),
    );
  });

  it('no publica nada cuando no hay pendientes', async () => {
    queryRaw.mockResolvedValue([]);

    await outbox.publishPending();

    expect(publish).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
