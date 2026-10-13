// src/mcp/mail.js — Select the configured browser mailbox for application email.
// Keeps provider selection in one place so the MCP tool and always-on worker behave alike.

import { sendViaGmail } from './gmail.js';
import { sendViaOutlook } from './outlook.js';

export const MAILBOX_MODES = Object.freeze({
  gmail_web: 'Gmail Web',
  outlook_web: 'Outlook Web',
});

/**
 * Return the user-facing name for a mailbox mode.
 * @param {string} mode - configured mailbox mode
 * @returns {string}
 */
export function mailboxName(mode) {
  return MAILBOX_MODES[mode] || mode || 'configured mailbox';
}

/**
 * Send through the provider selected in the user's local profile.
 * @param {object} args - provider-neutral email arguments
 * @param {string} [args.mode] - gmail_web or outlook_web
 * @returns {Promise<object>}
 */
export async function sendViaMailbox({ mode = 'gmail_web', ...args }) {
  if (mode === 'outlook_web') return sendViaOutlook(args);
  if (mode === 'gmail_web') return sendViaGmail(args);
  return {
    ok: false,
    result: 'failed',
    detail: `Unsupported mailbox mode: ${mode}. Choose Gmail Web or Outlook Web in onboarding.`,
  };
}
