import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  INestApplication,
} from '@nestjs/common';

import {
  Test,
} from '@nestjs/testing';

import request from 'supertest';

import {
  AppModule,
} from '../../src/app.module.js';

describe(
  'Health HTTP - integration',
  () => {
    let app:
      INestApplication;

    beforeAll(
      async () => {
        const moduleRef =
          await Test
            .createTestingModule({
              imports: [
                AppModule,
              ],
            })
            .compile();

        app =
          moduleRef
            .createNestApplication();

        await app.init();
      },
    );

    afterAll(
      async () => {
        await app.close();
      },
    );

    test(
      'returns liveness without checking external dependencies',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              '/health/live',
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body,
        ).toEqual({
          status:
            'ok',
        });
      },
    );

    test(
      'returns readiness when PostgreSQL and SQS are reachable',
      async () => {
        const response =
          await request(
            app.getHttpServer(),
          )
            .get(
              '/health/ready',
            );

        expect(
          response.status,
        ).toBe(
          200,
        );

        expect(
          response.body,
        ).toEqual({
          status:
            'ready',

          checks: {
            postgres:
              'up',

            sqs:
              'up',
          },
        });
      },
    );
  },
);
