/** Email templates. Every interpolated value is HTML-escaped; layout is inline-styled for mail clients. */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#fafafa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171717">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
<tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:.02em">TeamTrack</p>
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600">${esc(title)}</h1>
${bodyHtml}
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#a3a3a3">You received this because of activity in your TeamTrack workspace.</p>
</td></tr></table></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px">${esc(label)}</a></p>
<p style="margin:0;font-size:12px;color:#737373;word-break:break-all">Or open: ${esc(url)}</p>`;
}

export const templates = {
  invite(d: { inviterName: string; workspaceName: string; role: string; url: string; expiresInDays: number }): RenderedEmail {
    const title = `${d.inviterName} invited you to ${d.workspaceName}`;
    return {
      subject: title,
      html: layout(
        title,
        `<p style="margin:0;font-size:14px;line-height:1.6">You've been invited to join <b>${esc(d.workspaceName)}</b> on TeamTrack as a <b>${esc(d.role)}</b>.</p>
${button(d.url, 'Accept invite')}
<p style="margin:16px 0 0;font-size:12px;color:#737373">This link expires in ${d.expiresInDays} days.</p>`,
      ),
      text: `${title}.\n\nAccept the invite: ${d.url}\n\nThis link expires in ${d.expiresInDays} days.`,
    };
  },

  taskAssigned(d: { actorName: string; taskKey: string; taskTitle: string; projectName: string; url: string }): RenderedEmail {
    const title = `${d.actorName} assigned you ${d.taskKey}`;
    return {
      subject: `[${d.taskKey}] ${d.taskTitle}`,
      html: layout(
        title,
        `${taskLine(d)}
${button(d.url, 'Open task')}`,
      ),
      text: `${title}: ${d.taskTitle} (${d.projectName}).\n\nOpen: ${d.url}`,
    };
  },

  testRequested(d: { actorName: string; taskKey: string; taskTitle: string; projectName: string; round: number; note: string; url: string }): RenderedEmail {
    const title = `${d.actorName} sent ${d.taskKey} to you for testing`;
    const retest = d.round > 1 ? ` This is test round ${d.round}.` : '';
    return {
      subject: `[${d.taskKey}] Ready for testing: ${d.taskTitle}`,
      html: layout(
        title,
        `${taskLine(d)}
<p style="margin:12px 0 0;font-size:14px;line-height:1.6">Move it to <b>Done</b> if it passes, or back to an earlier column if it fails.${esc(retest)}</p>
${noteBlock('Note', d.note)}
${button(d.url, 'Start testing')}`,
      ),
      text: `${title}: ${d.taskTitle} (${d.projectName}).${retest}${d.note ? `\n\nNote: ${d.note}` : ''}\n\nOpen: ${d.url}`,
    };
  },

  testFailed(d: { testerName: string; taskKey: string; taskTitle: string; projectName: string; note: string; url: string }): RenderedEmail {
    const title = `${d.taskKey} failed testing`;
    return {
      subject: `[${d.taskKey}] Failed testing: ${d.taskTitle}`,
      html: layout(
        title,
        `${taskLine(d)}
<p style="margin:12px 0 0;font-size:14px;line-height:1.6">${esc(d.testerName)} sent it back to you.</p>
${noteBlock('What failed', d.note)}
${button(d.url, 'Open task')}`,
      ),
      text: `${title}: ${d.taskTitle} (${d.projectName}). ${d.testerName} sent it back.${d.note ? `\n\nWhat failed: ${d.note}` : ''}\n\nOpen: ${d.url}`,
    };
  },

  testPassed(d: { testerName: string; taskKey: string; taskTitle: string; projectName: string; url: string }): RenderedEmail {
    const title = `${d.taskKey} passed testing`;
    return {
      subject: `[${d.taskKey}] Passed testing: ${d.taskTitle}`,
      html: layout(
        title,
        `${taskLine(d)}
<p style="margin:12px 0 0;font-size:14px;line-height:1.6">${esc(d.testerName)} tested it and marked it done.</p>
${button(d.url, 'Open task')}`,
      ),
      text: `${title}: ${d.taskTitle} (${d.projectName}). ${d.testerName} marked it done.\n\nOpen: ${d.url}`,
    };
  },

  taskDue(d: { taskKey: string; taskTitle: string; projectName: string; when: string; overdue: boolean; url: string }): RenderedEmail {
    const title = d.overdue ? `${d.taskKey} is overdue` : `${d.taskKey} is due ${d.when}`;
    return {
      subject: `[${d.taskKey}] ${d.overdue ? 'Overdue' : `Due ${d.when}`}: ${d.taskTitle}`,
      html: layout(
        title,
        `${taskLine(d)}
<p style="margin:12px 0 0;font-size:14px;line-height:1.6">${d.overdue ? 'It was due' : 'It is due'} ${esc(d.when)}.</p>
${button(d.url, 'Open task')}`,
      ),
      text: `${title}: ${d.taskTitle} (${d.projectName}).\n\nOpen: ${d.url}`,
    };
  },

  ticketResolved(d: { actorName: string; taskKey: string; taskTitle: string; projectName: string; note: string; url: string }): RenderedEmail {
    const title = `${d.actorName} resolved ${d.taskKey}`;
    return {
      subject: `[${d.taskKey}] Resolved: ${d.taskTitle}`,
      html: layout(title, `${taskLine(d)}\n${noteBlock('Resolution', d.note)}\n${button(d.url, 'Open ticket')}`),
      text: `${title}: ${d.taskTitle} (${d.projectName}).${d.note ? `\n\nResolution: ${d.note}` : ''}\n\nOpen: ${d.url}`,
    };
  },

  commented(d: { actorName: string; taskKey: string; taskTitle: string; projectName: string; note: string; mentioned: boolean; url: string }): RenderedEmail {
    const title = d.mentioned ? `${d.actorName} mentioned you on ${d.taskKey}` : `${d.actorName} commented on ${d.taskKey}`;
    return {
      subject: `[${d.taskKey}] ${d.mentioned ? 'You were mentioned' : 'New comment'}: ${d.taskTitle}`,
      html: layout(title, `${taskLine(d)}\n${noteBlock(d.actorName, d.note)}\n${button(d.url, 'Reply')}`),
      text: `${title}: ${d.taskTitle} (${d.projectName}).\n\n${d.note}\n\nOpen: ${d.url}`,
    };
  },
} as const;

function taskLine(d: { taskKey: string; taskTitle: string; projectName: string }): string {
  return `<p style="margin:0;font-size:14px;line-height:1.6"><span style="color:#737373">${esc(d.taskKey)}</span> <b>${esc(d.taskTitle)}</b><br><span style="font-size:12px;color:#737373">${esc(d.projectName)}</span></p>`;
}

function noteBlock(label: string, note: string): string {
  if (!note) return '';
  return `<p style="margin:16px 0 0;padding:12px;background:#fafafa;border:1px solid #e5e5e5;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap"><b>${esc(label)}:</b> ${esc(note)}</p>`;
}

export type TemplateName = keyof typeof templates;
export type TemplateData<K extends TemplateName> = Parameters<(typeof templates)[K]>[0];
