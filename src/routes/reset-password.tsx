import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [
    { title: "Reset password — StockSense" },
    { name: "description", content: "Securely set a new password for your StockSense account." },
    { property: "og:title", content: "Reset password — StockSense" },
    { property: "og:description", content: "Secure account recovery for StockSense." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ResetPassword,
});

function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [valid, setValid] = useState(false);
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const recovery = params.get("type") === "recovery";
    setValid(recovery);
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setValid(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8 || password !== confirm) return setMessage("Use at least 8 characters and make both passwords match.");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setMessage(error.message);
    else { setMessage("Password updated. Taking you to your workspace…"); setTimeout(() => navigate({ to: "/" }), 1200); }
  }
  return <main className="auth-grid grid min-h-screen place-items-center p-4"><div className="panel w-full max-w-md p-7"><h1 className="text-xl font-semibold">Set a new password</h1><p className="mt-2 text-sm text-muted-foreground">{valid ? "Choose a new password for your account." : "Open the recovery link from your email to continue."}</p>{valid && <form className="mt-6 space-y-4" onSubmit={submit}><label className="grid gap-2 text-xs font-medium">New password<input className="field" type="password" minLength={8} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} required /></label><label className="grid gap-2 text-xs font-medium">Confirm password<input className="field" type="password" minLength={8} maxLength={72} value={confirm} onChange={e => setConfirm(e.target.value)} required /></label>{message && <p className="text-sm text-warning">{message}</p>}<Button className="w-full">Update password</Button></form>}</div></main>;
}