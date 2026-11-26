import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncidentEvent } from '../domain/events/incident-event';
import { EventPublisher } from '../application/ports/event.publisher.port';

export const SNS_PUBLISH_TIMEOUT_MS = 3000;

@Injectable()
export class SnsEventPublisher implements EventPublisher, OnModuleDestroy {
  private readonly client: SNSClient;
  private readonly topicArn?: string;

  constructor(config: ConfigService) {
    this.topicArn = config.get<string>('SNS_TOPIC_ARN');
    // Sin credenciales en código: el SDK usa su cadena por defecto (IAM role en EC2).
    this.client = new SNSClient({
      region: config.get<string>('AWS_REGION'),
      // Solo local (LocalStack). En EC2 llega vacío y el SDK usa el endpoint real.
      endpoint: config.get<string>('AWS_ENDPOINT_URL') || undefined,
      // Los reintentos los hace el outbox, con espera creciente.
      maxAttempts: 1,
    });
  }

  async publish(event: IncidentEvent<string, unknown>): Promise<string> {
    if (!this.topicArn) {
      throw new Error('SNS_TOPIC_ARN no está configurado');
    }

    const { MessageId } = await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event),
        // Las colas consumidoras filtran por este atributo (DAS ADR-06).
        MessageAttributes: {
          event_type: { DataType: 'String', StringValue: event.event_type },
        },
      }),
      // requestTimeout del SDK solo avisa por defecto: se aborta de forma explícita.
      { abortSignal: AbortSignal.timeout(SNS_PUBLISH_TIMEOUT_MS) },
    );

    if (!MessageId) {
      throw new Error('SNS no devolvió MessageId');
    }
    return MessageId;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
