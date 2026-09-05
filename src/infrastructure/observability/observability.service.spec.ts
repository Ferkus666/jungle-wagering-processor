import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  ObservabilityService,
} from './observability.service.js';

describe(
  'ObservabilityService',
  () => {
    test(
      'increments counters',
      () => {
        const service =
          new ObservabilityService();

        service.incrementCounter(
          'wager_transactions_total',
          {
            status:
              'PROCESSED',
          },
        );

        service.incrementCounter(
          'wager_transactions_total',
          {
            status:
              'PROCESSED',
          },
        );

        const snapshot =
          service.snapshot();

        expect(
          snapshot.counters,
        ).toEqual([
          {
            name:
              'wager_transactions_total',

            labels: {
              status:
                'PROCESSED',
            },

            value:
              2,
          },
        ]);
      },
    );

    test(
      'keeps counters separated by labels',
      () => {
        const service =
          new ObservabilityService();

        service.incrementCounter(
          'wager_transactions_total',
          {
            status:
              'PROCESSED',
          },
        );

        service.incrementCounter(
          'wager_transactions_total',
          {
            status:
              'REJECTED',
          },
        );

        expect(
          service
            .snapshot()
            .counters,
        ).toHaveLength(
          2,
        );
      },
    );

    test(
      'sets gauges',
      () => {
        const service =
          new ObservabilityService();

        service.setGauge(
          'outbox_lag',
          7,
        );

        service.setGauge(
          'outbox_lag',
          3,
        );

        expect(
          service
            .snapshot()
            .gauges,
        ).toEqual([
          {
            name:
              'outbox_lag',

            labels: {},

            value:
              3,
          },
        ]);
      },
    );

    test(
      'records processing latency',
      () => {
        const service =
          new ObservabilityService();

        service.observeLatency(
          'wager_processing_duration_ms',
          10,
        );

        service.observeLatency(
          'wager_processing_duration_ms',
          30,
        );

        expect(
          service
            .snapshot()
            .latencies,
        ).toEqual([
          {
            name:
              'wager_processing_duration_ms',

            labels: {},

            count:
              2,

            totalMs:
              40,

            averageMs:
              20,

            maxMs:
              30,
          },
        ]);
      },
    );

    test(
      'normalizes label order',
      () => {
        const service =
          new ObservabilityService();

        service.incrementCounter(
          'retry_total',
          {
            provider:
              'provider-a',

            reason:
              'timeout',
          },
        );

        service.incrementCounter(
          'retry_total',
          {
            reason:
              'timeout',

            provider:
              'provider-a',
          },
        );

        expect(
          service
            .snapshot()
            .counters[0]
            ?.value,
        ).toBe(
          2,
        );
      },
    );

    test(
      'rejects negative counter increment',
      () => {
        const service =
          new ObservabilityService();

        expect(
          () =>
            service.incrementCounter(
              'invalid',
              {},
              -1,
            ),
        ).toThrow(
          'METRIC_COUNTER_INCREMENT_MUST_BE_NON_NEGATIVE',
        );
      },
    );

    test(
      'rejects negative latency',
      () => {
        const service =
          new ObservabilityService();

        expect(
          () =>
            service.observeLatency(
              'invalid',
              -1,
            ),
        ).toThrow(
          'METRIC_LATENCY_MUST_BE_NON_NEGATIVE',
        );
      },
    );
  },
);