import { Badge as ArcBadge, type BadgeProps } from "../arc/badge/badge";
export function Badge({
  variant = "default",
  ...props
}: BadgeProps & {
  variant?: "default" | "secondary" | "outline" | "destructive";
}) {
  return (
    <ArcBadge
      data-slot="badge"
      tone={variant === "destructive" ? "danger" : "neutral"}
      {...props}
    />
  );
}
