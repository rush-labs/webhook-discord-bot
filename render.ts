interface WebhookData {
    id: string
    serviceId: string
}

export interface WebhookPayload {
    type: string
    timestamp: Date
    data: WebhookData
}

export interface RenderResource {
    id: string
    name: string
    dashboardUrl: string
    type?: string
}

export interface RenderEvent {
    id: string
    type: string
    details: any
}

// Resource type buckets, derived from the webhook event type prefix.
// Render exposes different REST endpoints per resource family.
export type ResourceKind = "service" | "postgres" | "key_value"

export function resourceKindFor(eventType: string): ResourceKind {
    if (eventType.startsWith("postgres_")) return "postgres"
    if (eventType.startsWith("key_value_")) return "key_value"
    return "service"
}
