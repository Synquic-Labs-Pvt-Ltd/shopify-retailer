import { Schema, model } from 'mongoose';

export const WEBHOOK_EVENT_TTL_MS = 7 * 24 * 3_600_000;

export interface WebhookEventDoc {
  // The X-Shopify-Webhook-Id.
  _id: string;
  topic: string;
  shopDomain: string;
  receivedAt: Date;
  processedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEventSchema = new Schema<WebhookEventDoc>(
  {
    _id: { type: String, required: true },
    topic: { type: String, required: true },
    shopDomain: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    processedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'webhook_events' },
);
webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookEventModel = model<WebhookEventDoc>('webhook_events', webhookEventSchema);
