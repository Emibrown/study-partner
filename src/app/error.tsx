"use client";
import { Button, EmptyState } from "@/components/ui";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <EmptyState
      title="Let's try that again"
      description="Something interrupted your study space."
    >
      <Button onClick={reset}>Try again</Button>
    </EmptyState>
  );
}
