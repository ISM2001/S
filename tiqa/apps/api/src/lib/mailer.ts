import nodemailer from "nodemailer";
import type { Env } from "../env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP (Mailpit locally) when SMTP_HOST is set; otherwise prints to the console. No paid provider wired yet. */
export function createMailer(env: Env, log: { info: (o: object, m: string) => void }): Mailer {
  if (!env.SMTP_HOST) {
    return {
      async send(mail) {
        log.info({ to: mail.to, subject: mail.subject }, `[mail:console]\n${mail.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false });
  return {
    async send(mail) {
      await transport.sendMail({ from: env.MAIL_FROM, ...mail });
    },
  };
}
