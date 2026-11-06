import { LoginForm } from "@/components/login-form";
import { authConfig, githubConfigured } from "@/lib/auth-server";

const LOGIN_ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  state: "That sign-in link had expired or did not match. Please try again.",
  not_allowed: "This GitHub account is not on the list for this Murphy.",
  github: "GitHub did not complete the sign-in. Please try again.",
  server: "Sign-in failed on our side. Is the API running?",
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ login_error?: string }>;
}) {
  const { login_error: code } = await searchParams;
  return (
    <main className="container login">
      <div className="login__pitch">
        <p className="login__mark">Murphy</p>
        <h1 className="login__head">Anything that can go wrong will.</h1>
        <p className="login__line">
          So break your webhooks here, before production does it for you.
        </p>
      </div>
      <LoginForm
        github={githubConfigured(authConfig())}
        error={code ? (LOGIN_ERRORS[code] ?? LOGIN_ERRORS.github!) : null}
      />
    </main>
  );
}
