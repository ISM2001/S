import type { Env } from "../env";

export interface SmsSender {
  /** False when no real provider is configured in production (the OTP endpoint then answers 503). */
  readonly available: boolean;
  send(e164: string, text: string): Promise<void>;
}

/**
 * No paid SMS provider is wired yet (decision 2026-11-22). The console sender prints the message
 * with a MASKED number so raw phone numbers never reach the logs. Production must configure a real
 * provider before the consumer portal goes live.
 */
export function createSmsSender(env: Env, log: { info: (o: object, m: string) => void }): SmsSender {
  return {
    available: env.NODE_ENV !== "production",
    async send(e164, text) {
      log.info({ to: `${e164.slice(0, 5)}•••••${e164.slice(-2)}` }, `[sms:console] ${text}`);
    },
  };
}
