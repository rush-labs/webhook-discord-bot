import express, {NextFunction, Request, Response} from "express";
import {Webhook, WebhookUnbrandedRequiredHeaders, WebhookVerificationError} from "standardwebhooks"
import {RenderEvent, RenderResource, ResourceKind, WebhookPayload, resourceKindFor} from "./render";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    ColorResolvable,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    MessageActionRowComponentBuilder
} from "discord.js";

const app = express();
const port = process.env.PORT || 3001;
const renderWebhookSecret = process.env.RENDER_WEBHOOK_SECRET || '';
if (!renderWebhookSecret ) {
    console.error("Error: RENDER_WEBHOOK_SECRET is not set.");
    process.exit(1);
}


const renderAPIURL = process.env.RENDER_API_URL || "https://api.render.com/v1"

// To create a Render API key, follow instructions here: https://render.com/docs/api#1-create-an-api-key
const renderAPIKey = process.env.RENDER_API_KEY || '';
if (!renderAPIKey ) {
    console.error("Error: RENDER_API_KEY is not set.");
    process.exit(1);
}

const discordToken = process.env.DISCORD_TOKEN || '';
if (!discordToken ) {
    console.error("Error: DISCORD_TOKEN is not set.");
    process.exit(1);
}
const discordChannelID = process.env.DISCORD_CHANNEL_ID || '';
if (!discordChannelID ) {
    console.error("Error: DISCORD_CHANNEL_ID is not set.");
    process.exit(1);
}
const discordContactChannelID = process.env.DISCORD_CONTACT_CHANNEL_ID || '';
if (!discordContactChannelID) {
    console.error("Error: DISCORD_CONTACT_CHANNEL_ID is not set.");
    process.exit(1);
}
const contactWebhookSecret = process.env.CONTACT_WEBHOOK_SECRET || '';
if (!contactWebhookSecret) {
    console.warn("Warning: CONTACT_WEBHOOK_SECRET is not set — /contact endpoint is unauthenticated.");
}
const discordDeveloperRoleID = process.env.DISCORD_DEVELOPER_ROLE_ID || '';
if (!discordDeveloperRoleID) {
    console.error("Error: DISCORD_DEVELOPER_ROLE_ID is not set.");
    process.exit(1);
}
const developerRoleMention = `<@&${discordDeveloperRoleID}>`;

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
// It makes some properties non-nullable.
client.once(Events.ClientReady, readyClient => {
    console.log(`Discord client setup! Logged in as ${readyClient.user.tag}`);
});

// Log in to Discord with your client's token
client.login(discordToken).catch(err => {
    console.error(`unable to connect to Discord: ${err}`);
});

app.post("/webhook", express.raw({type: 'application/json'}), (req: Request, res: Response, next: NextFunction) => {
    try {
        validateWebhook(req);
    } catch (error) {
        return next(error)
    }

    const payload: WebhookPayload = JSON.parse(req.body)

    res.status(200).send({}).end()

    // handle the webhook async so we don't timeout the request
    handleWebhook(payload)
});

app.post("/contact", express.json({limit: "100kb"}), (req: Request, res: Response) => {
    if (contactWebhookSecret) {
        const auth = req.header("authorization") || ""
        const expected = `Bearer ${contactWebhookSecret}`
        if (auth !== expected) {
            res.status(401).send({error: "unauthorized"}).end()
            return
        }
    }

    const body = req.body
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).send({error: "expected a JSON object"}).end()
        return
    }

    res.status(200).send({}).end()

    sendContactMessage(body).catch(err => console.error(`failed to send contact message: ${err}`))
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(err);
    if (err instanceof WebhookVerificationError) {
        res.status(400).send({}).end()
    } else {
        res.status(500).send({}).end()
    }
});

const server = app.listen(port, () => console.log(`Example app listening on port ${port}!`));

function validateWebhook(req: Request) {
    const headers: WebhookUnbrandedRequiredHeaders = {
        "webhook-id": req.header("webhook-id") || "",
        "webhook-timestamp": req.header("webhook-timestamp") || "",
        "webhook-signature": req.header("webhook-signature") || ""
    }

    const wh = new Webhook(renderWebhookSecret);
    wh.verify(req.body, headers);
}

type Severity = "failure" | "warning" | "success" | "info"

const SEVERITY_COLORS: Record<Severity, ColorResolvable> = {
    failure: "#FF5C88",
    warning: "#F5A524",
    success: "#22C55E",
    info: "#3B82F6",
}

const SEVERITY_LABELS: Record<Severity, string> = {
    failure: "Failure",
    warning: "Warning",
    success: "Recovery",
    info: "Info",
}

const RESOURCE_LABELS: Record<ResourceKind, string> = {
    service: "Service",
    postgres: "Postgres",
    key_value: "Key Value",
}

interface Notification {
    severity: Severity
    title: string
    description: string
    includeLogsButton?: boolean
}

async function handleWebhook(payload: WebhookPayload) {
    try {
        const notification = await buildNotification(payload)
        if (!notification) {
            console.log(`unhandled webhook type ${payload.type} for resource ${payload.data.serviceId}`)
            return
        }

        const resource = await fetchResourceInfo(payload).catch((err) => {
            console.error(`unable to fetch resource info: ${err}`)
            return undefined
        })

        console.log(`sending discord message for ${payload.type} (${resource?.name ?? payload.data.serviceId})`)
        await sendNotification(resourceKindFor(payload.type), resource, notification)
    } catch (error) {
        console.error(error)
    }
}

async function buildNotification(payload: WebhookPayload): Promise<Notification | null> {
    switch (payload.type) {
        // ---------- Failures ----------
        case "server_failed": {
            const event = await fetchEventInfo(payload)
            console.log(`server_failed details: ${JSON.stringify(event.details)}`)
            return {
                severity: "failure",
                title: "Server Failed",
                description: describeFailureReason(event.details?.reason) ?? "Failed for unknown reason",
                includeLogsButton: true,
            }
        }
        case "server_hardware_failure":
            return {
                severity: "failure",
                title: "Server Hardware Failure",
                description: "Render reported a hardware failure on this server.",
                includeLogsButton: true,
            }
        case "image_pull_failed":
            return {
                severity: "failure",
                title: "Image Pull Failed",
                description: "Render could not pull the container image for this service.",
                includeLogsButton: true,
            }
        case "build_ended":
            return endedEventNotification(payload, "Build Failed", "Build")
        case "deploy_ended":
            return endedEventNotification(payload, "Deploy Failed", "Deploy")
        case "zero_downtime_redeploy_ended":
            return endedEventNotification(payload, "Zero-Downtime Redeploy Failed", "Redeploy")
        case "pre_deploy_ended":
            return endedEventNotification(payload, "Pre-deploy Failed", "Pre-deploy")
        case "cron_job_run_ended":
            return endedEventNotification(payload, "Cron Job Failed", "Run")
        case "job_run_ended":
            return endedEventNotification(payload, "Job Run Failed", "Job")

        // ---------- Service availability / lifecycle ----------
        case "server_available":
            return {
                severity: "success",
                title: "Server Available",
                description: "Server is back online.",
            }
        case "service_suspended":
            return {
                severity: "warning",
                title: "Service Suspended",
                description: "Service has been suspended.",
            }
        case "service_resumed":
            return {
                severity: "success",
                title: "Service Resumed",
                description: "Service has been resumed.",
            }
        case "maintenance_started":
            return {
                severity: "warning",
                title: "Maintenance Started",
                description: "Maintenance mode is active.",
            }
        case "maintenance_mode_enabled":
            return {
                severity: "warning",
                title: "Maintenance Mode Enabled",
                description: "Maintenance mode was turned on — service is customer-visible as down.",
            }
        case "maintenance_ended":
            return {
                severity: "success",
                title: "Maintenance Ended",
                description: "Maintenance mode has ended.",
            }
        case "autoscaling_ended": {
            const event = await fetchEventInfo(payload)
            const from = event.details?.fromInstances
            const to = event.details?.toInstances
            return {
                severity: "info",
                title: "Autoscaling Event",
                description: from !== undefined && to !== undefined
                    ? `Scaled from ${from} to ${to} instance(s).`
                    : "Autoscaling event completed.",
            }
        }
        case "plan_changed":
            return {
                severity: "info",
                title: "Plan Changed",
                description: "Service plan was changed.",
            }

        // ---------- Postgres ----------
        case "postgres_unavailable":
            return {
                severity: "failure",
                title: "Postgres Unavailable",
                description: "Postgres database is unavailable.",
            }
        case "postgres_available":
            return {
                severity: "success",
                title: "Postgres Available",
                description: "Postgres database is back online.",
            }
        case "postgres_backup_failed":
            return {
                severity: "failure",
                title: "Postgres Backup Failed",
                description: "A scheduled backup failed.",
            }
        case "postgres_restore_failed":
            return {
                severity: "failure",
                title: "Postgres Restore Failed",
                description: "Restore operation failed.",
            }
        case "postgres_upgrade_failed":
            return {
                severity: "failure",
                title: "Postgres Upgrade Failed",
                description: "Upgrade did not complete.",
            }
        case "postgres_wal_archive_failed":
            return {
                severity: "failure",
                title: "Postgres WAL Archive Failed",
                description: "WAL archiving failed; point-in-time recovery may be impacted.",
            }
        case "postgres_pitr_checkpoint_failed":
            return {
                severity: "failure",
                title: "Postgres PITR Checkpoint Failed",
                description: "Point-in-time recovery checkpoint failed.",
            }
        case "postgres_read_replica_stale":
            return {
                severity: "warning",
                title: "Postgres Read Replica Stale",
                description: "A read replica is falling behind.",
            }
        case "postgres_cluster_leader_changed":
            return {
                severity: "warning",
                title: "Postgres HA Failover",
                description: "Cluster leader changed — an HA failover occurred.",
            }
        case "postgres_ha_status_changed":
            return {
                severity: "warning",
                title: "Postgres HA Status Changed",
                description: "High availability configuration changed.",
            }
        case "postgres_credentials_created":
            return {
                severity: "info",
                title: "Postgres Credentials Created",
                description: "New database credentials were created.",
            }
        case "postgres_credentials_deleted":
            return {
                severity: "warning",
                title: "Postgres Credentials Deleted",
                description: "Database credentials were deleted.",
            }
        case "postgres_restarted":
            return {
                severity: "info",
                title: "Postgres Restarted",
                description: "Postgres database was restarted.",
            }
        case "postgres_disk_size_changed":
            return {
                severity: "info",
                title: "Postgres Disk Resized",
                description: "Postgres disk size changed.",
            }
        case "postgres_restore_succeeded":
            return {
                severity: "success",
                title: "Postgres Restore Succeeded",
                description: "Restore operation completed.",
            }
        case "postgres_upgrade_succeeded":
            return {
                severity: "success",
                title: "Postgres Upgrade Succeeded",
                description: "Upgrade completed.",
            }

        // ---------- Key Value (Redis) ----------
        case "key_value_unhealthy":
            return {
                severity: "failure",
                title: "Key Value Unhealthy",
                description: "Key Value (Redis) instance is unhealthy.",
            }
        case "key_value_available":
            return {
                severity: "success",
                title: "Key Value Available",
                description: "Key Value (Redis) instance is back online.",
            }
        case "key_value_config_restart":
            return {
                severity: "info",
                title: "Key Value Config Restart",
                description: "Key Value (Redis) instance restarted due to a config change.",
            }

        // ---------- Persistent Disks ----------
        case "disk_deleted":
            return {
                severity: "warning",
                title: "Disk Deleted",
                description: "A persistent disk was deleted.",
            }
        case "disk_updated":
            return {
                severity: "info",
                title: "Disk Updated",
                description: "A persistent disk was updated (likely a size change).",
            }

        default:
            return null
    }
}

// Render returns event-specific string fields like deployStatus/buildStatus
// alongside a numeric `status` enum. We check both — if any string status
// field contains "fail" or "cancel", we send a failure notification.
async function endedEventNotification(
    payload: WebhookPayload,
    failureTitle: string,
    noun: string,
): Promise<Notification | null> {
    const event = await fetchEventInfo(payload)
    console.log(`${payload.type} details: ${JSON.stringify(event.details)}`)

    if (!isFailedDetail(event.details)) return null

    const reason = describeFailureReason(event.details?.reason)
    return {
        severity: "failure",
        title: failureTitle,
        description: reason ?? `${noun} did not succeed.`,
        includeLogsButton: true,
    }
}

function isFailedDetail(details: any): boolean {
    if (!details || typeof details !== "object") return false
    for (const [key, value] of Object.entries(details)) {
        if (key !== "status" && !/Status$/.test(key)) continue
        if (typeof value !== "string") continue
        if (/fail|cancel/i.test(value)) return true
    }
    return false
}

function describeFailureReason(reason: any): string | undefined {
    if (!reason || typeof reason !== "object") return undefined
    // Render nests the runtime failure under `reason.failure`; fall back to
    // top-level fields for backwards compat with older payloads.
    const f = reason.failure ?? reason
    if (f.nonZeroExit) return `Exited with status ${f.nonZeroExit}`
    if (f.oomKilled) return "Out of memory"
    if (f.timedOutSeconds) return `Timed out${f.timedOutReason ? ` (${f.timedOutReason})` : ""}`
    if (f.unhealthy) return String(f.unhealthy)
    if (f.evicted) return "Container evicted"
    if (reason.buildFailed?.id) return String(reason.buildFailed.id)
    return undefined
}

async function sendNotification(kind: ResourceKind, resource: RenderResource | undefined, notification: Notification) {
    const channel = await client.channels.fetch(discordChannelID);
    if (!channel ){
        throw new Error(`unable to find specified Discord channel ${discordChannelID}`);
    }
    if (!channel.isSendable()) {
        throw new Error(`specified Discord channel ${discordChannelID} is not sendable`);
    }

    const name = resource?.name ?? "Unknown resource"
    const embed = new EmbedBuilder()
        .setColor(SEVERITY_COLORS[notification.severity])
        .setTitle(notification.title)
        .setDescription(notification.description)
        .setTimestamp(new Date())
        .setFooter({text: `${RESOURCE_LABELS[kind]} · ${SEVERITY_LABELS[notification.severity]}`})

    if (resource) {
        embed.setAuthor({
            name,
            url: resource.dashboardUrl || undefined,
        })
    }

    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = []
    if (resource?.dashboardUrl) {
        const buttons = new ActionRowBuilder<MessageActionRowComponentBuilder>()
        if (notification.includeLogsButton) {
            buttons.addComponents(
                new ButtonBuilder()
                    .setLabel("View Logs")
                    .setURL(`${resource.dashboardUrl}/logs`)
                    .setStyle(ButtonStyle.Link),
            )
        }
        buttons.addComponents(
            new ButtonBuilder()
                .setLabel("Open Dashboard")
                .setURL(resource.dashboardUrl)
                .setStyle(ButtonStyle.Link),
        )
        components.push(buttons)
    }

    const content = notification.severity === "failure"
        ? `${developerRoleMention} **Action required**`
        : undefined

    await channel.send({
        content,
        embeds: [embed],
        components,
        allowedMentions: {roles: content ? [discordDeveloperRoleID] : []},
    })
}

async function sendContactMessage(payload: Record<string, unknown>) {
    const channel = await client.channels.fetch(discordContactChannelID);
    if (!channel) {
        throw new Error(`unable to find Discord contact channel ${discordContactChannelID}`);
    }
    if (!channel.isSendable()) {
        throw new Error(`Discord contact channel ${discordContactChannelID} is not sendable`);
    }

    const remaining = {...payload}
    const firstName = takeString(remaining, "first_name") ?? takeString(remaining, "firstName")
    const lastName = takeString(remaining, "last_name") ?? takeString(remaining, "lastName")
    const joinedName = [firstName, lastName].filter(Boolean).join(" ").trim()
    const fullName = takeString(remaining, "name") ?? (joinedName || undefined)
    const email = takeString(remaining, "email")
    const company = takeString(remaining, "company")
    const subject = takeString(remaining, "subject")
    const message = takeString(remaining, "message")

    const embed = new EmbedBuilder()
        .setColor("#3B82F6")
        .setTitle(subject ? `New Contact · ${subject}` : "New Contact Form Submission")
        .setTimestamp(new Date())
        .setFooter({text: "Contact form"})

    if (fullName) {
        embed.setAuthor({name: fullName})
    }

    if (message) embed.setDescription(truncate(message, 4000))

    if (email) embed.addFields({name: "Email", value: `[${truncate(email, 1000)}](mailto:${encodeURI(email)})`, inline: true})
    if (company) embed.addFields({name: "Company", value: truncate(company, 1024), inline: true})

    for (const [key, value] of Object.entries(remaining)) {
        const stringified = stringifyField(value)
        if (!stringified) continue
        embed.addFields({name: truncate(prettifyKey(key), 256), value: truncate(stringified, 1024)})
    }

    await channel.send({
        content: `${developerRoleMention} **New contact form submission**`,
        embeds: [embed],
        allowedMentions: {roles: [discordDeveloperRoleID]},
    })
}

function prettifyKey(key: string): string {
    return key
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
}

function takeString(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key]
    delete obj[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return undefined
}

function stringifyField(value: unknown): string | undefined {
    if (value === null || value === undefined || value === "") return undefined
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    try {
        return JSON.stringify(value)
    } catch {
        return undefined
    }
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : value.slice(0, max - 1) + "…"
}

// fetchEventInfo fetches the event that triggered the webhook
// some events have additional information that isn't in the webhook payload
// for example, deploy events have the deploy id
async function fetchEventInfo(payload: WebhookPayload): Promise<RenderEvent> {
    const res = await fetch(
        `${renderAPIURL}/events/${payload.data.id}`,
        {
            method: "get",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${renderAPIKey}`,
            },
        },
    )
    if (res.ok) {
        return res.json()
    } else {
        throw new Error(`unable to fetch event info; received code :${res.status.toString()}`)
    }
}

async function fetchResourceInfo(payload: WebhookPayload): Promise<RenderResource> {
    const kind: ResourceKind = resourceKindFor(payload.type)
    const path = kind === "postgres" ? "postgres"
        : kind === "key_value" ? "key-value"
        : "services"
    const res = await fetch(
        `${renderAPIURL}/${path}/${payload.data.serviceId}`,
        {
            method: "get",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${renderAPIKey}`,
            },
        },
    )
    if (res.ok) {
        return res.json()
    } else {
        throw new Error(`unable to fetch resource info; received code :${res.status.toString()}`)
    }
}

process.on('SIGTERM', () => {
    console.debug('SIGTERM signal received: closing HTTP server')
    server.close(() => {
        console.debug('HTTP server closed')
    })
})
