/**
 * PostHog telemetry provider.
 * Enabled when POSTHOG_API_KEY is set in the environment.
 */

import { PostHog } from 'posthog-node';
import { TelemetryProvider, TelemetryEvent } from '../utils/telemetry.js';

export class PostHogProvider implements TelemetryProvider {
  private client: PostHog;

  constructor(apiKey: string, options?: { host?: string }) {
    this.client = new PostHog(apiKey, {
      host: options?.host ?? 'https://us.i.posthog.com',
      flushAt: 20,
      flushInterval: 10000,
    });
  }

  capture(event: TelemetryEvent): void {
    this.client.capture({
      distinctId: event.distinctId,
      event: event.event,
      properties: event.properties,
      timestamp: event.timestamp,
    });
  }

  identify(distinctId: string, properties?: Record<string, any>): void {
    this.client.identify({ distinctId, properties });
  }

  async flush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
