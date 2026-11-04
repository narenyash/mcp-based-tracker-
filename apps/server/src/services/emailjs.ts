import { env } from '../config/env';
import type { EmailJob } from './mailer';

const SEND_URL = 'https://api.emailjs.com/api/v1.0/email/send';
/** Well under the outbox lock (LOCK_MS, 60 s), so a hung request fails the attempt and is retried. */
const TIMEOUT_MS = 20_000;

export interface EmailJsConfig {
  serviceId: string;
  publicKey: string;
  privateKey: string;
  templateInvite: string;
  templateAssigned: string;
  templateGeneric: string;
}

export interface EmailJsRequest {
  service_id: string;
  template_id: string;
  user_id: string;
  accessToken: string;
  template_params: Record<string, string | number>;
}

/**
 * Invites and assignments use their own designed EmailJS templates, which take individual fields.
 * Every other email goes through the generic template, which renders the app's own HTML as {{{html_body}}}.
 */
export function buildEmailJsRequest(
  job: EmailJob,
  message: { to: string; subject: string; html: string },
  config: EmailJsConfig,
): EmailJsRequest {
  const base = { service_id: config.serviceId, user_id: config.publicKey, accessToken: config.privateKey };
  const common = { to_email: message.to, subject: message.subject };

  if (job.template === 'invite') {
    const d = job.data;
    return {
      ...base,
      template_id: config.templateInvite,
      template_params: {
        ...common,
        inviter_name: d.inviterName,
        workspace_name: d.workspaceName,
        role: d.role,
        invite_url: d.url,
        expires_in_days: d.expiresInDays,
      },
    };
  }

  if (job.template === 'taskAssigned') {
    const d = job.data;
    return {
      ...base,
      template_id: config.templateAssigned,
      template_params: {
        ...common,
        actor_name: d.actorName,
        task_key: d.taskKey,
        task_title: d.taskTitle,
        project_name: d.projectName,
        task_url: d.url,
      },
    };
  }

  return { ...base, template_id: config.templateGeneric, template_params: { ...common, html_body: message.html } };
}

/** Env validation guarantees these are set whenever MAIL_TRANSPORT=emailjs. */
export function emailJsConfigFromEnv(): EmailJsConfig {
  return {
    serviceId: env.EMAILJS_SERVICE_ID!,
    publicKey: env.EMAILJS_PUBLIC_KEY!,
    privateKey: env.EMAILJS_PRIVATE_KEY!,
    templateInvite: env.EMAILJS_TEMPLATE_INVITE!,
    templateAssigned: env.EMAILJS_TEMPLATE_ASSIGNED!,
    templateGeneric: env.EMAILJS_TEMPLATE_GENERIC!,
  };
}

/** Throws on any non-2xx response so the outbox retries. The request body holds the private key, so it is never logged. */
export async function sendViaEmailJs(request: EmailJsRequest): Promise<void> {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`EmailJS responded ${res.status}: ${detail}`);
  }
}
