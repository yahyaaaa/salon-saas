import { Button } from "@/components/ui";

export function SignOutButton() {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="secondary" size="sm" className="w-full">
        Sign out
      </Button>
    </form>
  );
}
