import {
  Injectable,
} from '@nestjs/common';

export type LogLevel =
  | 'info'
  | 'warn'
  | 'error';

export interface ObservabilityContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;

  failureCode?: string;
  status?: string;

  retryCount?: number;
  durationMs?: number;

  [key: string]:
    | string
    | number
    | boolean
    | undefined;
}

export interface MetricEntry {
  name: string;

  labels: Record<
    string,
    string
  >;

  value: number;
}

export interface ObservabilitySnapshot {
  counters: MetricEntry[];

  gauges: MetricEntry[];

  latencies: Array<{
    name: string;

    labels: Record<
      string,
      string
    >;

    count: number;

    totalMs: number;

    averageMs: number;

    maxMs: number;
  }>;
}

interface LatencyMetric {
  count: number;
  totalMs: number;
  maxMs: number;
}

@Injectable()
export class ObservabilityService {
  private readonly counters =
    new Map<
      string,
      number
    >();

  private readonly gauges =
    new Map<
      string,
      number
    >();

  private readonly latencies =
    new Map<
      string,
      LatencyMetric
    >();

  /*
   * Mantemos os labels separados
   * para reconstruir uma resposta
   * legível no endpoint /metrics.
   */
  private readonly metricLabels =
    new Map<
      string,
      {
        name: string;

        labels: Record<
          string,
          string
        >;
      }
    >();

  info(
    event: string,
    context:
      ObservabilityContext = {},
  ): void {
    this.writeLog(
      'info',
      event,
      context,
    );
  }

  warn(
    event: string,
    context:
      ObservabilityContext = {},
  ): void {
    this.writeLog(
      'warn',
      event,
      context,
    );
  }

  error(
    event: string,
    context:
      ObservabilityContext = {},
  ): void {
    this.writeLog(
      'error',
      event,
      context,
    );
  }

  incrementCounter(
    name: string,
    labels:
      Record<
        string,
        string
      > = {},
    amount = 1,
  ): void {
    if (
      !Number.isFinite(
        amount,
      ) ||
      amount < 0
    ) {
      throw new Error(
        'METRIC_COUNTER_INCREMENT_MUST_BE_NON_NEGATIVE',
      );
    }

    const key =
      this.createMetricKey(
        name,
        labels,
      );

    const current =
      this.counters.get(
        key,
      ) ??
      0;

    this.counters.set(
      key,
      current +
        amount,
    );

    this.metricLabels.set(
      key,
      {
        name,
        labels: {
          ...labels,
        },
      },
    );
  }

  setGauge(
    name: string,
    value: number,
    labels:
      Record<
        string,
        string
      > = {},
  ): void {
    if (
      !Number.isFinite(
        value,
      )
    ) {
      throw new Error(
        'METRIC_GAUGE_VALUE_MUST_BE_FINITE',
      );
    }

    const key =
      this.createMetricKey(
        name,
        labels,
      );

    this.gauges.set(
      key,
      value,
    );

    this.metricLabels.set(
      key,
      {
        name,
        labels: {
          ...labels,
        },
      },
    );
  }

  observeLatency(
    name: string,
    durationMs: number,
    labels:
      Record<
        string,
        string
      > = {},
  ): void {
    if (
      !Number.isFinite(
        durationMs,
      ) ||
      durationMs < 0
    ) {
      throw new Error(
        'METRIC_LATENCY_MUST_BE_NON_NEGATIVE',
      );
    }

    const key =
      this.createMetricKey(
        name,
        labels,
      );

    const current =
      this.latencies.get(
        key,
      ) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
      };

    current.count +=
      1;

    current.totalMs +=
      durationMs;

    current.maxMs =
      Math.max(
        current.maxMs,
        durationMs,
      );

    this.latencies.set(
      key,
      current,
    );

    this.metricLabels.set(
      key,
      {
        name,
        labels: {
          ...labels,
        },
      },
    );
  }

  snapshot():
    ObservabilitySnapshot {
    return {
      counters:
        this.createMetricEntries(
          this.counters,
        ),

      gauges:
        this.createMetricEntries(
          this.gauges,
        ),

      latencies:
        Array.from(
          this.latencies.entries(),
        ).map(
          (
            [
              key,
              metric,
            ],
          ) => {
            const metadata =
              this.metricLabels.get(
                key,
              );

            return {
              name:
                metadata?.name ??
                key,

              labels:
                metadata?.labels ??
                {},

              count:
                metric.count,

              totalMs:
                metric.totalMs,

              averageMs:
                metric.count ===
                0
                  ? 0
                  : metric.totalMs /
                    metric.count,

              maxMs:
                metric.maxMs,
            };
          },
        ),
    };
  }

  private writeLog(
    level: LogLevel,
    event: string,
    context:
      ObservabilityContext,
  ): void {
    /*
     * Não recebemos payload financeiro
     * neste método.
     *
     * O contrato aceita somente IDs,
     * status, códigos e dados técnicos
     * pequenos necessários para
     * diagnóstico.
     */
    const entry = {
      timestamp:
        new Date()
          .toISOString(),

      level,

      event,

      ...this.removeUndefined(
        context,
      ),
    };

    const serialized =
      JSON.stringify(
        entry,
      );

    if (
      level === 'error'
    ) {
      console.error(
        serialized,
      );

      return;
    }

    if (
      level === 'warn'
    ) {
      console.warn(
        serialized,
      );

      return;
    }

    console.log(
      serialized,
    );
  }

  private createMetricEntries(
    source:
      Map<
        string,
        number
      >,
  ): MetricEntry[] {
    return Array.from(
      source.entries(),
    ).map(
      (
        [
          key,
          value,
        ],
      ) => {
        const metadata =
          this.metricLabels.get(
            key,
          );

        return {
          name:
            metadata?.name ??
            key,

          labels:
            metadata?.labels ??
            {},

          value,
        };
      },
    );
  }

  private createMetricKey(
    name: string,
    labels:
      Record<
        string,
        string
      >,
  ): string {
    const normalizedLabels =
      Object.entries(
        labels,
      )
        .sort(
          (
            [left],
            [right],
          ) =>
            left.localeCompare(
              right,
            ),
        )
        .map(
          (
            [
              key,
              value,
            ],
          ) =>
            `${key}=${value}`,
        )
        .join(',');

    return normalizedLabels
      ? `${name}{${normalizedLabels}}`
      : name;
  }

  private removeUndefined(
    context:
      ObservabilityContext,
  ): ObservabilityContext {
    return Object.fromEntries(
      Object.entries(
        context,
      ).filter(
        (
          [
            ,
            value,
          ],
        ) =>
          value !==
          undefined,
      ),
    );
  }
}