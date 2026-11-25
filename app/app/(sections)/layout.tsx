import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appName, getIdentity } from "../data/auth";
import { definition } from "../data/canvas";
import { SignOut } from "../auth/sign-out";
async function SignedIn({ children }: { children: ReactNode }) {
  try {
    const requestHeaders = await headers();
    await getIdentity().session(requestHeaders);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 401)
      redirect("/auth/sign-in");
    throw error;
  }
  return children;
}
export default function SectionsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <Link href="/">
          <strong>{appName}</strong>
        </Link>
        <nav aria-label="Main">
          <Link href="/">Tables</Link>
          {definition.models.map((model) => (
            <Link key={model.id} href={`/tables/${model.id}`}>
              {model.name}
            </Link>
          ))}
          <Link href="/overview">Overview</Link>
        </nav>
        <SignOut />
      </header>
      <Suspense fallback={<main className="page">Loading your workspace…</main>}>
        <SignedIn>{children}</SignedIn>
      </Suspense>
    </>
  );
}
