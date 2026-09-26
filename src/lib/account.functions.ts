import { createServerFn } from "@tanstack/react-start";

/**
 * Self-registration.
 *
 * Supabase will not issue a session for an unconfirmed address, and this project keeps email
 * confirmation switched on, so the ordinary signUp call left people stranded on "check your email".
 * This creates the account server-side with the address already marked confirmed, so registration
 * completes in one step without weakening the project-wide setting.
 *
 * That is safe here because a new account is not a member of any workspace, and every table's
 * row-level security is gated on membership — a fresh account can read exactly nothing. Access is
 * granted deliberately by a manager on the Team screen. Membership is the real gate; email
 * verification never was.
 *
 * Deliberately has no auth middleware: registration is public by definition. The service-role key
 * stays on the server, reached through a dynamic import so it is never traced into the client
 * bundle.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,29}$/i;
const USERNAME_DOMAIN = "stocksense.local";

export const registerAccount = createServerFn({ method: "POST" })
  .validator((data: { identifier: string; password: string; displayName: string }) => {
    const identifier = (data.identifier ?? "").trim().toLowerCase();
    const password = data.password ?? "";
    const displayName = (data.displayName ?? "").trim().slice(0, 100);

    const email = EMAIL.test(identifier)
      ? identifier
      : USERNAME.test(identifier)
        ? `${identifier}@${USERNAME_DOMAIN}`
        : null;
    if (!email)
      throw new Error(
        "Enter an email address, or a username of 2–30 characters using letters, numbers, dot, dash, or underscore.",
      );
    if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
    if (password.length > 72) throw new Error("Passwords cannot be longer than 72 characters.");

    return { email, password, displayName: displayName || identifier };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.displayName },
    });

    if (error) {
      const message = error.message ?? "";
      if (/already/i.test(message) || /exists/i.test(message)) {
        throw new Error("An account with that email already exists. Sign in instead.");
      }
      throw new Error(`Could not create the account: ${message}`);
    }

    return { email: data.email };
  });
