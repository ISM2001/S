"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMe } from "@/components/MeContext";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

type Role = "owner" | "admin" | "member";
interface Team {
  members: Array<{ user_id: string; email: string; role: Role; is_you: boolean }>;
  invites: Array<{ id: string; email: string; role: Role; expiresAt: string }>;
}

export default function TeamPage() {
  const t = useTranslations("team");
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const { me } = useMe();
  const [team, setTeam] = useState<Team | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = me.merchant.role !== "member";
  const isOwner = me.merchant.role === "owner";

  const load = () => api<Team>("/app/team").then(setTeam);
  useEffect(() => void load(), []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setInfo(null);
    try {
      await fn();
      if (ok) setInfo(ok);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-slate-600">{t("intro")}</p>
      </div>

      {canManage && (
        <form
          className="card flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api("/app/team/invites", { body: { email, role } }).then(() => setEmail("")), t("inviteSent"));
          }}
        >
          <div className="min-w-56 flex-1">
            <label className="label" htmlFor="email">{t("email")}</label>
            <input id="email" type="email" dir="ltr" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="role">{t("role")}</label>
            <select id="role" className="input" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="member">{t("roles.member")}</option>
              <option value="admin">{t("roles.admin")}</option>
            </select>
          </div>
          <button className="btn">{t("invite")}</button>
        </form>
      )}
      {info && <p className="text-sm text-brand-700">{info}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            {team?.members.map((m) => (
              <tr key={m.user_id} className="border-t border-slate-100 first:border-t-0">
                <td className="px-4 py-3" dir="ltr">{m.email} {m.is_you && <span className="text-slate-400">({t("you")})</span>}</td>
                <td className="px-4 py-3">
                  {isOwner && !m.is_you ? (
                    <select className="rounded border border-slate-200 px-1 py-0.5" value={m.role}
                      onChange={(e) => act(() => api(`/app/team/members/${m.user_id}`, { method: "PATCH", body: { role: e.target.value } }))}>
                      {(["owner", "admin", "member"] as const).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                    </select>
                  ) : (
                    t(`roles.${m.role}`)
                  )}
                </td>
                <td className="px-4 py-3 text-end">
                  {canManage && !m.is_you && (
                    <button className="btn-danger" onClick={() => confirm(t("confirmRemove")) && act(() => api(`/app/team/members/${m.user_id}`, { method: "DELETE" }))}>
                      {t("remove")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {team && team.invites.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-semibold">{t("pending")}</h2>
          <ul className="text-sm">
            {team.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2">
                <span dir="ltr">{i.email}</span>
                <span className="text-slate-500">{t(`roles.${i.role}`)} · {t("expires", { date: format.dateTime(new Date(i.expiresAt), { dateStyle: "medium" }) })}</span>
                {canManage && <button className="btn-danger" onClick={() => act(() => api(`/app/team/invites/${i.id}`, { method: "DELETE" }))}>{t("cancelInvite")}</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
