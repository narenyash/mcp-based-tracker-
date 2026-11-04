import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../src/config/env';
import { buildEmailJsRequest, sendViaEmailJs, type EmailJsConfig } from '../src/services/emailjs';

const config: EmailJsConfig = {
  serviceId: 'svc',
  publicKey: 'pub',
  privateKey: 'priv',
  templateInvite: 'tpl_invite',
  templateAssigned: 'tpl_assigned',
  templateGeneric: 'tpl_generic',
};
const message = { to: 'n@example.com', subject: 'Subject', html: '<p>hi</p>' };

describe('buildEmailJsRequest', () => {
  it('sends invites to the invite template with its fields', () => {
    const data = { inviterName: 'Asha', workspaceName: 'Acme', role: 'member', url: 'https://x/invite/t', expiresInDays: 7 };
    const req = buildEmailJsRequest({ template: 'invite', to: message.to, data }, message, config);
    expect(req).toMatchObject({ service_id: 'svc', user_id: 'pub', accessToken: 'priv', template_id: 'tpl_invite' });
    expect(req.template_params).toEqual({
      to_email: 'n@example.com',
      subject: 'Subject',
      inviter_name: 'Asha',
      workspace_name: 'Acme',
      role: 'member',
      invite_url: 'https://x/invite/t',
      expires_in_days: 7,
    });
  });

  it('sends assignments to the assigned template with its fields', () => {
    const data = { actorName: 'Asha', taskKey: 'TT-1', taskTitle: 'Fix it', projectName: 'Core', url: 'https://x/t/1' };
    const req = buildEmailJsRequest({ template: 'taskAssigned', to: message.to, data }, message, config);
    expect(req.template_id).toBe('tpl_assigned');
    expect(req.template_params).toEqual({
      to_email: 'n@example.com',
      subject: 'Subject',
      actor_name: 'Asha',
      task_key: 'TT-1',
      task_title: 'Fix it',
      project_name: 'Core',
      task_url: 'https://x/t/1',
    });
  });

  it('sends everything else to the generic template as rendered HTML', () => {
    const data = { testerName: 'Asha', taskKey: 'TT-1', taskTitle: 'Fix it', projectName: 'Core', url: 'https://x/t/1' };
    const req = buildEmailJsRequest({ template: 'testPassed', to: message.to, data }, message, config);
    expect(req.template_id).toBe('tpl_generic');
    expect(req.template_params).toEqual({ to_email: 'n@example.com', subject: 'Subject', html_body: '<p>hi</p>' });
  });
});

describe('sendViaEmailJs', () => {
  afterEach(() => vi.unstubAllGlobals());
  const request = buildEmailJsRequest(
    { template: 'testPassed', to: message.to, data: { testerName: 'A', taskKey: 'K', taskTitle: 'T', projectName: 'P', url: 'https://x' } },
    message,
    config,
  );

  it('posts the request as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendViaEmailJs(request);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.emailjs.com/api/v1.0/email/send');
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it('throws on a rejected send, so the outbox retries, without exposing the private key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('API calls are disabled', { status: 403 })));
    const err = await sendViaEmailJs(request).catch((e: Error) => e);
    expect((err as Error).message).toBe('EmailJS responded 403: API calls are disabled');
    expect((err as Error).message).not.toContain('priv');
  });
});

describe('MAIL_TRANSPORT=emailjs config', () => {
  const base = {
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb://localhost:27017/x',
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    MAIL_TRANSPORT: 'emailjs',
  };

  it('names every missing setting', () => {
    const issues = validateEnv(base).issues.join('\n');
    for (const key of ['SERVICE_ID', 'PUBLIC_KEY', 'PRIVATE_KEY', 'TEMPLATE_INVITE', 'TEMPLATE_ASSIGNED', 'TEMPLATE_GENERIC']) {
      expect(issues).toContain(`EMAILJS_${key}: required`);
    }
  });

  it('accepts a complete config', () => {
    const complete = {
      ...base,
      EMAILJS_SERVICE_ID: 'svc',
      EMAILJS_PUBLIC_KEY: 'pub',
      EMAILJS_PRIVATE_KEY: 'priv',
      EMAILJS_TEMPLATE_INVITE: 'a',
      EMAILJS_TEMPLATE_ASSIGNED: 'b',
      EMAILJS_TEMPLATE_GENERIC: 'c',
    };
    expect(validateEnv(complete).issues).toEqual([]);
  });
});
