import { Suspense } from "react";
import { SignIn } from "./sign-in";
type Query = Promise<Record<string, string | string[] | undefined>>;
async function SignInForm({ searchParams }: { searchParams: Query }) {
  const query = await searchParams;
  return (
    <SignIn
      redirectTo={typeof query.redirectTo === "string" ? query.redirectTo : "/"}
      oauth={typeof query.sig === "string"}
    />
  );
}
export default function Page(props: { searchParams: Query }) {
  return (
    <Suspense fallback={<p>Loading sign-in…</p>}>
      <SignInForm {...props} />
    </Suspense>
  );
}
