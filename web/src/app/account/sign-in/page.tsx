import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { SignInForm } from "@/components/SignInForm";
import { getCurrentUser, safeNextPath } from "@/server/session";

export const metadata: Metadata = { title: "Sign In", robots: { index: false } };

export default function SignInPage(props: PageProps<"/account/sign-in">) {
  return (
    <section className="section section-cream">
      <Suspense
        fallback={
          <div className="confirmation-card">
            <div className="spinner" />
          </div>
        }
      >
        <SignIn searchParams={props.searchParams} />
      </Suspense>
    </section>
  );
}

async function SignIn({ searchParams }: Pick<PageProps<"/account/sign-in">, "searchParams">) {
  await connection();
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);
  return <SignInForm next={next} devHint={process.env.NODE_ENV !== "production"} />;
}
