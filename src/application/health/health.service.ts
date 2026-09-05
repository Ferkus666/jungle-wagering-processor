import {
  Injectable,
} from '@nestjs/common';

import {
  EntityManager,
} from '@mikro-orm/postgresql';

import {
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface ReadinessResult {
  status:
    | 'ready'
    | 'not_ready';

  checks: {
    postgres:
      | 'up'
      | 'down';

    sqs:
      | 'up'
      | 'down';
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly em:
      EntityManager,
  ) {}

  async checkReadiness(): Promise<
    ReadinessResult
  > {
    const [
      postgres,
      sqs,
    ] =
      await Promise.all([
        this.checkPostgres(),
        this.checkSqs(),
      ]);

    const ready =
      postgres === 'up' &&
      sqs === 'up';

    return {
      status:
        ready
          ? 'ready'
          : 'not_ready',

      checks: {
        postgres,
        sqs,
      },
    };
  }

  private async checkPostgres(): Promise<
    'up' | 'down'
  > {
    try {
      await this.em
        .getConnection()
        .execute(
          'select 1',
        );

      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<
    'up' | 'down'
  > {
    const client =
      new SQSClient({
        region:
          process.env
            .AWS_REGION ??
          'us-east-1',

        endpoint:
          process.env
            .SQS_ENDPOINT ??
          'http://localhost:4566',

        credentials: {
          accessKeyId:
            process.env
              .AWS_ACCESS_KEY_ID ??
            'test',

          secretAccessKey:
            process.env
              .AWS_SECRET_ACCESS_KEY ??
            'test',
        },
      });

    try {
      await client.send(
        new ListQueuesCommand({
          MaxResults:
            1,
        }),
      );

      return 'up';
    } catch {
      return 'down';
    } finally {
      client.destroy();
    }
  }
}
