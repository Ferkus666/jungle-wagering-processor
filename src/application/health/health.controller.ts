import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import {
  HealthService,
} from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService:
      HealthService,
  ) {}

  @Get('live')
  live() {
    return {
      status:
        'ok',
    };
  }

  @Get('ready')
  async ready() {
    const result =
      await this
        .healthService
        .checkReadiness();

    if (
      result.status !==
      'ready'
    ) {
      throw new HttpException(
        result,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return result;
  }
}
