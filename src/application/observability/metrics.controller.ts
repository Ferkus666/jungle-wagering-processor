import {
  Controller,
  Get,
} from '@nestjs/common';

import {
  ObservabilityService,
  type ObservabilitySnapshot,
} from '../../infrastructure/observability/observability.service.js';

@Controller(
  'metrics',
)
export class MetricsController {
  constructor(
    private readonly observability:
      ObservabilityService,
  ) {}

  @Get()
  getMetrics():
    ObservabilitySnapshot {
    return this
      .observability
      .snapshot();
  }
}