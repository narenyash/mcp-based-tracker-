import nodemailer, { type Transporter } from 'nodemailer';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { templates, type TemplateData, type TemplateName } from '../emails/templates';
import { EmailLog } from '../models/EmailLog';
import { logger } from '../observability/logger';
import { errorText } from '../workers/errorText';
import { buildEmailJsRequest, emailJsConfigFromEnv, sendViaEmailJs } from './emailjs';

export type EmailJob = {
  [K in TemplateName]: { template: K; to: string; data: TemplateData<K>; workspaceId?: string };
}[TemplateName];

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  transporter ??=
    env.MAIL_TRANSPORT === 'json'
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          // Well under the outbox lock (LOCK_MS, 60 s), so a hung SMTP server fails the attempt and is retried.
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
          ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
        });
  return transporter;
}

/** Test hook: swap the transport (e.g. to simulate SMTP failures). */
export function setTransporter(t: Transporter | undefined): void {
  transporter = t;
}

/** Checks SMTP credentials at boot so a bad app password shows up in the log immediately, not on the first email. */
export async function verifyMailer(): Promise<void> {
  if (env.MAIL_TRANSPORT === 'emailjs') {
    // EmailJS has no credential check that doesn't send a real email, so a bad key shows up on the first send.
    logger.info({ serviceId: env.EMAILJS_SERVICE_ID }, 'emails are sent through EmailJS');
    return;
  }
  if (env.MAIL_TRANSPORT !== 'smtp') {
    logger.info('emails are printed to the log (MAIL_TRANSPORT=json), not sent');
    return;
  }
  try {
    await getTransporter().verify();
    logger.info({ host: env.SMTP_HOST, user: env.SMTP_USER || undefined, redirectTo: env.MAIL_REDIRECT_TO }, 'smtp ready');
  } catch (err) {
    logger.error({ host: env.SMTP_HOST, err: (err as Error).message }, 'smtp login failed; emails will retry until this is fixed');
  }
}

/** Renders and sends one email, recording the outcome in emailLogs. Throws on failure so the outbox retries. */
export async function sendEmail(job: EmailJob, outboxId?: Types.ObjectId): Promise<void> {
  const render = templates[job.template] as (d: unknown) => ReturnType<(typeof templates)[TemplateName]>;
  const rendered = render(job.data);
  const { html, text } = rendered;
  // Redirect keeps real addresses safe in dev while still exercising the real SMTP path.
  const to = env.MAIL_REDIRECT_TO ?? job.to;
  const subject = env.MAIL_REDIRECT_TO ? `[to ${job.to}] ${rendered.subject}` : rendered.subject;
  const log = {
    workspaceId: job.workspaceId ? new Types.ObjectId(job.workspaceId) : null,
    to: job.to,
    template: job.template,
    subject,
    outboxId: outboxId ?? null,
  };
  try {
    let messageId: string | undefined;
    if (env.MAIL_TRANSPORT === 'emailjs') {
      await sendViaEmailJs(buildEmailJsRequest(job, { to, subject, html }, emailJsConfigFromEnv()));
    } else {
      const info = (await getTransporter().sendMail({ from: env.MAIL_FROM, to, subject, html, text })) as {
        messageId?: string;
      };
      messageId = info.messageId;
    }
    await EmailLog.create({ ...log, status: 'sent', providerMessageId: messageId ?? null });
    if (env.MAIL_TRANSPORT === 'json') logger.info({ to: job.to, subject, text }, 'email captured (json transport, not delivered)');
  } catch (err) {
    await EmailLog.create({ ...log, status: 'failed', error: errorText(err) });
    throw err;
  }
}
