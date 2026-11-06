import { LoginForm } from "@/components/login-form";

export default function Login() {
  return (
    <main className="container login">
      <div className="login__pitch">
        <p className="login__mark">Murphy</p>
        <h1 className="login__head">Anything that can go wrong will.</h1>
        <p className="login__line">
          So break your webhooks here, before production does it for you.
        </p>
      </div>
      <LoginForm />
    </main>
  );
}
