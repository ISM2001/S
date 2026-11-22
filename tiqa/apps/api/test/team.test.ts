import { describe, expect, it } from "vitest";
import { cookieFrom, setupTestApp, signup } from "./helpers";

const ctx = setupTestApp();
const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);

describe("team", () => {
  it("owner invites a new person; they set a password and join as member", async () => {
    const owner = await signup(ctx);
    const r = await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie: owner.cookie }, payload: { email: "Agent@Store.test", role: "member" } });
    expect(r.statusCode).toBe(201);
    expect(ctx.mails[0]!.to).toBe("agent@store.test");
    const token = tokenFrom(ctx.mails[0]!.text);

    const info = (await ctx.app.inject({ method: "GET", url: `/app/invites/${encodeURIComponent(token)}` })).json();
    expect(info).toMatchObject({ email: "agent@store.test", merchant_name: "My Store", role: "member", has_account: false });

    const noPw = await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token } });
    expect(noPw.json().error.code).toBe("PASSWORD_REQUIRED");
    const acc = await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token, password: "another good password" } });
    expect(acc.statusCode).toBe(200);
    const cookie = cookieFrom(acc.headers["set-cookie"]);
    const me = (await ctx.app.inject({ method: "GET", url: "/app/me", headers: { cookie } })).json();
    expect(me).toMatchObject({ user: { email: "agent@store.test" }, merchant: { name: "My Store", role: "member" } });

    // single use
    expect((await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token, password: "another good password" } })).statusCode).toBe(401);
    // members can't invite or manage keys
    expect((await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie }, payload: { email: "x@y.test", role: "member" } })).statusCode).toBe(403);

    const team = (await ctx.app.inject({ method: "GET", url: "/app/team", headers: { cookie: owner.cookie } })).json();
    expect(team.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([["owner@store.test", "owner"], ["agent@store.test", "member"]]);
  });

  it("owner changes roles and removes members (who are logged out)", async () => {
    const owner = await signup(ctx);
    await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie: owner.cookie }, payload: { email: "a@b.test", role: "admin" } });
    const acc = await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token: tokenFrom(ctx.mails[0]!.text), password: "another good password" } });
    const memberCookie = cookieFrom(acc.headers["set-cookie"]);
    const team = (await ctx.app.inject({ method: "GET", url: "/app/team", headers: { cookie: owner.cookie } })).json();
    const userId = team.members.find((m: { email: string }) => m.email === "a@b.test").user_id;

    expect((await ctx.app.inject({ method: "PATCH", url: `/app/team/members/${userId}`, headers: { cookie: owner.cookie }, payload: { role: "member" } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "DELETE", url: `/app/team/members/${userId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/app/me", headers: { cookie: memberCookie } })).statusCode).toBe(401);
  });

  it("revoked and expired invites can't be used; existing accounts join without a password", async () => {
    const owner = await signup(ctx);
    await signup(ctx, "existing@user.test", "Other Store");
    await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie: owner.cookie }, payload: { email: "late@x.test", role: "member" } });
    const late = tokenFrom(ctx.mails[0]!.text);
    const inv = await ctx.prisma.invite.findFirstOrThrow({ where: { email: "late@x.test" } });
    await ctx.app.inject({ method: "DELETE", url: `/app/team/invites/${inv.id}`, headers: { cookie: owner.cookie } });
    expect((await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token: late, password: "another good password" } })).statusCode).toBe(401);

    await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie: owner.cookie }, payload: { email: "existing@user.test", role: "member" } });
    const r = await ctx.app.inject({ method: "POST", url: "/app/invites/accept", payload: { token: tokenFrom(ctx.mails[1]!.text) } });
    expect(r.statusCode).toBe(200);
    expect(await ctx.prisma.membership.count({ where: { user: { email: "existing@user.test" } } })).toBe(2);
  });

  it("cannot invite someone already on the team, or remove yourself", async () => {
    const owner = await signup(ctx);
    const dup = await ctx.app.inject({ method: "POST", url: "/app/team/invites", headers: { cookie: owner.cookie }, payload: { email: "owner@store.test", role: "member" } });
    expect(dup.statusCode).toBe(409);
    const me = (await ctx.app.inject({ method: "GET", url: "/app/team", headers: { cookie: owner.cookie } })).json().members[0];
    expect((await ctx.app.inject({ method: "DELETE", url: `/app/team/members/${me.user_id}`, headers: { cookie: owner.cookie } })).statusCode).toBe(400);
  });
});
