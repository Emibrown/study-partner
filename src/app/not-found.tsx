import { ButtonLink, EmptyState } from "@/components/ui";
export default function NotFound() {
  return (
    <EmptyState
      title="This page took a different path"
      description="Head back to your study space and start from there."
    >
      <ButtonLink href="/">Back to overview</ButtonLink>
    </EmptyState>
  );
}
