import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { ConfigService } from '@nestjs/config';
import { IncidentEvent } from '../domain/events/incident-event';
import { SnsEventPublisher } from './sns-event.publisher';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:fleetops_incident_events';

const event: IncidentEvent<string, unknown> = {
  event_id: '8f14e45f-ceea-4f2a-9b1e-6a5c2d3b4e10',
  event_type: 'severe_incident_reported_event',
  occurred_at: '2026-10-27T09:30:02.000-05:00',
  source: 'incident',
  correlation_id: '6f1c2b7e-3d4a-4b5c-9d6e-7f8a9b0c1d2e',
  data: { incident_id: 'i' },
};

function publisherWith(env: Record<string, string | undefined>) {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new SnsEventPublisher(config);
}

const env = { AWS_REGION: 'us-east-1', SNS_TOPIC_ARN: TOPIC_ARN };

describe('SnsEventPublisher', () => {
  let send: jest.SpyInstance;

  beforeEach(() => {
    send = jest
      .spyOn(SNSClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({ MessageId: 'msg-1' }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('publica el sobre como cuerpo con el atributo event_type y devuelve el MessageId', async () => {
    await expect(publisherWith(env).publish(event)).resolves.toBe('msg-1');

    const [command, options] = send.mock.calls[0] as [
      PublishCommand,
      { abortSignal: AbortSignal },
    ];
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command.input.TopicArn).toBe(TOPIC_ARN);
    expect(JSON.parse(command.input.Message as string)).toEqual(event);
    expect(command.input.MessageAttributes).toEqual({
      event_type: {
        DataType: 'String',
        StringValue: 'severe_incident_reported_event',
      },
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('falla si SNS no devuelve MessageId', async () => {
    send.mockImplementation(() => Promise.resolve({}));

    await expect(publisherWith(env).publish(event)).rejects.toThrow(
      'MessageId',
    );
  });

  it('propaga el error cuando SNS no está disponible', async () => {
    send.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(publisherWith(env).publish(event)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('falla sin llamar a SNS cuando no hay SNS_TOPIC_ARN', async () => {
    await expect(
      publisherWith({ AWS_REGION: 'us-east-1' }).publish(event),
    ).rejects.toThrow('SNS_TOPIC_ARN');
    expect(send).not.toHaveBeenCalled();
  });

  it('usa AWS_ENDPOINT_URL solo cuando trae valor (LocalStack)', async () => {
    const local = publisherWith({
      ...env,
      AWS_ENDPOINT_URL: 'http://localhost:4566',
    });
    const cloud = publisherWith({ ...env, AWS_ENDPOINT_URL: '' });

    const endpointOf = (publisher: SnsEventPublisher) =>
      publisher['client'].config.endpoint?.();
    await expect(endpointOf(local)).resolves.toMatchObject({
      hostname: 'localhost',
      port: 4566,
    });
    expect(endpointOf(cloud)).toBeUndefined();
  });

  it('libera el cliente al destruir el módulo', () => {
    const destroy = jest.spyOn(SNSClient.prototype, 'destroy');

    publisherWith(env).onModuleDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
